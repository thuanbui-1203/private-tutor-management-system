import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { applicationDefault, getApps, initializeApp, type App } from 'firebase-admin/app';
import { getDatabase, type Database } from 'firebase-admin/database';

/**
 * Where file contents live (docs/07 §5). Business code knows only this port. Every file records
 * the `location` it was written to and is always read from there, so a new backend (another
 * database instance, S3, R2...) takes new files without moving or rewriting old ones.
 */
export interface FileStorage {
  /** Where this storage writes, e.g. `rtdb:default`. */
  readonly location: string;
  /** Stores the content; returns how many parts it used. */
  put(fileId: string, data: Buffer): Promise<number>;
  get(fileId: string, parts: number): Promise<Buffer>;
  delete(fileId: string): Promise<void>;
  close?(): void;
}

export const FILE_STORAGES = Symbol('FILE_STORAGES');

/** 512 KB per part: well under the 10 MB string and 16 MB write limits. */
export const PART_BYTES = 512 * 1024;
export const KEY_VERSION = 'v1';

/** AES-256-GCM with FILE_DATA_KEY, the file id as authenticated data: a part moved to another file fails. */
export class FileCipher {
  private constructor(private readonly key: Buffer) {}

  static fromEnv(value = process.env.FILE_DATA_KEY): FileCipher | undefined {
    const key = value ? Buffer.from(value, 'base64') : Buffer.alloc(0);
    return key.length === 32 ? new FileCipher(key) : undefined;
  }

  seal(plain: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad));
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
  }

  open(sealed: string, aad: string): Buffer {
    const [iv, tag, data] = sealed.split('.').map((p) => Buffer.from(p, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
  }
}

/**
 * Firebase Realtime Database as file storage. Only this service reaches it (Admin SDK); the
 * database rules deny every client. Paths are sharded by the first byte of the id so no single
 * node grows without bound: `/blobs/<shard>/<fileId>/<n>`.
 */
export class RtdbFileStorage implements FileStorage {
  readonly location: string;

  constructor(
    private readonly db: Database,
    private readonly cipher: FileCipher,
    instance = 'default',
  ) {
    this.location = `rtdb:${instance}`;
  }

  /** From env: FIREBASE_DATABASE_URL (+ FIREBASE_DATABASE_EMULATOR_HOST locally). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): RtdbFileStorage | undefined {
    const cipher = FileCipher.fromEnv(env.FILE_DATA_KEY);
    const databaseURL = env.FIREBASE_DATABASE_URL;
    if (!cipher || !databaseURL) return undefined;
    const name = 'tutor-files';
    const app: App =
      getApps().find((a) => a.name === name) ??
      initializeApp(
        env.FIREBASE_DATABASE_EMULATOR_HOST
          ? { projectId: env.FIREBASE_PROJECT_ID, databaseURL }
          : { projectId: env.FIREBASE_PROJECT_ID, databaseURL, credential: applicationDefault() },
        name,
      );
    return new RtdbFileStorage(getDatabase(app), cipher);
  }

  private path(fileId: string) {
    return `blobs/${fileId.slice(0, 2)}/${fileId}`;
  }

  async put(fileId: string, data: Buffer): Promise<number> {
    const parts: Record<string, string> = {};
    let n = 0;
    for (let at = 0; at < data.length; at += PART_BYTES, n++) {
      parts[String(n)] = this.cipher.seal(data.subarray(at, at + PART_BYTES), `${fileId}:${n}`);
    }
    await this.db.ref(this.path(fileId)).set(parts);
    return n;
  }

  async get(fileId: string, parts: number): Promise<Buffer> {
    const value = (await this.db.ref(this.path(fileId)).get()).val() as Record<
      string,
      string
    > | null;
    if (!value) throw new Error(`file ${fileId} has no content`);
    const out: Buffer[] = [];
    for (let n = 0; n < parts; n++) {
      if (!value[String(n)]) throw new Error(`file ${fileId} is missing part ${n}`);
      out.push(this.cipher.open(value[String(n)], `${fileId}:${n}`));
    }
    return Buffer.concat(out);
  }

  async delete(fileId: string): Promise<void> {
    await this.db.ref(this.path(fileId)).remove();
  }

  /** Closes the connection, so the process can exit. */
  close(): void {
    this.db.goOffline();
  }
}

export const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** What the bytes are, from their first bytes: never trust the name or the declared type. */
export function sniff(data: Buffer): 'application/pdf' | 'image/png' | 'image/jpeg' | undefined {
  if (data.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  return undefined;
}
