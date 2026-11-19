import { Controller, Get, type INestApplication } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard, CurrentUser, Public, Roles, type AuthUser } from '../src';

@Controller()
class ProbeController {
  @Get('tutor-only')
  @Roles('TUTOR', 'ADMIN')
  tutorOnly(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Get('any-role')
  anyRole(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Public()
  @Get('open')
  open() {
    return { ok: true };
  }
}

const TUTOR_ID = '00000000-0000-4000-8000-000000000002';

describe('AuthGuard (X-User-Id / X-User-Role from the gateway)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(() => app.close());

  const get = (path: string) => request(app.getHttpServer()).get(path);

  it('rejects a request without X-User-Id with 401', async () => {
    await get('/any-role').set('x-user-role', 'TUTOR').expect(401);
  });

  it('rejects a user id that is not a UUID (e.g. a Firebase uid) with 401', async () => {
    await get('/any-role').set('x-user-id', 'Xk2a9FbQ1sR7').set('x-user-role', 'TUTOR').expect(401);
  });

  it('rejects an unknown role with 401', async () => {
    await get('/any-role').set('x-user-id', TUTOR_ID).set('x-user-role', 'OWNER').expect(401);
  });

  it('rejects a role that is not allowed with 403', async () => {
    await get('/tutor-only').set('x-user-id', TUTOR_ID).set('x-user-role', 'PARENT').expect(403);
  });

  it('passes an allowed role and exposes the user to the handler', async () => {
    const res = await get('/tutor-only')
      .set('x-user-id', TUTOR_ID)
      .set('x-user-role', 'TUTOR')
      .expect(200);
    expect(res.body).toEqual({ id: TUTOR_ID, role: 'TUTOR' });
  });

  it('lets any signed-in role through a route without @Roles', async () => {
    await get('/any-role').set('x-user-id', TUTOR_ID).set('x-user-role', 'STUDENT').expect(200);
  });

  it('skips authentication on @Public routes', async () => {
    await get('/open').expect(200);
  });
});
