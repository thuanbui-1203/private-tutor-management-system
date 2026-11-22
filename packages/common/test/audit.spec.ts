import { Controller, Post, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  diffFields,
  maskAccountNumber,
  PERSONAL_FIELDS,
  recordChange,
  runWithCorrelationId,
  TmsCommonModule,
  type ChangeInput,
  type Database,
  type SqlExecutor,
} from '../src';

const personal = new Set(PERSONAL_FIELDS);
const TUTOR = { id: '00000000-0000-4000-8000-000000000002', role: 'TUTOR' as const };
const CORR = '00000000-0000-4000-8000-0000000000cc';

function fakeTx() {
  const tx = {
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRawUnsafe: jest.fn(),
  };
  /** The values of the last INSERT, by column. */
  const inserted = () => {
    const [
      ,
      id,
      occurredAt,
      correlationId,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      changes,
    ] = tx.$executeRawUnsafe.mock.calls.at(-1) as unknown[];
    return {
      id,
      occurredAt,
      correlationId,
      actorId,
      actorRole,
      action,
      entityType,
      entityId,
      changes: JSON.parse(changes as string),
    };
  };
  return { tx: tx as SqlExecutor & typeof tx, inserted };
}

describe('diffFields', () => {
  it('keeps only the fields that changed, ignoring updatedAt', () => {
    const before = { status: 'ACTIVE', fee: 200000, updatedAt: new Date(1) };
    const after = { status: 'PAUSED', fee: 200000, updatedAt: new Date(2) };
    expect(diffFields(before, after, personal)).toEqual({
      status: { from: 'ACTIVE', to: 'PAUSED' },
    });
  });

  it('lists every field on create and on delete', () => {
    expect(diffFields(undefined, { a: 1, b: 'x' }, personal)).toEqual({
      a: { to: 1 },
      b: { to: 'x' },
    });
    expect(diffFields({ a: 1 }, null, personal)).toEqual({ a: { from: 1 } });
  });

  it('turns Dates and Decimals into JSON values', () => {
    const decimal = { toJSON: () => '150000' };
    expect(diffFields({ at: new Date(0), amount: decimal }, undefined, personal)).toEqual({
      at: { from: '1970-01-01T00:00:00.000Z' },
      amount: { from: '150000' },
    });
  });

  it('records that personal data changed without storing it, at any depth', () => {
    const changes = diffFields(
      { fullName: 'Lê Hoa', status: 'ACTIVE', payer: { email: 'a@x.vn', relation: 'MOTHER' } },
      { fullName: 'Lê Thị Hoa', status: 'ACTIVE', payer: { email: 'b@x.vn', relation: 'MOTHER' } },
      personal,
    );
    expect(changes).toEqual({
      fullName: { from: '[personal]', to: '[personal]' },
      payer: {
        from: { email: '[personal]', relation: 'MOTHER' },
        to: { email: '[personal]', relation: 'MOTHER' },
      },
    });
    expect(JSON.stringify(changes)).not.toMatch(/Hoa|a@x\.vn|b@x\.vn/);
  });

  it('masks secrets and account numbers, also inside arrays', () => {
    const changes = diffFields(
      undefined,
      {
        accountNumber: '0123456789',
        accountNumberEnc: 'v1:abc',
        tokenHash: 'deadbeef',
        items: [{ password: 'p@ss', iban: 'VN12345678' }],
      },
      personal,
    );
    expect(changes).toEqual({
      accountNumber: { to: '••••6789' },
      accountNumberEnc: { to: '[secret]' },
      tokenHash: { to: '[secret]' },
      items: { to: [{ password: '[secret]', iban: '••••5678' }] },
    });
  });

  it('masks short account numbers completely', () => {
    expect(maskAccountNumber('123')).toBe('[secret]');
    expect(maskAccountNumber(null)).toBe('[secret]');
  });
});

