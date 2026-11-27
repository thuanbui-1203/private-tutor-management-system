/**
 * Tutor profiles, credentials with files, and Admin review (docs/07 §2, §5), against a throwaway
 * database and the Realtime Database emulator:
 *   docker compose up -d postgres && pnpm emulators   # in another terminal
 *   pnpm --filter @tms/tutor-service test:int
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { configureApp } from '../src/app.setup';
import { FilesService } from '../src/files/files.service';
import { as, createTestDb, type TestDb } from './support';

const RTDB = process.env.TEST_RTDB ?? '127.0.0.1:9002';
const NS = `tutor-it-${randomUUID().slice(0, 8)}`;
const SECRET_TEXT = 'BANG-TOT-NGHIEP-BI-MAT';
const pdf = (extra = '') => Buffer.from(`%PDF-1.4\n${SECRET_TEXT}${extra}\n%%EOF\n`);
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  randomBytes(64),
]);

describe('Tutor profiles and their verification (docs/07 §2)', () => {
  let env: TestDb;
  let app: INestApplication;
  const admin = as('ADMIN');

  beforeAll(async () => {
    env = await createTestDb('tutor_it');
    process.env.FIREBASE_PROJECT_ID = 'demo-tms';
    process.env.FIREBASE_DATABASE_EMULATOR_HOST = RTDB;
    process.env.FIREBASE_DATABASE_URL = `http://${RTDB}?ns=${NS}`;
    process.env.FILE_DATA_KEY = randomBytes(32).toString('base64');
    const { AppModule } = await import('../src/app.module');
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
    await fetch(`http://${RTDB}/.json?ns=${NS}`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer owner' },
    });
  });

  const http = () => request(app.getHttpServer());
  const raw = async (path: string) =>
    (
      await fetch(`http://${RTDB}/${path}.json?ns=${NS}`, {
        headers: { authorization: 'Bearer owner' },
      })
    ).json();

  const profile = (over: object = {}) => ({
    kind: 'STUDENT',
    displayName: 'Nguyễn Văn An',
    bio: 'Sinh viên năm 3 sư phạm Toán',
    school: 'Đại học Sư phạm TP.HCM',
    schoolCountry: 'VN',
    subjects: [{ subject: 'Toán', gradeFrom: 6, gradeTo: 9, suggestedFee: 200_000 }],
    areas: [{ kind: 'LOCAL', provinceCode: 79, wardCode: 26734 }, { kind: 'ONLINE' }],
    availability: [{ weekday: 2, startTime: '18:00', endTime: '20:00' }],
    ...over,
  });
  const credential = (over: object = {}, data: Buffer<ArrayBufferLike> = pdf()) => ({
    kind: 'STUDENT_CARD',
    title: 'Thẻ sinh viên',
    issuer: 'Đại học Sư phạm TP.HCM',
    country: 'VN',
    number: 'SV-123456',
    file: { name: 'the-sinh-vien.pdf', contentBase64: data.toString('base64') },
    ...over,
  });
  /** A Tutor with a complete STUDENT profile and one student card, not yet submitted. */
  async function ready(who = as('TUTOR')) {
    await http().put('/tutors/me').set(who).send(profile()).expect(200);
    const { body } = await http()
      .post('/tutors/me/credentials')
      .set(who)
      .send(credential())
      .expect(201);
    return { who, id: who['x-user-id'], p: body };
  }
  const review = (id: string, body: object, who = admin) =>
    http().post(`/tutors/${id}/review`).set(who).send(body);
  const decideAll = (p: { credentials: { id: string }[]; subjects: { id: string }[] }) => ({
    credentials: p.credentials.map((c) => ({ id: c.id, status: 'VERIFIED' })),
    subjects: p.subjects.map((s) => ({ id: s.id, status: 'VERIFIED' })),
  });
  const outbox = async (tutorId: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS d FROM outbox_events WHERE event_type = 'TutorStatusChanged'
          AND payload->'data'->>'tutorId' = $1 ORDER BY created_at`,
        [tutorId],
      )
    ).rows.map((r) => `${r.d.from}>${r.d.to}`);

  it('opens a DRAFT profile for a Tutor; other roles have none', async () => {
    const tutor = as('TUTOR');
    const { body } = await http().get('/tutors/me').set(tutor).expect(200);
    expect(body).toMatchObject({ tutorId: tutor['x-user-id'], status: 'DRAFT', credentials: [] });
    await http().get('/tutors/me').set(as('PARENT')).expect(403);
    await http().get('/tutors/me').expect(401);
  });

  it('saves a profile; refuses bad input and a subject listed twice', async () => {
    const tutor = as('TUTOR');
    const { body } = await http().put('/tutors/me').set(tutor).send(profile()).expect(200);
    expect(body.subjects[0]).toMatchObject({ subject: 'Toán', status: 'PENDING' });
    expect(body.areas).toHaveLength(2);
    const bad = [
      { areas: [{ kind: 'ABROAD' }] },
      { availability: [{ weekday: 8, startTime: '18:00', endTime: '20:00' }] },
      { availability: [{ weekday: 2, startTime: '20:00', endTime: '18:00' }] },
      { subjects: [{ subject: 'Toán', gradeFrom: 9, gradeTo: 6 }] },
      { schoolCountry: 'Vietnam' },
      { areas: [{ kind: 'ABROAD', country: 'JP', timezone: 'Mars/Base' }] },
    ];
    for (const over of bad)
      await http().put('/tutors/me').set(tutor).send(profile(over)).expect(400);
    const twice = [
      { subject: 'Toán', gradeFrom: 6, gradeTo: 9 },
      { subject: 'toán', gradeFrom: 6, gradeTo: 9 },
    ];
    await http()
      .put('/tutors/me')
      .set(tutor)
      .send(profile({ subjects: twice }))
      .expect(422);
  });

  it('stores a credential file encrypted in the Realtime Database; only its owner and Admins get it back', async () => {
    const { who, id, p } = await ready();
    const [c] = p.credentials;
    expect(c).toMatchObject({
      status: 'PENDING',
      number: 'SV-123456',
      file: { mime: 'application/pdf' },
    });

    const { rows } = await env.db.query('SELECT * FROM stored_files WHERE owner_id = $1', [id]);
    expect(rows[0]).toMatchObject({ status: 'READY', location: 'rtdb:default', chunks: 1 });
    const stored = await raw(`blobs/${rows[0].id.slice(0, 2)}/${rows[0].id}`);
    expect(Object.keys(stored as object)).toEqual(['0']);
    expect(JSON.stringify(stored)).not.toContain(SECRET_TEXT);
    expect(Buffer.from(JSON.stringify(stored)).toString('base64')).not.toContain(
      pdf().toString('base64'),
    );

    const mine = await http()
      .get(`/tutors/me/credentials/${c.id}/file`)
      .set(who)
      .buffer()
      .expect(200);
    expect(mine.headers['content-type']).toBe('application/pdf');
    expect(mine.headers['content-disposition']).toMatch(/^attachment/);
    expect(Buffer.from(mine.body).equals(pdf())).toBe(true);
    await http().get(`/tutors/${id}/credentials/${c.id}/file`).set(admin).expect(200);
    await http().get(`/tutors/${id}/credentials/${c.id}/file`).set(as('TUTOR')).expect(403);
    await http().get(`/tutors/me/credentials/${c.id}/file`).set(as('TUTOR')).expect(404);

    // Removing the credential removes its content too.
    await http().delete(`/tutors/me/credentials/${c.id}`).set(who).expect(200);
    expect(await raw(`blobs/${rows[0].id.slice(0, 2)}/${rows[0].id}`)).toBeNull();
    expect(
      (await env.db.query('SELECT 1 FROM stored_files WHERE owner_id = $1', [id])).rows,
    ).toEqual([]);
  });

  it('splits a large file into parts and reassembles it exactly', async () => {
    const who = as('TUTOR');
    const big = Buffer.concat([pdf(), randomBytes(1_300_000)]);
    const { body } = await http()
      .post('/tutors/me/credentials')
      .set(who)
      .send(credential({}, big))
      .expect(201);
    const { rows } = await env.db.query('SELECT chunks FROM stored_files WHERE owner_id = $1', [
      who['x-user-id'],
    ]);
    expect(rows[0].chunks).toBe(3);
    const back = await http()
      .get(`/tutors/me/credentials/${body.credentials[0].id}/file`)
      .set(who)
      .buffer()
      .expect(200);
    expect(Buffer.from(back.body).equals(big)).toBe(true);
  });

  it('accepts only PDF, PNG or JPEG of at most 5 MB, within the storage quota', async () => {
    const who = as('TUTOR');
    const send = (data: Buffer<ArrayBufferLike>) =>
      http().post('/tutors/me/credentials').set(who).send(credential({}, data));
    await send(png).expect(201);
    await send(Buffer.from('<html><script>alert(1)</script>')).expect(422);
    await send(Buffer.from('MZ\x90\x00 not a pdf')).expect(422);
    await send(Buffer.concat([pdf(), Buffer.alloc(5 * 1024 * 1024)])).expect(413);
    process.env.FILE_QUOTA_BYTES = '10';
    try {
      await send(pdf()).expect(507);
    } finally {
      delete process.env.FILE_QUOTA_BYTES;
    }
    const { rows } = await env.db.query(
      'SELECT count(*)::int AS n FROM stored_files WHERE owner_id = $1',
      [who['x-user-id']],
    );
    expect(rows[0].n).toBe(1); // nothing left behind by the refused ones
  });

  it('submits only a complete profile (BR-TU-03), then locks it while it is reviewed', async () => {
    const empty = as('TUTOR');
    const { body: missing } = await http().post('/tutors/me/submit').set(empty).expect(422);
    expect(missing.missing).toEqual(expect.arrayContaining(['kind', 'subjects', 'credentials']));

    const teacher = as('TUTOR');
    await http()
      .put('/tutors/me')
      .set(teacher)
      .send(profile({ kind: 'TEACHER' }))
      .expect(200);
    await http()
      .post('/tutors/me/credentials')
      .set(teacher)
      .send(credential({ kind: 'DEGREE' }))
      .expect(201);
    const { body: t } = await http().post('/tutors/me/submit').set(teacher).expect(422);
    expect(t.missing).toEqual(['reportedToPrincipal and noOwnPupils (BR-TU-03)']);

    const student = as('TUTOR');
    await http().put('/tutors/me').set(student).send(profile()).expect(200);
    await http()
      .post('/tutors/me/credentials')
      .set(student)
      .send(credential({ kind: 'DEGREE' }))
      .expect(201);
    const { body: s } = await http().post('/tutors/me/submit').set(student).expect(422);
    expect(s.missing).toEqual(['a STUDENT_CARD credential']);

    const { who, id } = await ready();
    const { body } = await http().post('/tutors/me/submit').set(who).expect(200);
    expect(body.status).toBe('SUBMITTED');
    await http().put('/tutors/me').set(who).send(profile()).expect(409);
    await http().post('/tutors/me/credentials').set(who).send(credential()).expect(409);
    expect(await outbox(id)).toEqual(['DRAFT>SUBMITTED']);
  });

  it('Admin review: items first, a reason for bad news, evidence kept; nobody reviews themselves', async () => {
    const { who, id, p } = await ready();
    await http().post('/tutors/me/submit').set(who).expect(200);

    await review(id, { decision: 'VERIFY' }, who).expect(403); // a Tutor
    await review(id, { decision: 'VERIFY' }, as('ADMIN', id)).expect(403); // themselves
    const { body: undecided } = await review(id, { decision: 'VERIFY' }).expect(422);
    expect(undecided.undecided).toHaveLength(2);
    await review(id, { decision: 'NEEDS_CHANGES' }).expect(422); // no reason
    await review(id, {
      decision: 'VERIFY',
      credentials: [{ id: randomUUID(), status: 'VERIFIED' }],
    }).expect(422);

    const { body: back } = await review(id, {
      decision: 'NEEDS_CHANGES',
      reason: 'Ảnh thẻ bị mờ',
      credentials: [{ id: p.credentials[0].id, status: 'REJECTED', note: 'mờ' }],
    }).expect(200);
    expect(back).toMatchObject({
      status: 'NEEDS_CHANGES',
      reviews: [{ decision: 'NEEDS_CHANGES', reason: 'Ảnh thẻ bị mờ' }],
    });

    const { body: again } = await http()
      .post('/tutors/me/credentials')
      .set(who)
      .send(credential())
      .expect(201);
    await http().post('/tutors/me/submit').set(who).expect(200);
    const { body: waiting } = await http().get('/tutors?waiting=true').set(admin).expect(200);
    expect(waiting.map((r: { tutorId: string }) => r.tutorId)).toContain(id);

    const { body: ok } = await review(id, {
      decision: 'VERIFY',
      reason: null,
      ...decideAll(again),
    }).expect(200);
    expect(ok.status).toBe('VERIFIED');
    expect(ok.verifiedAt).not.toBeNull();
    expect(await outbox(id)).toEqual([
      'DRAFT>SUBMITTED',
      'SUBMITTED>NEEDS_CHANGES',
      'NEEDS_CHANGES>SUBMITTED',
      'SUBMITTED>VERIFIED',
    ]);
    await expect(env.db.query('DELETE FROM reviews WHERE tutor_id = $1', [id])).rejects.toThrow(
      /insert-only/,
    );
    await review(id, { decision: 'REJECT', reason: 'x' }).expect(409); // not from VERIFIED
  });

  it('a VERIFIED Tutor stays visible while new items wait; changing who they are needs a new review', async () => {
    const { who, id } = await ready();
    await http().post('/tutors/me/submit').set(who).expect(200);
    const { body: v } = await http().get(`/tutors/${id}`).set(admin).expect(200);
    await review(id, { decision: 'VERIFY', ...decideAll(v) }).expect(200);

    const more = profile({
      subjects: [...profile().subjects, { subject: 'Vật lý', gradeFrom: 10, gradeTo: 12 }],
    });
    const { body: added } = await http().put('/tutors/me').set(who).send(more).expect(200);
    expect(added.status).toBe('VERIFIED');
    expect(added.subjects.map((s: { status: string }) => s.status)).toEqual([
      'VERIFIED',
      'PENDING',
    ]);
    await http().post('/tutors/me/submit').set(who).expect(200);
    const { body: still } = await http().get('/tutors/me').set(who).expect(200);
    expect(still.status).toBe('VERIFIED');

    const { body: renamed } = await http()
      .put('/tutors/me')
      .set(who)
      .send({ ...more, displayName: 'Tên khác' })
      .expect(200);
    expect(renamed.status).toBe('SUBMITTED');

    await review(id, { decision: 'VERIFY', ...decideAll(renamed) }).expect(200);
    await review(id, { decision: 'SUSPEND', reason: 'Khiếu nại' }).expect(200);
    await http().put('/tutors/me').set(who).send(more).expect(409);
    const { body: back } = await review(id, { decision: 'REINSTATE' }).expect(200);
    expect(back.status).toBe('VERIFIED');
  });

  it('an expired credential no longer counts as verified (BR-TU-06)', async () => {
    const who = as('TUTOR');
    await http()
      .put('/tutors/me')
      .set(who)
      .send(profile({ kind: 'GRADUATE' }))
      .expect(200);
    const { body } = await http()
      .post('/tutors/me/credentials')
      .set(who)
      .send(credential({ kind: 'CERTIFICATE', issuedOn: '2020-01-01', expiresOn: '2022-01-01' }))
      .expect(201);
    await http().post('/tutors/me/submit').set(who).expect(200);
    const { body: r } = await review(who['x-user-id'], {
      decision: 'VERIFY',
      ...decideAll(body),
    }).expect(422);
    expect(r.message).toMatch(/valid credential/);
  });

  it('removes uploads interrupted more than an hour ago', async () => {
    const files = app.get(FilesService);
    const { rows } = await env.db.query(
      `INSERT INTO stored_files (id, owner_id, name, mime, size, sha256, location, chunks, key_version, status, created_at)
       VALUES (gen_random_uuid(), gen_random_uuid(), 'x.pdf', 'application/pdf', 10, repeat('0', 64),
               'rtdb:default', 0, 'v1', 'UPLOADING', now() - interval '2 hours') RETURNING id`,
    );
    expect(await files.cleanUp()).toBeGreaterThanOrEqual(1);
    expect(
      (await env.db.query('SELECT 1 FROM stored_files WHERE id = $1', [rows[0].id])).rows,
    ).toEqual([]);
  });
});
