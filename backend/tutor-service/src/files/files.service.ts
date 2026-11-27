import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnprocessableEntityException,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { StoredFile } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGES, KEY_VERSION, sha256, sniff, type FileStorage } from './file-storage';

/** docs/07 §5: 5 MB per file, and a total that keeps the free Realtime Database under 1 GB. */
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const quotaBytes = () => Number(process.env.FILE_QUOTA_BYTES || 700 * 1024 * 1024);
const STALE_UPLOAD_MS = 60 * 60_000;

export interface Upload {
  name: string;
  contentBase64: string;
}

/**
 * File metadata in PostgreSQL, content in the FileStorage of its `location`. A file is written
 * as UPLOADING, its content stored, then marked READY; a crash in between leaves an UPLOADING
 * row that the hourly job removes with whatever content it had.
 */
@Injectable()
export class FilesService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(FilesService.name);
  private timer?: NodeJS.Timeout;
  /** Where new files go: the first storage. Older ones are found by their location. */
  private readonly writer?: FileStorage;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(FILE_STORAGES) private readonly storages: FileStorage[],
  ) {
    this.writer = storages[0];
  }

  private storageOf(location: string): FileStorage {
    const storage = this.storages.find((s) => s.location === location);
    if (!storage)
      throw new ServiceUnavailableException(`file storage ${location} is not configured`);
    return storage;
  }

  /** Checks, stores and returns a READY file owned by `ownerId`. */
  async upload(ownerId: string, upload: Upload): Promise<StoredFile> {
    if (!this.writer) {
      throw new ServiceUnavailableException(
        'file storage is not configured (FIREBASE_DATABASE_URL, FILE_DATA_KEY)',
      );
    }
    const data = Buffer.from(upload.contentBase64, 'base64');
    if (data.length === 0) throw new UnprocessableEntityException('the file is empty');
    if (data.length > MAX_FILE_BYTES) {
      throw new HttpException('a file may be at most 5 MB', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    const mime = sniff(data);
    if (!mime) throw new UnprocessableEntityException('only PDF, PNG or JPEG files are accepted');

    const used = await this.prisma.storedFile.aggregate({ _sum: { size: true } });
    if ((used._sum.size ?? 0) + data.length > quotaBytes()) {
      throw new HttpException('file storage is full', HttpStatus.INSUFFICIENT_STORAGE);
    }
    const file = await this.prisma.storedFile.create({
      data: {
        ownerId,
        name: upload.name.slice(0, 200),
        mime,
        size: data.length,
        sha256: sha256(data),
        location: this.writer.location,
        chunks: 0,
        keyVersion: KEY_VERSION,
      },
    });
    const chunks = await this.writer.put(file.id, data);
    return this.prisma.storedFile.update({
      where: { id: file.id },
      data: { chunks, status: 'READY' },
    });
  }

  async content(fileId: string): Promise<{ file: StoredFile; data: Buffer }> {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file || file.status !== 'READY') throw new NotFoundException('file not found');
    const data = await this.storageOf(file.location).get(file.id, file.chunks);
    if (sha256(data) !== file.sha256) throw new Error(`file ${file.id} does not match its hash`);
    return { file, data };
  }

  /** Removes the content, then the row. Call after the row is no longer referenced. */
  async remove(fileId: string): Promise<void> {
    const file = await this.prisma.storedFile.findUnique({ where: { id: fileId } });
    if (!file) return;
    await this.storageOf(file.location).delete(file.id);
    await this.prisma.storedFile.delete({ where: { id: file.id } });
  }

  /** Uploads interrupted more than an hour ago. Safe to run any time. */
  async cleanUp(now = new Date()): Promise<number> {
    const stale = await this.prisma.storedFile.findMany({
      where: { status: 'UPLOADING', createdAt: { lt: new Date(now.getTime() - STALE_UPLOAD_MS) } },
    });
    for (const f of stale) await this.remove(f.id);
    return stale.length;
  }

  onApplicationBootstrap(): void {
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => {
      this.cleanUp().catch((err) => this.logger.error(`file clean-up: ${(err as Error).message}`));
    }, STALE_UPLOAD_MS);
  }

  onApplicationShutdown(): void {
    clearInterval(this.timer);
    for (const s of this.storages) s.close?.();
  }
}
