import { Controller, Get, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  currentCorrelationId,
  enqueueEvent,
  JsonLogger,
  runWithCorrelationId,
  TmsCommonModule,
  type Database,
  type SqlExecutor,
} from '../src';

@Controller()
class EchoController {
  @Get('whoami')
  whoami() {
    return { correlationId: currentCorrelationId() };
  }
}

describe('TmsCommonModule', () => {
  let app: INestApplication;

  async function boot(database?: Database) {
    const moduleRef = await Test.createTestingModule({
      imports: [TmsCommonModule.forRoot({ service: 'billing', useFactory: () => ({ database }) })],
      controllers: [EchoController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  afterEach(() => app?.close());

  it('serves /health/live and /metrics without auth', async () => {
    await boot();
    const live = await request(app.getHttpServer()).get('/health/live').expect(200);
    expect(live.body).toEqual({ status: 'ok', service: 'billing' });
    const metrics = await request(app.getHttpServer()).get('/metrics').expect(200);
    expect(metrics.text).toContain('tms_events_consumed_total');
    expect(metrics.text).toContain('process_cpu_user_seconds_total');
  });

  it('reports readiness from the database check', async () => {
    const executor = { $queryRawUnsafe: jest.fn().mockResolvedValue([{ '?column?': 1 }]) };
    await boot({ executor } as unknown as Database);
    await request(app.getHttpServer())
      .get('/health/ready')
      .expect(200, { status: 'ok', service: 'billing', checks: { database: 'up' } });

    executor.$queryRawUnsafe.mockRejectedValue(new Error('connection refused'));
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });

  it('installs the auth guard on business routes', async () => {
    await boot();
    await request(app.getHttpServer()).get('/whoami').expect(401);
  });

  it('keeps a valid incoming X-Correlation-Id and generates one otherwise', async () => {
    await boot();
    const id = '00000000-0000-4000-8000-0000000000cc';
    const user = { 'x-user-id': '00000000-0000-4000-8000-000000000002', 'x-user-role': 'TUTOR' };
    const kept = await request(app.getHttpServer())
      .get('/whoami')
      .set(user)
      .set('x-correlation-id', id)
      .expect(200);
    expect(kept.body.correlationId).toBe(id);
    expect(kept.headers['x-correlation-id']).toBe(id);

    const fresh = await request(app.getHttpServer())
      .get('/whoami')
      .set(user)
      .set('x-correlation-id', 'not-a-uuid')
      .expect(200);
    expect(fresh.body.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(fresh.body.correlationId).not.toBe('not-a-uuid');
  });
});

describe('enqueueEvent', () => {
  const tx = () => ({
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn(),
  });

  it('writes the validated envelope with the current correlation id', async () => {
    const executor = tx();
    const correlationId = '00000000-0000-4000-8000-0000000000dd';
    const event = await runWithCorrelationId(correlationId, () =>
      enqueueEvent(executor as SqlExecutor, 'ClassClosed', {
        classId: '00000000-0000-4000-8000-000000000004',
      }),
    );
    expect(event.correlationId).toBe(correlationId);
    const [sql, id, type, key, payload] = executor.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('INSERT INTO outbox_events');
    expect([id, type, key]).toEqual([event.eventId, 'ClassClosed', 'class.closed']);
    expect(JSON.parse(payload)).toEqual(event);
  });

  it('refuses a payload that breaks the contract, so the caller transaction rolls back', async () => {
    const executor = tx();
    await expect(
      enqueueEvent(executor as SqlExecutor, 'ClassClosed', { classId: 'nope' }),
    ).rejects.toThrow();
    expect(executor.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('JsonLogger', () => {
  it('writes one JSON line with service and correlation id, honouring the level', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const logger = new JsonLogger('billing', 'info');
    runWithCorrelationId('00000000-0000-4000-8000-0000000000ee', () => {
      logger.log('hello', 'Ctx');
      logger.debug('hidden', 'Ctx');
    });
    const calls = [...write.mock.calls]; // mockRestore() also clears recorded calls
    write.mockRestore();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0][0]))).toMatchObject({
      level: 'info',
      service: 'billing',
      context: 'Ctx',
      correlationId: '00000000-0000-4000-8000-0000000000ee',
      msg: 'hello',
    });
  });
});
