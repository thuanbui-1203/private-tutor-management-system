/**
 * Integration tests for #10 (Student lifecycle and Anonymisation) against a throwaway
 * database. Run: docker compose up -d postgres && pnpm --filter @tms/student-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { OPEN_INVOICES_CHECKER } from '../src/lifecycle/lifecycle';
import { LifecycleService } from '../src/lifecycle/lifecycle.service';
import { as, createTestDb, type TestDb } from './support';

const year = new Date().getFullYear();
const DAY = 86_400_000;
type Status = 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'DROPPED';

describe('Student: lifecycle and Anonymisation (#10)', () => {
  let env: TestDb;
  let app: INestApplication;
  const tutor = as('TUTOR');
  const admin = as('ADMIN');
  /** Students the fake billing-service says still have an open Invoice. */
  const withOpenInvoices = new Set<string>();

  beforeAll(async () => {
    env = await createTestDb('student_lc_it');
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPEN_INVOICES_CHECKER)
      .useValue({
        openInvoiceIds: async (id: string) => (withOpenInvoices.has(id) ? [randomUUID()] : []),
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  const http = () => request(app.getHttpServer());
  const setStatus = (id: string, status: Status, who = tutor) =>
    http().post(`/students/${id}/status`).set(who).send({ status });

  async function student(status: Status = 'ACTIVE', parents: object[] = []) {
    const { body } = await http()
      .post('/students')
      .set(tutor)
      .send({
        fullName: 'Lê Hoa',
        dob: `${year - 25}-01-01`,
        email: `hoa.${randomUUID().slice(0, 6)}@example.com`,
        invite: false,
        parents,
      })
      .expect(201);
    if (status === 'PAUSED' || status === 'DROPPED' || status === 'GRADUATED') {
      await setStatus(body.id, status).expect(200);
    }
    return body.id as string;
  }

  const statusEvents = async (id: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events
          WHERE event_type = 'StudentStatusChanged' AND payload->'data'->>'studentId' = $1 ORDER BY created_at`,
        [id],
      )
    ).rows.map((r) => r.data);

  it.each<[Status, Status]>([
    ['ACTIVE', 'PAUSED'],
    ['PAUSED', 'ACTIVE'],
    ['ACTIVE', 'GRADUATED'],
    ['ACTIVE', 'DROPPED'],
    ['PAUSED', 'DROPPED'],
    ['DROPPED', 'ACTIVE'],
  ])('allows %s → %s and publishes StudentStatusChanged', async (from, to) => {
    const id = await student(from);
    const res = await setStatus(id, to).expect(200);
    expect(res.body.status).toBe(to);
    expect((await statusEvents(id)).at(-1)).toEqual({ studentId: id, from, to });
  });

  it.each<[Status, Status]>([
    ['GRADUATED', 'ACTIVE'],
    ['GRADUATED', 'PAUSED'],
    ['GRADUATED', 'DROPPED'],
    ['DROPPED', 'PAUSED'],
    ['DROPPED', 'GRADUATED'],
    ['PAUSED', 'GRADUATED'],
    ['ACTIVE', 'ACTIVE'],
  ])('refuses %s → %s with 409 and publishes nothing', async (from, to) => {
    const id = await student(from);
    const before = (await statusEvents(id)).length;
    await setStatus(id, to).expect(409);
    expect((await statusEvents(id)).length).toBe(before);
  });

  it('only the owning Tutor or an Admin changes a status', async () => {
    const id = await student();
    await setStatus(id, 'PAUSED', as('TUTOR')).expect(404);
    await setStatus(id, 'PAUSED', as('PARENT')).expect(403);
    await setStatus(id, 'PAUSED', admin).expect(200);
  });

  it('drops a Student paused for more than 60 days, not one paused for 59 (BR-ST-02)', async () => {
    const longPaused = await student('PAUSED');
    const job = app.get(LifecycleService);
    const now = Date.now();

    expect(await job.dropLongPaused(new Date(now + 59 * DAY))).toBe(0);
    const stillPaused = await env.db.query('SELECT status FROM students WHERE id = $1', [
      longPaused,
    ]);
    expect(stillPaused.rows[0].status).toBe('PAUSED');

    expect(await job.dropLongPaused(new Date(now + 61 * DAY))).toBeGreaterThanOrEqual(1);
    const dropped = await env.db.query('SELECT status FROM students WHERE id = $1', [longPaused]);
    expect(dropped.rows[0].status).toBe('DROPPED');
    expect((await statusEvents(longPaused)).at(-1)).toEqual({
      studentId: longPaused,
      from: 'PAUSED',
      to: 'DROPPED',
    });
  });

  it('refuses to anonymise a Student who is still ACTIVE or PAUSED', async () => {
    await http()
      .delete(`/students/${await student('ACTIVE')}`)
      .set(admin)
      .expect(409);
    await http()
      .delete(`/students/${await student('PAUSED')}`)
      .set(admin)
      .expect(409);
  });

  it('refuses to anonymise while an Invoice is still open (BR-ST-08)', async () => {
    const id = await student('DROPPED');
    withOpenInvoices.add(id);
    const res = await http().delete(`/students/${id}`).set(admin).expect(409);
    expect(res.body.openInvoiceIds).toHaveLength(1);
    const row = await env.db.query('SELECT anonymised_at FROM students WHERE id = $1', [id]);
    expect(row.rows[0].anonymised_at).toBeNull();
  });

  it('anonymises a settled GRADUATED Student: personal data erased, id kept, Billing told', async () => {
    const shared = {
      fullName: 'Nguyễn Thị Lan',
      phone: '0901234567',
      email: `lan.${randomUUID().slice(0, 6)}@example.com`,
      isPrimary: true,
    };
    const id = await student('GRADUATED', [shared]);
    const sibling = await student('ACTIVE', [shared]); // same Parent record, reused
    await http().delete(`/students/${id}`).set(as('TUTOR')).expect(403);

    await http().delete(`/students/${id}`).set(admin).expect(200);
    const row = (await env.db.query('SELECT * FROM students WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ email: null, note: null, school: null, user_id: null });
    expect(row.full_name).toBe(`Học sinh ${id.slice(0, 8)}`);
    expect(row.anonymised_at).not.toBeNull();
    await http().get(`/students/${id}`).set(admin).expect(404);

    const updated = await env.db.query(
      `SELECT payload->'data' AS data FROM outbox_events
        WHERE event_type = 'StudentUpdated' AND payload->'data'->>'studentId' = $1 ORDER BY created_at DESC LIMIT 1`,
      [id],
    );
    expect(updated.rows[0].data.fullName).toBe(`Học sinh ${id.slice(0, 8)}`);
    expect(updated.rows[0].data.payerContact.email).toBe(`anonymised-${id}@example.invalid`);

    // The Parent still has another child, so their details are kept.
    const sib = await http().get(`/students/${sibling}`).set(tutor).expect(200);
    expect(sib.body.parents[0]).toMatchObject({ fullName: 'Nguyễn Thị Lan', phone: '0901234567' });
  });

  /** Change records of one entity (ADR-0005), oldest first. */
  const changeRecords = async (entityId: string) =>
    (
      await env.db.query(
        `SELECT actor_id, actor_role, correlation_id, action, changes
           FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
        [entityId],
      )
    ).rows;

  it('Change records: who changed what, never the personal values; a refused change leaves none', async () => {
    const correlationId = randomUUID();
    const { body } = await http()
      .post('/students')
      .set(tutor)
      .set('x-correlation-id', correlationId)
      .send({
        fullName: 'Phạm Thu Trang',
        dob: `${year - 25}-01-01`,
        email: `trang.${randomUUID().slice(0, 6)}@example.com`,
        school: 'THPT Chu Văn An',
        invite: false,
        parents: [],
      })
      .expect(201);
    await setStatus(body.id, 'PAUSED').expect(200);
    await setStatus(body.id, 'GRADUATED').expect(409); // PAUSED → GRADUATED is not allowed

    const records = await changeRecords(body.id);
    expect(records.map((r) => r.action)).toEqual(['student.create', 'student.change-status']);
    expect(records[0]).toMatchObject({
      actor_id: tutor['x-user-id'],
      actor_role: 'TUTOR',
      correlation_id: correlationId,
    });
    expect(records[0].changes.fullName).toEqual({ to: '[personal]' });
    expect(records[0].changes.school).toEqual({ to: '[personal]' });
    expect(JSON.stringify(records)).not.toMatch(/Trang|Chu Văn An|example\.com/);
    expect(records[1].changes).toEqual({ status: { from: 'ACTIVE', to: 'PAUSED' } });
  });
});
