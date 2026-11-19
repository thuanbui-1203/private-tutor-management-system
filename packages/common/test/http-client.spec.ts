import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import {
  CircuitBreaker,
  CircuitOpenError,
  HttpError,
  InternalHttpClient,
  runWithCorrelationId,
  ServiceUnavailableError,
} from '../src';

type Responder = (req: IncomingMessage, res: ServerResponse) => void;

describe('InternalHttpClient', () => {
  let server: Server;
  let base: string;
  let respond: Responder;
  let hits: IncomingMessage[];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits.push(req);
      respond(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  beforeEach(() => {
    hits = [];
  });

  const json =
    (status: number, body: unknown): Responder =>
    (_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
  const Body = z.object({ id: z.string() });
  const client = (opts = {}) => new InternalHttpClient(base, { timeoutMs: 200, ...opts });

  it('returns the validated body', async () => {
    respond = json(200, { id: 'a', extra: 1 });
    await expect(client().get('/x', Body)).resolves.toEqual({ id: 'a' });
  });

  it('does not retry a 4xx and surfaces it as HttpError', async () => {
    respond = json(404, { message: 'not found' });
    const err = await client()
      .get('/x', Body)
      .catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(404);
    expect(hits).toHaveLength(1);
  });

  it('retries 5xx twice (3 attempts in total) and then succeeds', async () => {
    let n = 0;
    respond = (req, res) => (++n < 3 ? json(503, {})(req, res) : json(200, { id: 'ok' })(req, res));
    await expect(client().get('/x', Body)).resolves.toEqual({ id: 'ok' });
    expect(hits).toHaveLength(3);
  });

  it('gives up after a timeout on every attempt', async () => {
    respond = () => undefined; // never answers
    await expect(client({ timeoutMs: 50 }).get('/x', Body)).rejects.toBeInstanceOf(
      ServiceUnavailableError,
    );
    expect(hits).toHaveLength(3);
  });

  it('opens the circuit after repeated failures and stops calling the service', async () => {
    respond = json(500, {});
    const c = client({ retries: 0, breaker: { failureThreshold: 2, resetAfterMs: 60_000 } });
    await expect(c.get('/x', Body)).rejects.toBeInstanceOf(ServiceUnavailableError);
    await expect(c.get('/x', Body)).rejects.toBeInstanceOf(ServiceUnavailableError);
    expect(c.circuitState).toBe('OPEN');
    hits = [];
    await expect(c.get('/x', Body)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(hits).toHaveLength(0);
  });

  it('does not count a schema mismatch as an outage, and does not retry it', async () => {
    respond = json(200, { unexpected: true });
    await expect(client().get('/x', Body)).rejects.toThrow();
    expect(hits).toHaveLength(1);
  });

  it('forwards the current correlation id', async () => {
    respond = json(200, { id: 'a' });
    const id = '00000000-0000-4000-8000-0000000000aa';
    await runWithCorrelationId(id, () => client().get('/x', Body));
    expect(hits[0].headers['x-correlation-id']).toBe(id);
  });
});

describe('CircuitBreaker', () => {
  it('goes OPEN → HALF_OPEN after the pause and closes on a successful trial', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetAfterMs: 1000 }, () => now);
    await expect(
      breaker.run(() => Promise.reject(new ServiceUnavailableError('down'))),
    ).rejects.toThrow();
    expect(breaker.state).toBe('OPEN');
    now = 1000;
    expect(breaker.state).toBe('HALF_OPEN');
    await expect(breaker.run(() => Promise.resolve('up'))).resolves.toBe('up');
    expect(breaker.state).toBe('CLOSED');
  });

  it('re-opens immediately when the half-open trial fails', async () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetAfterMs: 1000 }, () => now);
    for (let i = 0; i < 3; i++) {
      await breaker
        .run(() => Promise.reject(new ServiceUnavailableError('down')))
        .catch(() => undefined);
    }
    now = 1000;
    await breaker
      .run(() => Promise.reject(new ServiceUnavailableError('still down')))
      .catch(() => undefined);
    expect(breaker.state).toBe('OPEN');
  });
});
