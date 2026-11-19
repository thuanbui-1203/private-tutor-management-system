/**
 * Integration tests for #9 against a throwaway database built from this service's
 * migrations, with a fake identity-service:
 *   docker compose up -d postgres && pnpm --filter @tms/student-service test:int
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';
import { createEvent, InternalStudentResponse } from '@tms/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { UserLinker } from '../src/students/user-linker';

const PG = process.env.TEST_STUDENT_PG ?? 'postgresql://student:student@localhost:5432';
const year = new Date().getFullYear();
const MINOR_DOB = `${year - 12}-03-15`;
const ADULT_DOB = `${year - 25}-03-15`;
const as = (role: string, id: string = randomUUID()) => ({ 'x-user-id': id, 'x-user-role': role });

describe('Student: Student and Parent records (#9)', () => {
  const dbName = `student_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Pool;
  let db: Pool;
  let app: INestApplication;
  let identity: Server;
  let identityUp = true;
  const invitations: { email: string; role: string; invitedBy: string }[] = [];
  const tutor = as('TUTOR');
  const otherTutor = as('TUTOR');

  beforeAll(async () => {
    admin = new Pool({ connectionString: `${PG}/student_db` });
    await admin.query(`CREATE DATABASE ${dbName}`);
    db = new Pool({ connectionString: `${PG}/${dbName}` });
    const migrations = join(__dirname, '../prisma/migrations');
    for (const dir of readdirSync(migrations)
      .filter((d) => /^\d+_/.test(d))
      .sort()) {
      await db.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
    }

    identity = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (!identityUp) return void res.writeHead(503).end();
        invitations.push(JSON.parse(body));
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            invitationId: randomUUID(),
            userId: randomUUID(),
            expiresAt: '2030-01-01T00:00:00Z',
          }),
        );
      });
    });
    await new Promise<void>((r) => identity.listen(0, '127.0.0.1', r));

    process.env.DATABASE_URL = `${PG}/${dbName}`;
    process.env.IDENTITY_SERVICE_URL = `http://127.0.0.1:${(identity.address() as AddressInfo).port}`;
    delete process.env.RABBITMQ_URL;
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => identity?.close(r));
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const http = () => request(app.getHttpServer());
  const createStudent = (body: object, who = tutor) => http().post('/students').set(who).send(body);
  const minorWithParents = (parents: object[], extra: object = {}) =>
    createStudent({
      fullName: 'Trần Minh An',
      dob: MINOR_DOB,
      note: 'yếu hình học',
      parents,
      ...extra,
    });
  const parent = (isPrimary: boolean, email?: string) => ({
    fullName: isPrimary ? 'Nguyễn Thị Lan' : 'Trần Văn Bình',
    phone: isPrimary ? '0901234567' : '0912345678',
    ...(email && { email }),
    isPrimary,
  });
  /** What UserRegistered does when an invited person activates their account. */
  async function activate(role: 'PARENT' | 'STUDENT', email: string) {
    const userId = randomUUID();
    const event = createEvent(
      'UserRegistered',
      { userId, email, role },
      { correlationId: randomUUID() },
    );
    await app.get(PrismaService).$transaction((tx) => app.get(UserLinker).link(event, tx));
    return as(role, userId);
  }
  const outboxFor = async (studentId: string) =>
    (
      await db.query(
        `SELECT event_type, payload->'data' AS data FROM outbox_events
          WHERE payload->'data'->>'studentId' = $1 ORDER BY created_at`,
        [studentId],
      )
    ).rows;

  it('creates a minor with a primary Parent: Parent pays, Parent is invited, StudentCreated published', async () => {
    const lan = `lan.${randomUUID().slice(0, 6)}@example.com`;
    const res = await minorWithParents([parent(true, lan), parent(false)]).expect(201);
    expect(res.body).toMatchObject({
      payer: 'PRIMARY_PARENT',
      note: 'yếu hình học',
      tutorId: tutor['x-user-id'],
    });
    expect(res.body.invitation).toMatchObject({ status: 'sent', to: 'PARENT', email: lan });
    expect(invitations.at(-1)).toEqual({
      email: lan,
      fullName: 'Nguyễn Thị Lan',
      role: 'PARENT',
      invitedBy: tutor['x-user-id'],
    });

    const [created] = await outboxFor(res.body.id);
    expect(created.event_type).toBe('StudentCreated');
    expect(created.data.payerContact).toEqual({
      name: 'Nguyễn Thị Lan',
      phone: '0901234567',
      email: lan,
    });
  });

  it.each([
    ['a minor without any Parent', () => minorWithParents([])],
    ['a minor without a primary Parent', () => minorWithParents([parent(false)])],
    [
      'a minor paying for themselves',
      () => minorWithParents([parent(true)], { payer: 'SELF', email: 'a@b.co' }),
    ],
    ['two primary Parents', () => minorWithParents([parent(true), parent(true)])],
    [
      'a self-paying adult without email',
      () => createStudent({ fullName: 'Lê Hoa', dob: ADULT_DOB }),
    ],
  ])('rejects %s with 422', async (_case, send) => {
    await send().expect(422);
  });

  it('an adult with an email pays for themselves and is invited directly', async () => {
    const email = `hoa.${randomUUID().slice(0, 6)}@example.com`;
    const res = await createStudent({ fullName: 'Lê Hoa', dob: ADULT_DOB, email }).expect(201);
    expect(res.body.payer).toBe('SELF');
    expect(res.body.invitation).toMatchObject({ status: 'sent', to: 'STUDENT', email });
  });

  it('turning 18 does not switch the Payer', async () => {
    const res = await minorWithParents([parent(true)]).expect(201);
    const updated = await http()
      .patch(`/students/${res.body.id}`)
      .set(tutor)
      .send({ dob: ADULT_DOB })
      .expect(200);
    expect(updated.body.payer).toBe('PRIMARY_PARENT');
  });

  it('still creates the Student when Identity is down, and reports the invitation as failed', async () => {
    identityUp = false;
    try {
      const res = await minorWithParents([parent(true, 'down@example.com')]).expect(201);
      expect(res.body.invitation.status).toBe('failed');
    } finally {
      identityUp = true;
    }
  });

  it('shows each caller only what they may see (BR-ST-06, BR-ST-07)', async () => {
    const lan = `lan.${randomUUID().slice(0, 6)}@example.com`;
    const binh = `binh.${randomUUID().slice(0, 6)}@example.com`;
    const kid = `kid.${randomUUID().slice(0, 6)}@example.com`;
    const { body: s } = await minorWithParents([parent(true, lan), parent(false, binh)], {
      email: kid,
    }).expect(201);
    const primary = await activate('PARENT', lan);
    const secondary = await activate('PARENT', binh);
    const self = await activate('STUDENT', kid);

    const owner = (await http().get(`/students/${s.id}`).set(tutor).expect(200)).body;
    expect(owner).toMatchObject({ note: 'yếu hình học', payer: 'PRIMARY_PARENT' });

    const p1 = (await http().get(`/students/${s.id}`).set(primary).expect(200)).body;
    expect(p1.note).toBeUndefined();
    expect(p1.payerContact).toBeDefined();

    const p2 = (await http().get(`/students/${s.id}`).set(secondary).expect(200)).body;
    expect(p2.note).toBeUndefined();
    expect(p2.payer).toBeUndefined();
    expect(p2.payerContact).toBeUndefined();
    expect(p2.parents.every((p: { phone?: string }) => p.phone === undefined)).toBe(true);

    const me = (await http().get(`/students/${s.id}`).set(self).expect(200)).body;
    expect(me.note).toBeUndefined();
    expect(me.payer).toBeUndefined(); // a minor never sees fees

    await http().get(`/students/${s.id}`).set(otherTutor).expect(404);
    await http().get(`/students/${s.id}`).set(as('PARENT')).expect(404); // another family's Parent
    await http().get(`/students/${s.id}`).set(as('STUDENT')).expect(404);
    await http().get(`/students/${s.id}`).expect(401);
  });

  it("GET /parents/me/children lists only this Parent's children", async () => {
    const lan = `lan.${randomUUID().slice(0, 6)}@example.com`;
    const { body: a } = await minorWithParents([parent(true, lan)]).expect(201);
    const { body: b } = await minorWithParents([parent(true, lan)]).expect(201);
    await minorWithParents([parent(true, `other.${randomUUID().slice(0, 6)}@example.com`)]).expect(
      201,
    );
    expect(b.parents[0].id).toBe(a.parents[0].id); // siblings share one Parent record
    const lanUser = await activate('PARENT', lan);
    const res = await http().get('/parents/me/children').set(lanUser).expect(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual([a.id, b.id].sort());
  });

  it('a Parent entered by two Tutors sees all their children from one account', async () => {
    const mai = `mai.${randomUUID().slice(0, 6)}@example.com`;
    const { body: withTutor } = await minorWithParents([parent(true, mai)]).expect(201);
    const { body: withOther } = await createStudent(
      { fullName: 'Trần Minh Khang', dob: MINOR_DOB, parents: [parent(true, mai)] },
      otherTutor,
    ).expect(201);
    expect(withOther.parents[0].id).not.toBe(withTutor.parents[0].id); // separate records per Tutor
    const maiUser = await activate('PARENT', mai);
    const res = await http().get('/parents/me/children').set(maiUser).expect(200);
    expect(res.body.map((c: { id: string }) => c.id).sort()).toEqual(
      [withTutor.id, withOther.id].sort(),
    );
  });

  it("lists only the Tutor's own Students, with search", async () => {
    const mine = as('TUTOR');
    await createStudent(
      { fullName: 'Phạm Quang Huy', dob: ADULT_DOB, email: 'huy@example.com', invite: false },
      mine,
    ).expect(201);
    await createStudent(
      { fullName: 'Đỗ Mai', dob: ADULT_DOB, email: 'mai@example.com', invite: false },
      mine,
    ).expect(201);
    const all = await http().get('/students').set(mine).expect(200);
    expect(all.body.total).toBe(2);
    const found = await http().get('/students?q=huy').set(mine).expect(200);
    expect(found.body.items.map((s: { fullName: string }) => s.fullName)).toEqual([
      'Phạm Quang Huy',
    ]);
    await http().get('/students').set(as('PARENT')).expect(403);
  });

  it('serves the contract DTO on /internal/students/{id} for class-service', async () => {
    const { body: s } = await minorWithParents([parent(true, 'payer@example.com')]).expect(201);
    const res = await http().get(`/internal/students/${s.id}`).expect(200); // no X-User-* needed
    expect(InternalStudentResponse.parse(res.body)).toEqual({
      id: s.id,
      fullName: 'Trần Minh An',
      tutorId: tutor['x-user-id'],
      status: 'ACTIVE',
      payerContact: { name: 'Nguyễn Thị Lan', phone: '0901234567', email: 'payer@example.com' },
    });
    await http().get(`/internal/students/${randomUUID()}`).expect(404);
  });

  it("changing the primary Parent's phone publishes StudentUpdated with the new Payer contact", async () => {
    const { body: s } = await minorWithParents([parent(true)]).expect(201);
    const parentId = s.parents.find((p: { isPrimary: boolean }) => p.isPrimary).id;
    await http().patch(`/parents/${parentId}`).set(tutor).send({ phone: '0999888777' }).expect(200);
    const events = await outboxFor(s.id);
    expect(events.at(-1)).toMatchObject({ event_type: 'StudentUpdated' });
    expect(events.at(-1).data.payerContact.phone).toBe('0999888777');
    await http()
      .patch(`/parents/${parentId}`)
      .set(otherTutor)
      .send({ phone: '0'.repeat(10) })
      .expect(404);
  });

  it('switches the primary Parent and refuses to remove the primary one', async () => {
    const { body: s } = await minorWithParents([parent(true), parent(false)]).expect(201);
    const [first, second] = s.parents;
    await http().delete(`/students/${s.id}/parents/${first.id}`).set(tutor).expect(422);
    const switched = await http()
      .post(`/students/${s.id}/parents`)
      .set(tutor)
      .send({ parentId: second.id, isPrimary: true })
      .expect(201);
    expect(
      switched.body.parents
        .filter((p: { isPrimary: boolean }) => p.isPrimary)
        .map((p: { id: string }) => p.id),
    ).toEqual([second.id]);
    await http().delete(`/students/${s.id}/parents/${first.id}`).set(tutor).expect(200);
  });

  it('enforces one primary Parent in the database too', async () => {
    const { body: s } = await minorWithParents([parent(true), parent(false)]).expect(201);
    await expect(
      db.query('UPDATE student_parents SET is_primary = true WHERE student_id = $1', [s.id]),
    ).rejects.toThrow(/student_parents_one_primary_idx/);
  });
});
