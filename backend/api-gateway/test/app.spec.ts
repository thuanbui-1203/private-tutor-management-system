import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp, SERVICE_NAME } from '../src/app.setup';

describe(SERVICE_NAME, () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the OpenAPI document under /docs', async () => {
    const res = await request(app.getHttpServer()).get('/docs-json').expect(200);
    expect(res.body.info.title).toBe(SERVICE_NAME);
  });

  it('answers /health/live without authentication', async () => {
    const res = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(res.body.status).toBe('ok');
  });
});

describe(`${SERVICE_NAME} behind a proxy (TRUST_PROXY)`, () => {
  const build = async (): Promise<INestApplication> => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    return app;
  };
  const trustSetting = (app: INestApplication): unknown =>
    (app.getHttpAdapter().getInstance() as { get(key: string): unknown }).get('trust proxy');

  afterEach(() => {
    delete process.env.TRUST_PROXY;
  });

  it('trusts no proxy by default', async () => {
    const app = await build();
    expect(trustSetting(app)).toBe(false);
    await app.close();
  });

  it('passes a subnet list through to Express', async () => {
    process.env.TRUST_PROXY = 'loopback, uniquelocal';
    const app = await build();
    expect(trustSetting(app)).toBe('loopback, uniquelocal');
    await app.close();
  });

  it('reads a hop count as a number', async () => {
    process.env.TRUST_PROXY = '1';
    const app = await build();
    expect(trustSetting(app)).toBe(1);
    await app.close();
  });
});
