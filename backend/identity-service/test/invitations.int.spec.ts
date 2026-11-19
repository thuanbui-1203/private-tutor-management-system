/**
 * Integration tests for #7 (Invitations, user administration) against the Firebase
 * Auth emulator and a throwaway database. See register.int.spec.ts for how to run.
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { FirebaseAuthService } from '../src/firebase/firebase-auth.service';
import { OPEN_CLASSES_CHECKER } from '../src/users/open-classes.checker';
import {
  claimsOf,
  clearEmulatorAccounts,
  createTestEnv,
  signIn,
  signUp,
  uniqueEmail,
  type TestEnv,
} from './support';

const ADMIN = { 'x-user-id': randomUUID(), 'x-user-role': 'ADMIN' };
const TUTOR = { 'x-user-id': randomUUID(), 'x-user-role': 'TUTOR' };
const PASSWORD = 'correct-horse-9';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Identity: Invitations and user administration (#7)', () => {
  let env: TestEnv;
  let app: INestApplication;
  /** Tutors (by users.id) that the fake class-service says still own open Classes. */
  const tutorsWithOpenClasses = new Set<string>();

  beforeAll(async () => {
    env = await createTestEnv('identity_inv_it');
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OPEN_CLASSES_CHECKER)
      .useValue({
        openClassIds: async (tutorId: string) =>
          tutorsWithOpenClasses.has(tutorId) ? ['00000000-0000-4000-8000-0000000000c1'] : [],
      })
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
    await clearEmulatorAccounts();
  });

  const http = () => request(app.getHttpServer());
  const invite = (email: string, role = 'PARENT', as = TUTOR) =>
    http().post('/auth/invitations').set(as).send({ email, fullName: 'Nguyễn Thị Lan', role });
  const tokenOf = (acceptUrl: string) => acceptUrl.split('/invitations/')[1];
  const accept = (token: string, password = PASSWORD) =>
    http().post(`/auth/invitations/${token}/accept`).send({ password });

  /** A Tutor registered through #6, signed in with a token issued at least 1 s ago. */
  async function registeredTutor() {
    const email = uniqueEmail('tutor');
    const { idToken } = await signUp(email);
    const { body } = await http()
      .post('/auth/register')
      .set('authorization', `Bearer ${idToken}`)
      .expect(201);
    const { idToken: current } = await signIn(email);
    // Firebase compares token issue time to revocation time in whole seconds.
    await wait(1100);
    return { id: body.id as string, email, token: current };
  }

  it('invites a Parent, who accepts once and gets userId + role claims', async () => {
    const email = uniqueEmail('parent');
    const res = await invite(email).expect(201);
    const { invitationId, userId, expiresAt, acceptUrl } = res.body;
    const ttlDays = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(ttlDays).toBeGreaterThan(6.99);
    expect(ttlDays).toBeLessThanOrEqual(7);

    const pending = await env.db.query('SELECT role, status FROM users WHERE id = $1', [userId]);
    expect(pending.rows[0]).toEqual({ role: 'PARENT', status: 'PENDING' });
    const created = await env.db.query(
      `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = 'InvitationCreated'
        AND payload->'data'->>'invitationId' = $1`,
      [invitationId],
    );
    expect(created.rows[0].data).toMatchObject({ userId, email });
    const stored = await env.db.query('SELECT token_hash FROM invitations WHERE id = $1', [
      invitationId,
    ]);
    expect(stored.rows[0].token_hash).not.toContain(tokenOf(acceptUrl)); // only the hash is stored

    const accepted = await accept(tokenOf(acceptUrl)).expect(200);
    expect(accepted.body).toEqual({ userId, email, role: 'PARENT', status: 'ACTIVE' });

    const session = await signIn(email, PASSWORD); // the password set through the Admin SDK works
    expect(claimsOf(session.idToken)).toMatchObject({ userId, role: 'PARENT' });
    const registered = await env.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'UserRegistered'
        AND payload->'data'->>'userId' = $1`,
      [userId],
    );
    expect(registered.rows[0].n).toBe(1);

    await accept(tokenOf(acceptUrl)).expect(410); // single use
  });

  it('refuses an expired invitation and leaves the user PENDING', async () => {
    const res = await invite(uniqueEmail('late')).expect(201);
    await env.db.query(
      `UPDATE invitations SET expires_at = now() - interval '1 second' WHERE id = $1`,
      [res.body.invitationId],
    );
    await accept(tokenOf(res.body.acceptUrl)).expect(410);
    const user = await env.db.query('SELECT status FROM users WHERE id = $1', [res.body.userId]);
    expect(user.rows[0].status).toBe('PENDING');
  });

  it('re-sending revokes the previous link', async () => {
    const email = uniqueEmail('resend');
    const first = await invite(email).expect(201);
    const second = await invite(email).expect(201);
    expect(second.body.userId).toBe(first.body.userId);

    await accept(tokenOf(first.body.acceptUrl)).expect(410);
    await accept(tokenOf(second.body.acceptUrl)).expect(200);
  });

  it('validates who may invite whom', async () => {
    await accept('no-such-token').expect(404);
    await invite(uniqueEmail('x'), 'ADMIN').expect(400); // only PARENT or STUDENT
    await http()
      .post('/auth/invitations')
      .send({ email: uniqueEmail('x'), fullName: 'X', role: 'PARENT' })
      .expect(401);
    await invite(uniqueEmail('x'), 'PARENT', { ...TUTOR, 'x-user-role': 'PARENT' }).expect(403);

    const email = uniqueEmail('active');
    const res = await invite(email, 'STUDENT').expect(201);
    await accept(tokenOf(res.body.acceptUrl)).expect(200);
    await invite(email, 'STUDENT').expect(409); // already active
  });

  it('serves the same invitation flow on /internal/invitations for student-service', async () => {
    const res = await http()
      .post('/internal/invitations')
      .send({
        email: uniqueEmail('student'),
        fullName: 'Trần Minh An',
        role: 'STUDENT',
        invitedBy: TUTOR['x-user-id'],
      })
      .expect(201);
    const row = await env.db.query('SELECT invited_by FROM invitations WHERE id = $1', [
      res.body.invitationId,
    ]);
    expect(row.rows[0].invited_by).toBe(TUTOR['x-user-id']);
  });

  it("a role change revokes the user's existing ID tokens", async () => {
    const tutor = await registeredTutor();
    const firebase = app.get(FirebaseAuthService);
    await expect(firebase.verifyIdToken(tutor.token)).resolves.toBeDefined();

    const res = await http()
      .patch(`/users/${tutor.id}`)
      .set(ADMIN)
      .send({ role: 'ADMIN' })
      .expect(200);
    expect(res.body.role).toBe('ADMIN');

    await expect(firebase.verifyIdToken(tutor.token)).rejects.toMatchObject({
      code: 'auth/id-token-revoked',
    });
    const fresh = await signIn(tutor.email);
    expect(claimsOf(fresh.idToken)).toMatchObject({ role: 'ADMIN', userId: tutor.id });
  });

  it('refuses to disable a Tutor who still owns an open Class (BR-CL-08)', async () => {
    const tutor = await registeredTutor();
    tutorsWithOpenClasses.add(tutor.id);
    const res = await http()
      .patch(`/users/${tutor.id}`)
      .set(ADMIN)
      .send({ status: 'DISABLED' })
      .expect(409);
    expect(res.body.openClassIds).toHaveLength(1);
    const row = await env.db.query('SELECT status FROM users WHERE id = $1', [tutor.id]);
    expect(row.rows[0].status).toBe('ACTIVE');
  });

  it('disables a Tutor without open Classes (sign-in blocked, sessions revoked) and re-enables', async () => {
    const tutor = await registeredTutor();
    await http().patch(`/users/${tutor.id}`).set(ADMIN).send({ status: 'DISABLED' }).expect(200);

    await expect(signIn(tutor.email)).rejects.toThrow(/USER_DISABLED/);
    await expect(app.get(FirebaseAuthService).verifyIdToken(tutor.token)).rejects.toBeDefined();

    await http().patch(`/users/${tutor.id}`).set(ADMIN).send({ status: 'ACTIVE' }).expect(200);
    await expect(signIn(tutor.email)).resolves.toBeDefined();
  });

  it('only an Admin may administer users, and not their own account', async () => {
    const tutor = await registeredTutor();
    await http().get(`/users/${tutor.id}`).set(TUTOR).expect(403);
    await http().get(`/users/${tutor.id}`).set(ADMIN).expect(200);
    await http().patch(`/users/${tutor.id}`).set(TUTOR).send({ role: 'ADMIN' }).expect(403);
    await http().patch(`/users/${tutor.id}`).set(ADMIN).send({}).expect(400);
    await http()
      .patch(`/users/${ADMIN['x-user-id']}`)
      .set(ADMIN)
      .send({ status: 'DISABLED' })
      .expect(400);
  });
});
