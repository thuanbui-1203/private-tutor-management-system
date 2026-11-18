import {
  createEvent,
  EVENT_CATALOG,
  EVENT_TYPES,
  parseEvent,
  routingKeyOf,
  safeParseEvent,
  type EventType,
} from '../src';
import { ids, invalidData, validData } from './fixtures';

const meta = { correlationId: ids.correlation, occurredAt: new Date('2026-11-18T09:00:00Z') };

describe.each(EVENT_TYPES)('%s', (eventType: EventType) => {
  it('round-trips a valid payload through JSON', () => {
    const event = createEvent(eventType, validData[eventType] as never, meta);
    const received = parseEvent(JSON.parse(JSON.stringify(event)));

    expect(received).toEqual(event);
    expect(received.eventType).toBe(eventType);
    expect(received.version).toBe(1);
    expect(received.correlationId).toBe(ids.correlation);
    expect(received.occurredAt).toBe('2026-11-18T09:00:00.000Z');
  });

  it(`rejects an invalid payload: ${invalidData[eventType].reason}`, () => {
    const raw = {
      eventId: ids.user,
      eventType,
      occurredAt: '2026-11-18T09:00:00Z',
      correlationId: ids.correlation,
      version: 1,
      data: invalidData[eventType].data,
    };
    expect(() => parseEvent(raw)).toThrow();
    expect(safeParseEvent(raw).success).toBe(false);
  });
});

describe('envelope', () => {
  const valid = createEvent('ClassClosed', { classId: ids.class }, meta);

  it.each([
    ['unknown eventType', { ...valid, eventType: 'ClassDeleted' }],
    ['unsupported version', { ...valid, version: 2 }],
    ['eventId is not a UUID', { ...valid, eventId: 'evt-1' }],
    ['occurredAt has no timezone', { ...valid, occurredAt: '2026-11-18T09:00:00' }],
    ['missing correlationId', { ...valid, correlationId: undefined }],
  ])('rejects %s', (_reason, raw) => {
    expect(safeParseEvent(raw).success).toBe(false);
  });

  it('generates a UUID eventId when none is given', () => {
    expect(valid.eventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(createEvent('ClassClosed', { classId: ids.class }, meta).eventId).not.toBe(
      valid.eventId,
    );
  });

  it('refuses to create an event whose payload breaks the contract', () => {
    expect(() =>
      createEvent('StudentEnrolled', { ...validData.StudentEnrolled, status: 'ACTIVE' }, meta),
    ).toThrow(/AWAITING_PAYMENT/);
  });
});

describe('cross-field rules', () => {
  it('accepts a Per-session enrollment that starts ACTIVE', () => {
    const data = {
      ...validData.StudentEnrolled,
      feeType: 'PER_SESSION',
      status: 'ACTIVE',
    } as const;
    expect(() => createEvent('StudentEnrolled', data, meta)).not.toThrow();
  });

  it('rejects enrollmentId on a MONTHLY invoice', () => {
    const data = { ...validData.InvoiceIssued, kind: 'MONTHLY' } as const;
    expect(() => createEvent('InvoiceIssued', data, meta)).toThrow(/enrollmentId/);
  });

  it('requires enrollmentId when an Enrollment invoice is paid', () => {
    const data = { ...validData.PaymentReceived, invoiceKind: 'ENROLLMENT' } as const;
    expect(() => createEvent('PaymentReceived', data, meta)).toThrow(/enrollmentId/);
    expect(() =>
      createEvent('PaymentReceived', { ...data, enrollmentId: ids.enrollment }, meta),
    ).not.toThrow();
  });
});

describe('routing keys', () => {
  it('are unique and follow <aggregate>.<action>', () => {
    const keys = EVENT_TYPES.map(routingKeyOf);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+\.[a-z]+(-[a-z]+)*$/);
  });

  it('never route an event back to its own producer', () => {
    for (const type of EVENT_TYPES) {
      const def = EVENT_CATALOG[type];
      expect(def.consumers).not.toContain(def.producer);
    }
  });
});