describe('recordChange', () => {
  const input: ChangeInput = {
    action: 'student.update',
    entityType: 'Student',
    entityId: 'abc',
    before: { status: 'ACTIVE' },
    after: { status: 'PAUSED' },
  };

  it('is SYSTEM with no correlation id outside a request', async () => {
    const { tx, inserted } = fakeTx();
    await recordChange(tx, input);
    expect(inserted()).toMatchObject({
      actorId: null,
      actorRole: 'SYSTEM',
      correlationId: null,
      action: 'student.update',
      changes: { status: { from: 'ACTIVE', to: 'PAUSED' } },
    });
  });

  it('takes the correlation id of the current request or message', async () => {
    const { tx, inserted } = fakeTx();
    await runWithCorrelationId(CORR, () => recordChange(tx, { ...input, actor: TUTOR }));
    expect(inserted()).toMatchObject({
      correlationId: CORR,
      actorId: TUTOR.id,
      actorRole: 'TUTOR',
    });
  });

  it('accepts extra personal keys per entity', async () => {
    const { tx, inserted } = fakeTx();
    await recordChange(tx, {
      ...input,
      before: { name: 'A' },
      after: { name: 'B' },
      personal: ['name'],
    });
    expect(inserted().changes).toEqual({ name: { from: '[personal]', to: '[personal]' } });
  });

  it('rejects an action that is not <entity>.<verb> before writing anything', async () => {
    const { tx } = fakeTx();
    await expect(recordChange(tx, { ...input, action: 'UpdateStudent' })).rejects.toThrow();
    expect(tx.$executeRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('actor of a request (AuthGuard → recordChange)', () => {
  const { tx, inserted } = fakeTx();

  @Controller()
  class WriteController {
    @Post('students')
    async create() {
      await recordChange(tx, {
        action: 'student.create',
        entityType: 'Student',
        entityId: 'x',
        after: { status: 'ACTIVE' },
      });
      return {};
    }
  }

  let app: INestApplication;

  async function boot(service: 'billing' | 'api-gateway' | 'audit', database?: Database) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TmsCommonModule.forRoot({
          service,
          auth: service === 'billing',
          useFactory: () => ({ database }),
        }),
      ],
      controllers: [WriteController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  }

  afterEach(() => app?.close());

  it('records the user the gateway forwarded, with the request correlation id', async () => {
    await boot('billing');
    await request(app.getHttpServer())
      .post('/students')
      .set({ 'x-user-id': TUTOR.id, 'x-user-role': 'TUTOR', 'x-correlation-id': CORR })
      .expect(201);
    expect(inserted()).toMatchObject({
      actorId: TUTOR.id,
      actorRole: 'TUTOR',
      correlationId: CORR,
    });
  });

  it('serves GET /internal/audit in business services only, without auth', async () => {
    const row = {
      id: '00000000-0000-4000-8000-0000000000a1',
      occurred_at: new Date('2026-11-22T01:00:00Z'),
      correlation_id: CORR,
      actor_id: TUTOR.id,
      actor_role: 'TUTOR',
      action: 'student.update',
      entity_type: 'Student',
      entity_id: 'x',
      changes: { status: { from: 'ACTIVE', to: 'PAUSED' } },
    };
    const executor = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([row]),
      $executeRawUnsafe: jest.fn(),
    };
    await boot('billing', { executor, transaction: jest.fn() });
    const { body } = await request(app.getHttpServer())
      .get(`/internal/audit?correlationId=${CORR}&limit=5`)
      .expect(200);
    expect(body).toEqual({
      service: 'billing',
      records: [
        {
          id: row.id,
          occurredAt: '2026-11-22T01:00:00.000Z',
          service: 'billing',
          correlationId: CORR,
          actorId: TUTOR.id,
          actorRole: 'TUTOR',
          action: 'student.update',
          entityType: 'Student',
          entityId: 'x',
          changes: row.changes,
        },
      ],
    });
    expect(executor.$queryRawUnsafe.mock.calls[0].slice(1)).toEqual([
      CORR,
      null,
      null,
      null,
      null,
      5,
    ]);
    await request(app.getHttpServer()).get('/internal/audit?correlationId=nope').expect(400);
    await app.close();

    await boot('api-gateway');
    await request(app.getHttpServer()).get('/internal/audit').expect(404);
    await app.close();
    await boot('audit');
    await request(app.getHttpServer()).get('/internal/audit').expect(404);
  });
});
