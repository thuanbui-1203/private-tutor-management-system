/**
 * Integration tests for #11 (Classes and fee policy) against a throwaway database.
 * Run: docker compose up -d postgres && pnpm --filter @tms/class-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { currentPeriod, nextPeriod } from '@tms/common';
import { InternalOpenClassesResponse } from '@tms/contracts';
import { as, createTestDb, type TestDb } from './support';

describe('Class: Classes and fee policy (#11)', () => {
  let env: TestDb;
  let app: INestApplication;
  const tutor = as('TUTOR');

  beforeAll(async () => {
    env = await createTestDb('class_it');
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  const http = () => request(app.getHttpServer());
  const group = {
    name: 'Toán 9A',
    subject: 'Toán',
    type: 'GROUP',
    maxStudents: 6,
    feeType: 'PER_SESSION',
    feeAmount: 200000,
  };
  const create = (body: object = group, who = tutor) => http().post('/classes').set(who).send(body);
  const events = async (classId: string, type?: string) =>
    (
      await env.db.query(
        `SELECT event_type, payload->'data' AS data FROM outbox_events
          WHERE payload->'data'->>'classId' = $1 ${type ? 'AND event_type = $2' : ''} ORDER BY created_at`,
        type ? [classId, type] : [classId],
      )
    ).rows;
  async function enroll(classId: string, status: string) {
    await env.db.query(
      `INSERT INTO enrollments (id, class_id, student_id, student_name, status, updated_at)
       VALUES ($1, $2, $3, 'Học sinh', $4, now())`,
      [randomUUID(), classId, randomUUID(), status],
    );
  }

  it('creates a class and publishes ClassCreated effective this period', async () => {
    const res = await create().expect(201);
    expect(res.body).toMatchObject({
      tutorId: tutor['x-user-id'],
      status: 'OPEN',
      chargeAbsent: true,
    });
    const [created] = await events(res.body.id, 'ClassCreated');
    expect(created.data).toEqual({
      classId: res.body.id,
      tutorId: tutor['x-user-id'],
      feeType: 'PER_SESSION',
      feeAmount: 200000,
      chargeAbsent: true,
      effectiveFrom: currentPeriod(),
    });
  });

  it('a ONE_ON_ONE class has exactly one seat; a GROUP class needs 2–8', async () => {
    const one = await create({ ...group, type: 'ONE_ON_ONE', maxStudents: undefined }).expect(201);
    expect(one.body.maxStudents).toBe(1);
    await create({ ...group, type: 'ONE_ON_ONE' }).expect(400); // maxStudents not allowed
    await create({ ...group, maxStudents: undefined }).expect(400);
    await create({ ...group, maxStudents: 9 }).expect(400);
    await create({ ...group, feeAmount: 0 }).expect(400);
  });

  it('a Tutor sees and edits only their own classes', async () => {
    const mine = as('TUTOR');
    const other = as('TUTOR');
    const { body } = await create(group, mine).expect(201);
    await create(group, other).expect(201);

    const list = await http().get('/classes').set(mine).expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([body.id]);
    await http().get(`/classes/${body.id}`).set(other).expect(404);
    await http().patch(`/classes/${body.id}`).set(other).send({ name: 'Hijack' }).expect(404);
    await http().get(`/classes/${body.id}`).set(as('ADMIN')).expect(200);
    await http().get('/classes').set(as('PARENT')).expect(403);
  });

  it('an Admin can own a class, or create one for a Tutor (BR-AU-01)', async () => {
    const admin = as('ADMIN');
    const own = await create(group, admin).expect(201);
    expect(own.body.tutorId).toBe(admin['x-user-id']);
    const forTutor = await create({ ...group, tutorId: tutor['x-user-id'] }, admin).expect(201);
    expect(forTutor.body.tutorId).toBe(tutor['x-user-id']);
  });

  it('a fee change publishes ClassUpdated effective next period (BR-CL-04); a rename publishes nothing', async () => {
    const { body } = await create().expect(201);
    await http().patch(`/classes/${body.id}`).set(tutor).send({ name: 'Toán 9B' }).expect(200);
    expect(await events(body.id, 'ClassUpdated')).toHaveLength(0);

    const res = await http()
      .patch(`/classes/${body.id}`)
      .set(tutor)
      .send({ feeAmount: 250000, chargeAbsent: false })
      .expect(200);
    expect(res.body.feeEffectiveFrom).toBe(nextPeriod(currentPeriod()));
    const [updated] = await events(body.id, 'ClassUpdated');
    expect(updated.data).toMatchObject({
      feeAmount: 250000,
      chargeAbsent: false,
      effectiveFrom: nextPeriod(currentPeriod()),
    });
  });

  it('refuses to shrink a class below its taken seats', async () => {
    const { body } = await create({ ...group, maxStudents: 4 }).expect(201);
    for (const s of ['ACTIVE', 'AWAITING_PAYMENT', 'PENDING']) await enroll(body.id, s);
    await enroll(body.id, 'WITHDRAWN'); // does not hold a seat
    await http().patch(`/classes/${body.id}`).set(tutor).send({ maxStudents: 2 }).expect(409);
    await http().patch(`/classes/${body.id}`).set(tutor).send({ maxStudents: 3 }).expect(200);
  });

  it('closing withdraws every live enrollment, then publishes ClassClosed (BR-CL-05)', async () => {
    const { body } = await create().expect(201);
    for (const s of ['ACTIVE', 'AWAITING_PAYMENT', 'PAUSED', 'PENDING']) await enroll(body.id, s);
    await enroll(body.id, 'REJECTED');

    const students = await http().get(`/classes/${body.id}/students`).set(tutor).expect(200);
    expect(students.body).toHaveLength(4);

    await http().post(`/classes/${body.id}/close`).set(tutor).expect(200);
    const rows = await env.db.query(
      'SELECT status, withdraw_reason FROM enrollments WHERE class_id = $1',
      [body.id],
    );
    expect(rows.rows.filter((r) => r.status === 'WITHDRAWN')).toHaveLength(4);
    expect(rows.rows.filter((r) => r.withdraw_reason === 'CLASS_CLOSED')).toHaveLength(4);
    expect(rows.rows.filter((r) => r.status === 'REJECTED')).toHaveLength(1);

    const published = await events(body.id);
    expect(published.filter((e) => e.event_type === 'StudentWithdrawn')).toHaveLength(4);
    expect(published.at(-1)).toMatchObject({ event_type: 'ClassClosed' });
    expect(published.find((e) => e.event_type === 'StudentWithdrawn').data.reason).toBe(
      'CLASS_CLOSED',
    );

    await http().post(`/classes/${body.id}/close`).set(tutor).expect(409);
    await http().patch(`/classes/${body.id}`).set(tutor).send({ name: 'x' }).expect(409);
  });

  it('serves open classes per Tutor on /internal for identity-service (BR-CL-08)', async () => {
    const t = as('TUTOR');
    const { body: open } = await create(group, t).expect(201);
    const { body: closed } = await create(group, t).expect(201);
    await http().post(`/classes/${closed.id}/close`).set(t).expect(200);
    const res = await http().get(`/internal/tutors/${t['x-user-id']}/open-classes`).expect(200);
    expect(InternalOpenClassesResponse.parse(res.body)).toEqual({
      tutorId: t['x-user-id'],
      classIds: [open.id],
    });
  });
});
