# Toàn bộ code database — TMS

Xuất ngày 2026-11-22 từ repo. PostgreSQL 18 (Docker), mỗi service một database, Prisma 7.

## 1. Hạ tầng

### `infra/postgres/init.sql`

```sql
-- Runs once, on the first start of an empty data volume (docker-entrypoint-initdb.d).
-- One database and one login role per service (ADR-0003). Each role owns only its
-- own database, and CONNECT is revoked from PUBLIC, so a service cannot open
-- another service's database. Passwords are for local development only.
--
-- CREATEDB lets `prisma migrate dev` create its temporary shadow database and lets
-- integration tests create a throwaway database per run. A role still cannot
-- connect to databases it does not own.

CREATE ROLE identity LOGIN CREATEDB PASSWORD 'identity';
CREATE DATABASE identity_db OWNER identity;
REVOKE CONNECT ON DATABASE identity_db FROM PUBLIC;

CREATE ROLE student LOGIN CREATEDB PASSWORD 'student';
CREATE DATABASE student_db OWNER student;
REVOKE CONNECT ON DATABASE student_db FROM PUBLIC;

CREATE ROLE class LOGIN CREATEDB PASSWORD 'class';
CREATE DATABASE class_db OWNER class;
REVOKE CONNECT ON DATABASE class_db FROM PUBLIC;

CREATE ROLE schedule LOGIN CREATEDB PASSWORD 'schedule';
CREATE DATABASE schedule_db OWNER schedule;
REVOKE CONNECT ON DATABASE schedule_db FROM PUBLIC;

CREATE ROLE billing LOGIN CREATEDB PASSWORD 'billing';
CREATE DATABASE billing_db OWNER billing;
REVOKE CONNECT ON DATABASE billing_db FROM PUBLIC;

-- The default `postgres` database must not be a back door either.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
```

### Biến môi trường database (`.env.example`)

```text
POSTGRES_USER=tms
POSTGRES_PASSWORD=tms_secret
IDENTITY_DB_URL=postgresql://identity:identity@postgres:5432/identity_db
STUDENT_DB_URL=postgresql://student:student@postgres:5432/student_db
CLASS_DB_URL=postgresql://class:class@postgres:5432/class_db
SCHEDULE_DB_URL=postgresql://schedule:schedule@postgres:5432/schedule_db
BILLING_DB_URL=postgresql://billing:billing@postgres:5432/billing_db
```

### `docker-compose.yml`

```yaml
# Local stack (docs/03-cach-chay.md). `docker compose up -d --build`
# docker-compose.override.yml (applied automatically) switches apps to hot reload;
# use `docker compose -f docker-compose.yml up` for production-like images.
name: tms

# Variables shared by every backend app. Each app gets only these plus its own
# (port, its own DATABASE_URL, Firebase for gateway/identity): no `env_file`, so a
# container never holds another service's database credentials (ADR-0003).
# Compose still reads .env to fill in the ${...} values below.
x-common-env: &common-env
  NODE_ENV: ${NODE_ENV}
  LOG_LEVEL: ${LOG_LEVEL}
  TZ: ${TZ}
  RABBITMQ_URL: ${RABBITMQ_URL}

x-firebase-env: &firebase-env
  FIREBASE_PROJECT_ID: ${FIREBASE_PROJECT_ID}
  GOOGLE_APPLICATION_CREDENTIALS: ${GOOGLE_APPLICATION_CREDENTIALS}
  FIREBASE_AUTH_EMULATOR_HOST: ${FIREBASE_AUTH_EMULATOR_HOST:-} # empty = real project

# Every Dockerfile builds from the repo root (pnpm workspace + lockfile).
x-backend: &backend
  restart: on-failure
  networks: [tms-net]
  depends_on:
    postgres: { condition: service_healthy }
    rabbitmq: { condition: service_healthy }
  healthcheck:
    # /health/ready (from @tms/common) checks this service's database and the broker.
    test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:$${PORT}/health/ready > /dev/null || exit 1']
    interval: 10s
    timeout: 5s
    retries: 10
    start_period: 60s

# Only the gateway and identity-service hold the Firebase service account key (ADR-0004).
x-firebase-key: &firebase-key
  volumes:
    - ./infra/keys:/run/keys:ro

services:
  # ---------- Infrastructure ----------
  postgres:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      # PostgreSQL 18 keeps data in /var/lib/postgresql/18/docker: mount the parent.
      - pg-data:/var/lib/postgresql
      - ./infra/postgres/init.sql:/docker-entrypoint-initdb.d/init.sql:ro
    ports: ['5432:5432']
    healthcheck:
      # -h forces TCP: while init.sql runs, the entrypoint's temporary server listens
      # on the Unix socket only, so apps cannot start before their roles exist.
      test: ['CMD-SHELL', 'pg_isready -h 127.0.0.1 -U ${POSTGRES_USER} -d postgres']
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [tms-net]

  rabbitmq:
    image: rabbitmq:4.2-management-alpine
    hostname: rabbitmq # node name is stored in the data volume; keep it stable
    volumes:
      - rabbitmq-data:/var/lib/rabbitmq
      - ./infra/rabbitmq/rabbitmq.conf:/etc/rabbitmq/conf.d/20-tms.conf:ro
      - ./infra/rabbitmq/definitions.json:/etc/rabbitmq/definitions.json:ro
    ports: ['5672:5672', '15672:15672']
    healthcheck:
      test: ['CMD', 'rabbitmq-diagnostics', '-q', 'ping']
      interval: 10s
      timeout: 10s
      retries: 12
    networks: [tms-net]

  redis:
    image: redis:7.4-alpine
    ports: ['6379:6379']
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
      interval: 5s
      timeout: 5s
      retries: 10
    networks: [tms-net]

  mailpit:
    image: axllent/mailpit:v1.27
    ports: ['1025:1025', '8025:8025']
    networks: [tms-net]

  # ---------- Monitoring (docs/03-cach-chay.md §8) ----------
  # Prometheus scrapes /metrics of every app over tms-net; Grafana reads Prometheus.
  # Both listen on 127.0.0.1 only: Prometheus has no login, and on a VPS Grafana is
  # reached through a reverse proxy (or an SSH tunnel) unless GRAFANA_BIND says otherwise.
  prometheus:
    image: prom/prometheus:v3.5.0
    command:
      - --config.file=/etc/prometheus/prometheus.yml
      - --storage.tsdb.path=/prometheus
      - --storage.tsdb.retention.time=${PROMETHEUS_RETENTION:-15d}
      - --web.enable-lifecycle # POST /-/reload after editing prometheus.yml
    volumes:
      - ./infra/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    ports: ['127.0.0.1:9090:9090']
    restart: unless-stopped
    networks: [tms-net]

  grafana:
    image: grafana/grafana:12.3.0
    environment:
      GF_SECURITY_ADMIN_USER: ${GRAFANA_ADMIN_USER:-admin}
      GF_SECURITY_ADMIN_PASSWORD: ${GRAFANA_ADMIN_PASSWORD:-admin}
      GF_USERS_ALLOW_SIGN_UP: 'false'
      GF_AUTH_ANONYMOUS_ENABLED: 'false'
      # Public URL when served behind a reverse proxy, e.g. https://tms.example.com/grafana/
      GF_SERVER_ROOT_URL: ${GRAFANA_ROOT_URL:-http://localhost:3000/}
      GF_SERVER_SERVE_FROM_SUB_PATH: ${GRAFANA_SERVE_FROM_SUB_PATH:-false}
      GF_DASHBOARDS_DEFAULT_HOME_DASHBOARD_PATH: /var/lib/grafana/dashboards/tms-api.json
    volumes:
      - ./infra/grafana/provisioning:/etc/grafana/provisioning:ro
      - ./infra/grafana/dashboards:/var/lib/grafana/dashboards:ro
      - grafana-data:/var/lib/grafana
    ports: ['${GRAFANA_BIND:-127.0.0.1}:${GRAFANA_PORT:-3000}:3000']
    restart: unless-stopped
    depends_on: [prometheus]
    networks: [tms-net]

  # ---------- Applications ----------
  api-gateway:
    <<: [*backend, *firebase-key]
    build: { context: ., dockerfile: backend/api-gateway/Dockerfile }
    environment:
      <<: [*common-env, *firebase-env]
      PORT: '8080'
      REDIS_URL: ${REDIS_URL}
    ports: ['8080:8080']
    depends_on:
      identity-service: { condition: service_healthy }
      redis: { condition: service_healthy }

  identity-service:
    <<: [*backend, *firebase-key]
    build: { context: ., dockerfile: backend/identity-service/Dockerfile }
    environment:
      <<: [*common-env, *firebase-env]
      PORT: '3001'
      DATABASE_URL: ${IDENTITY_DB_URL}
      # BR-CL-08: ask class-service before disabling a Tutor (#11).
      CLASS_SERVICE_URL: http://class-service:3003
    ports: ['3001:3001']

  student-service:
    <<: *backend
    build: { context: ., dockerfile: backend/student-service/Dockerfile }
    environment:
      <<: *common-env
      PORT: '3002'
      DATABASE_URL: ${STUDENT_DB_URL}
      # BR-ST-08: Anonymisation asks billing for open Invoices.
      BILLING_SERVICE_URL: http://billing-service:3006
    ports: ['3002:3002']

  class-service:
    <<: *backend
    build: { context: ., dockerfile: backend/class-service/Dockerfile }
    environment: { <<: *common-env, PORT: '3003', DATABASE_URL: '${CLASS_DB_URL}' }
    ports: ['3003:3003']

  schedule-service:
    <<: *backend
    build: { context: ., dockerfile: backend/schedule-service/Dockerfile }
    environment:
      <<: *common-env
      PORT: '3004'
      DATABASE_URL: ${SCHEDULE_DB_URL}
      ATTENDANCE_EDIT_WINDOW_HOURS: ${ATTENDANCE_EDIT_WINDOW_HOURS}
    ports: ['3004:3004']

  billing-service:
    <<: *backend
    build: { context: ., dockerfile: backend/billing-service/Dockerfile }
    environment:
      <<: *common-env
      PORT: '3006'
      DATABASE_URL: ${BILLING_DB_URL}
      BILLING_INVOICE_DUE_DAY: ${BILLING_INVOICE_DUE_DAY}
      BILLING_CHARGE_ABSENT: ${BILLING_CHARGE_ABSENT}
      # VietQR: the account Parents transfer to (GET /billing/invoices/{id}/qr; 503 when empty).
      BILLING_BANK_BIN: ${BILLING_BANK_BIN:-}
      BILLING_BANK_ACCOUNT: ${BILLING_BANK_ACCOUNT:-}
      BILLING_BANK_ACCOUNT_NAME: ${BILLING_BANK_ACCOUNT_NAME:-}
    ports: ['3006:3006']

  # academic-service (:3005, MongoDB) and notification-service (:3007) are added
  # only if time allows (BR-SYS-03).

  frontend:
    build:
      context: .
      dockerfile: frontend/Dockerfile
      args:
        NEXT_PUBLIC_API_URL: '${NEXT_PUBLIC_API_URL}'
        NEXT_PUBLIC_FIREBASE_API_KEY: '${NEXT_PUBLIC_FIREBASE_API_KEY}'
        NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: '${NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN}'
        NEXT_PUBLIC_FIREBASE_PROJECT_ID: '${NEXT_PUBLIC_FIREBASE_PROJECT_ID}'
        NEXT_PUBLIC_FIREBASE_APP_ID: '${NEXT_PUBLIC_FIREBASE_APP_ID}'
    ports: ['5173:5173']
    restart: on-failure
    depends_on:
      api-gateway: { condition: service_healthy }
    healthcheck:
      test: ['CMD-SHELL', 'wget -qO- http://127.0.0.1:5173/ > /dev/null || exit 1']
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 60s
    networks: [tms-net]

networks:
  tms-net:

volumes:
  pg-data:
  rabbitmq-data:
  prometheus-data:
  grafana-data:
```

## 2. Code dùng chung (@tms/common)

### `packages/common/sql/messaging.sql`

```sql
-- Tables every service with a database needs for reliable messaging (docs/02 §1).
-- Services create them through their Prisma schema (models OutboxEvent and
-- ProcessedEvent); this file is the same DDL for tests and reference.

-- Events written in the same transaction as the business change, then published
-- by the outbox relay.
CREATE TABLE IF NOT EXISTS outbox_events (
  id           UUID PRIMARY KEY,               -- the event's eventId
  event_type   TEXT        NOT NULL,
  routing_key  TEXT        NOT NULL,
  payload      JSONB       NOT NULL,            -- the full envelope
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at TIMESTAMPTZ
);
-- Same index as the Prisma model @@index([publishedAt, createdAt]) in each service.
CREATE INDEX IF NOT EXISTS outbox_events_published_at_created_at_idx
  ON outbox_events (published_at, created_at);

-- Events this service has already handled (idempotent consumer).
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     UUID PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `packages/common/src/database.ts`

```ts
/**
 * The smallest database surface the plumbing needs, so @tms/common never imports a
 * service's generated Prisma client. A Prisma client and a Prisma interactive
 * transaction client both satisfy SqlExecutor; `prismaDatabase()` adapts one.
 * Placeholders are PostgreSQL style: $1, $2, ...
 */
export interface SqlExecutor {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

export interface Database {
  /** Runs a query outside any transaction (health checks). */
  executor: SqlExecutor;
  /** Runs `fn` in one transaction; commits when it resolves, rolls back when it throws. */
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

/** Structural type of a Prisma client: just what `prismaDatabase` uses. */
export interface PrismaLike extends SqlExecutor {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $transaction<R>(fn: (tx: any) => Promise<R>, options?: { timeout?: number }): Promise<R>;
}

/** Adapts a service's PrismaClient to the Database interface. */
export function prismaDatabase(prisma: PrismaLike): Database {
  return {
    executor: prisma,
    transaction: (fn) => prisma.$transaction((tx: SqlExecutor) => fn(tx), { timeout: 15_000 }),
  };
}
```

### `packages/common/src/outbox.ts`

```ts
import { randomUUID } from 'node:crypto';
import {
  createEvent,
  EVENTS_EXCHANGE,
  routingKeyOf,
  type EventData,
  type EventEnvelope,
  type EventType,
} from '@tms/contracts';
import { currentCorrelationId } from './correlation';
import type { Database, SqlExecutor } from './database';
import type { Logger } from './logger';
import type { RabbitConnection } from './messaging/connection';

/**
 * Write an event to the outbox inside the caller's transaction (`tx`), so it is
 * published if and only if the business change commits. The payload is validated
 * against @tms/contracts here; a bad payload throws and rolls the transaction back.
 */
export async function enqueueEvent<T extends EventType>(
  tx: SqlExecutor,
  eventType: T,
  data: EventData<T>,
  options: { correlationId?: string } = {},
): Promise<EventEnvelope<T>> {
  const event = createEvent(eventType, data, {
    correlationId: options.correlationId ?? currentCorrelationId() ?? randomUUID(),
  });
  await tx.$executeRawUnsafe(
    'INSERT INTO outbox_events (id, event_type, routing_key, payload) VALUES ($1::uuid, $2, $3, $4::jsonb)',
    event.eventId,
    event.eventType,
    routingKeyOf(eventType),
    JSON.stringify(event),
  );
  return event;
}

interface OutboxRow {
  id: string;
  routing_key: string;
  payload: EventEnvelope;
}

export interface OutboxRelayOptions {
  /** Poll interval; docs/02 §1 says 1s. */
  intervalMs?: number;
  batchSize?: number;
  /** Called with the number of events published in each successful batch (metrics). */
  onPublished?: (count: number) => void;
}

/**
 * Publishes unpublished outbox rows to `tms.events` with publisher confirms, then
 * marks them published. Delivery is at-least-once: if marking fails after the broker
 * confirmed, the rows are published again and idempotent consumers drop the copy.
 * `FOR UPDATE SKIP LOCKED` lets several instances of a service relay safely.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;

  constructor(
    private readonly db: Database,
    private readonly rabbit: RabbitConnection,
    private readonly logger: Logger,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One polling round; skipped while the previous round runs or the broker is down. */
  private async tick(): Promise<void> {
    if (this.running || !this.rabbit.isReady()) return;
    this.running = this.publishBatch()
      .then((count) => count > 0 && this.options.onPublished?.(count))
      .catch((err: Error) =>
        this.logger.error(`outbox relay failed: ${err.message}`, 'OutboxRelay'),
      )
      .finally(() => (this.running = undefined));
    await this.running;
  }

  /** Publishes up to one batch. Returns how many events were published. */
  async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT id::text AS id, routing_key, payload FROM outbox_events
          WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        this.options.batchSize ?? 100,
      );
      if (rows.length === 0) return 0;

      const channel = await this.rabbit.publishChannel();
      for (const row of rows) {
        channel.publish(
          EVENTS_EXCHANGE,
          row.routing_key,
          Buffer.from(JSON.stringify(row.payload)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: row.id,
            correlationId: row.payload.correlationId,
            type: row.payload.eventType,
          },
        );
      }
      await channel.waitForConfirms();

      const placeholders = rows.map((_, i) => `$${i + 1}::uuid`).join(', ');
      await tx.$executeRawUnsafe(
        `UPDATE outbox_events SET published_at = now() WHERE id IN (${placeholders})`,
        ...rows.map((r) => r.id),
      );
      return rows.length;
    });
  }
}
```

### `packages/common/src/messaging/consumer.ts`

```ts
import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  DEAD_LETTER_EXCHANGE,
  deadLetterQueueName,
  EVENTS_EXCHANGE,
  queueName,
  routingKeyOf,
  safeParseEvent,
  type EventEnvelope,
  type EventType,
  type ServiceName,
} from '@tms/contracts';
import { runWithCorrelationId } from '../correlation';
import type { Database, SqlExecutor } from '../database';
import type { Logger } from '../logger';
import type { RabbitConnection } from './connection';

/** docs/02 §10: up to 3 retries, 5s → 30s → 2 min, then the service's DLQ. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

const RETRY_HEADER = 'x-retry-count';

export type EventHandler<T extends EventType> = (
  event: EventEnvelope<T>,
  tx: SqlExecutor,
) => Promise<void>;

export interface ConsumerOptions {
  retryDelaysMs?: readonly number[];
  prefetch?: number;
  /** Called after each message is settled; used for metrics. */
  onSettled?: (
    eventType: string,
    outcome: 'handled' | 'duplicate' | 'retried' | 'dead-lettered',
  ) => void;
}

/**
 * Subscribes a service to events with the guarantees in docs/02 §1 and §10:
 * - the handler runs in one DB transaction together with the `processed_events`
 *   insert, so a redelivered event is skipped (idempotent consumer);
 * - the message is acked only after that transaction commits;
 * - a failure goes to `<queue>.retry.<n>` (a TTL queue that dead-letters back to the
 *   main queue); after the last retry, or for a message that breaks the contract,
 *   it goes to `tms.dlx` → `<service>.dlq` with the error in `x-error`.
 * Separate retry queues per delay avoid a long delay blocking a short one.
 */
export class EventConsumer {
  constructor(
    private readonly service: ServiceName,
    private readonly db: Database,
    private readonly rabbit: RabbitConnection,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions = {},
  ) {}

  private get delays(): readonly number[] {
    return this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  subscribe<T extends EventType>(eventType: T, handler: EventHandler<T>): Promise<void> {
    return this.rabbit.onConnect(async (model) => {
      const channel = await this.declareTopology(model, eventType);
      await channel.prefetch(this.options.prefetch ?? 10);
      await channel.consume(queueName(this.service, eventType), (msg) => {
        if (msg) void this.handle(channel, eventType, handler, msg);
      });
    });
  }

  private async declareTopology(
    model: ChannelModel,
    eventType: EventType,
  ): Promise<ConfirmChannel> {
    const channel = await model.createConfirmChannel();
    const queue = queueName(this.service, eventType);
    const dlq = deadLetterQueueName(this.service);

    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKeyOf(eventType));
    for (const [i, delay] of this.delays.entries()) {
      await channel.assertQueue(`${queue}.retry.${i + 1}`, {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue,
        },
      });
    }
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, `${this.service}.#`);
    return channel;
  }

  private async handle<T extends EventType>(
    channel: ConfirmChannel,
    eventType: T,
    handler: EventHandler<T>,
    msg: ConsumeMessage,
  ): Promise<void> {
    const queue = queueName(this.service, eventType);
    const parsed = safeParseJson(msg.content);
    const result = parsed.ok ? safeParseEvent(parsed.value) : undefined;
    if (!result?.success || result.event.eventType !== eventType) {
      const reason = !parsed.ok
        ? 'message is not JSON'
        : result && !result.success
          ? `contract violation: ${result.error.message}`
          : `unexpected eventType on ${queue}`;
      await this.deadLetter(channel, queue, eventType, msg, reason);
      return;
    }
    const event = result.event as EventEnvelope<T>;

    try {
      const handled = await runWithCorrelationId(event.correlationId, () =>
        this.db.transaction(async (tx) => {
          const inserted = await tx.$executeRawUnsafe(
            'INSERT INTO processed_events (event_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING',
            event.eventId,
          );
          if (inserted === 0) return false; // already processed: duplicate delivery
          await handler(event, tx);
          return true;
        }),
      );
      channel.ack(msg);
      this.options.onSettled?.(eventType, handled ? 'handled' : 'duplicate');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retries = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0);
      if (retries < this.delays.length) {
        await this.republish(channel, msg, `${queue}.retry.${retries + 1}`, retries + 1, error);
        this.logger.warn(
          `${eventType} ${event.eventId} failed (attempt ${retries + 1}), retrying: ${error.message}`,
          'EventConsumer',
        );
        this.options.onSettled?.(eventType, 'retried');
      } else {
        await this.deadLetter(channel, queue, eventType, msg, error.message);
      }
    }
  }

  private async republish(
    channel: ConfirmChannel,
    msg: ConsumeMessage,
    retryQueue: string,
    retryCount: number,
    error: Error,
  ): Promise<void> {
    channel.sendToQueue(retryQueue, msg.content, {
      ...msg.properties,
      persistent: true,
      headers: {
        ...msg.properties.headers,
        [RETRY_HEADER]: retryCount,
        'x-last-error': error.message,
      },
    });
    await channel.waitForConfirms();
    channel.ack(msg);
  }

  private async deadLetter(
    channel: ConfirmChannel,
    queue: string,
    eventType: EventType,
    msg: ConsumeMessage,
    reason: string,
  ): Promise<void> {
    channel.publish(DEAD_LETTER_EXCHANGE, queue, msg.content, {
      ...msg.properties,
      persistent: true,
      headers: { ...msg.properties.headers, 'x-error': reason, 'x-original-queue': queue },
    });
    await channel.waitForConfirms();
    channel.ack(msg);
    this.logger.error(`message on ${queue} dead-lettered: ${reason}`, 'EventConsumer');
    this.options.onSettled?.(eventType, 'dead-lettered');
  }
}

function safeParseJson(content: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
```

## 3. identity-service (`identity_db`)

### `backend/identity-service/prisma.config.ts`

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not env()) so `prisma generate` works without a database, e.g. in Docker builds.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

### `backend/identity-service/prisma/schema.prisma`

```prisma
// identity-service owns identity_db. No other service may connect to it.
// Models are added by the issues that own this service (see GitHub #1).

generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

/// One role per user (BR-AU-01). Mirrors the `role` custom claim on the Firebase account.
enum Role {
  ADMIN
  TUTOR
  PARENT
  STUDENT
}

/// PENDING: invited, not yet activated. DISABLED: Tutor deactivated (BR-CL-08), never deleted.
/// Lockout after failed logins is Firebase's job (ADR-0004), so there is no LOCKED state.
enum UserStatus {
  PENDING
  ACTIVE
  DISABLED
}

/// A person who can sign in. `id` is the user id used everywhere else in the system
/// (X-User-Id, events, other services' columns); `firebase_uid` never leaves Identity.
model User {
  id          String     @id @default(uuid()) @db.Uuid
  firebaseUid String     @unique @map("firebase_uid")
  email       String     @unique
  role        Role
  status      UserStatus @default(PENDING)
  createdAt   DateTime   @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt   DateTime   @updatedAt @map("updated_at") @db.Timestamptz(6)

  invitations Invitation[]

  @@map("users")
}

/// Single-use activation link for a Parent or Student, valid 7 days (BR-AU-02).
/// Only the SHA-256 of the token is stored; re-sending sets revokedAt on the old one.
model Invitation {
  id        String    @id @default(uuid()) @db.Uuid
  userId    String    @map("user_id") @db.Uuid
  user      User      @relation(fields: [userId], references: [id])
  tokenHash String    @unique @map("token_hash")
  invitedBy String    @map("invited_by") @db.Uuid
  expiresAt DateTime  @map("expires_at") @db.Timestamptz(6)
  usedAt    DateTime? @map("used_at") @db.Timestamptz(6)
  revokedAt DateTime? @map("revoked_at") @db.Timestamptz(6)
  createdAt DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([userId])
  @@map("invitations")
}

/// Outbox (docs/02 §1, @tms/common): events written in the same transaction as the
/// business change, published by the outbox relay. Same DDL as packages/common/sql/messaging.sql.
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  routingKey  String    @map("routing_key")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Events this service has already handled (idempotent consumer, @tms/common).
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@map("processed_events")
}
```

### `backend/identity-service/prisma/migrations/20261119011636_messaging/migration.sql`

```sql
-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
```

### `backend/identity-service/prisma/migrations/20261119014205_users/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'TUTOR', 'PARENT', 'STUDENT');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "firebase_uid" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_firebase_uid_key" ON "users"("firebase_uid");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");
```

### `backend/identity-service/prisma/migrations/20261119061049_invitations/migration.sql`

```sql
-- CreateTable
CREATE TABLE "invitations" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_token_hash_key" ON "invitations"("token_hash");

-- CreateIndex
CREATE INDEX "invitations_user_id_idx" ON "invitations"("user_id");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

### `backend/identity-service/prisma/migrations/migration_lock.toml`

```text
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

### `backend/identity-service/src/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

### `backend/identity-service/src/prisma/prisma.service.ts`

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** This service's database client (ADR-0003). Connects lazily on the first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

## 4. student-service (`student_db`)

### `backend/student-service/prisma.config.ts`

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not env()) so `prisma generate` works without a database, e.g. in Docker builds.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

### `backend/student-service/prisma/schema.prisma`

```prisma
// student-service owns student_db. No other service may connect to it.
// Models are added by the issues that own this service (see GitHub #1).

generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

enum StudentStatus {
  ACTIVE
  PAUSED
  GRADUATED
  DROPPED
}

/// Who receives and settles Invoices (BR-ST-05). A minor's Payer is always the primary Parent.
enum Payer {
  PRIMARY_PARENT
  SELF
}

model Student {
  id              String          @id @default(uuid()) @db.Uuid
  tutorId         String          @map("tutor_id") @db.Uuid
  /// Identity users.id, linked when the Student accepts their invitation (UserRegistered).
  userId          String?         @unique @map("user_id") @db.Uuid
  fullName        String          @map("full_name") @db.VarChar(100)
  email           String?         @db.VarChar(255)
  dob             DateTime        @db.Date
  school          String?         @db.VarChar(150)
  grade           Int?            @db.SmallInt
  /// Visible to the Tutor and Admin only (BR-ST-07).
  note            String?
  payer           Payer
  status          StudentStatus   @default(ACTIVE)
  /// When the status last changed; the 60-day PAUSED → DROPPED job reads it (BR-ST-02).
  statusChangedAt DateTime        @default(now()) @map("status_changed_at") @db.Timestamptz(6)
  anonymisedAt    DateTime?       @map("anonymised_at") @db.Timestamptz(6)
  createdAt       DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime        @updatedAt @map("updated_at") @db.Timestamptz(6)
  parents         StudentParent[]

  @@index([tutorId])
  @@index([email])
  @@index([status, statusChangedAt])
  @@map("students")
}

model Parent {
  id        String          @id @default(uuid()) @db.Uuid
  /// Identity users.id, linked when the Parent accepts their invitation (UserRegistered).
  /// Not unique: the same person can be entered by two Tutors, and one account must see
  /// all their children.
  userId    String?         @map("user_id") @db.Uuid
  fullName  String          @map("full_name") @db.VarChar(100)
  phone     String          @db.VarChar(20)
  email     String?         @db.VarChar(255)
  /// The Tutor (or Admin) who added this Parent.
  createdBy String          @map("created_by") @db.Uuid
  createdAt DateTime        @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt DateTime        @updatedAt @map("updated_at") @db.Timestamptz(6)
  students  StudentParent[]

  @@index([email])
  @@index([userId])
  @@map("parents")
}

/// A Student has any number of Parents and exactly one primary (BR-ST-06); a partial
/// unique index in the migration enforces "at most one primary" in the database.
model StudentParent {
  studentId String  @map("student_id") @db.Uuid
  parentId  String  @map("parent_id") @db.Uuid
  isPrimary Boolean @map("is_primary")
  student   Student @relation(fields: [studentId], references: [id], onDelete: Cascade)
  parent    Parent  @relation(fields: [parentId], references: [id], onDelete: Cascade)

  @@id([studentId, parentId])
  @@map("student_parents")
}

/// Outbox (docs/02 §1, @tms/common): events written in the same transaction as the
/// business change, published by the outbox relay. Same DDL as packages/common/sql/messaging.sql.
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  routingKey  String    @map("routing_key")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Events this service has already handled (idempotent consumer, @tms/common).
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@map("processed_events")
}
```

### `backend/student-service/prisma/migrations/20261119011638_messaging/migration.sql`

```sql
-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
```

### `backend/student-service/prisma/migrations/20261119081902_students/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'GRADUATED', 'DROPPED');

-- CreateEnum
CREATE TYPE "Payer" AS ENUM ('PRIMARY_PARENT', 'SELF');

-- CreateTable
CREATE TABLE "students" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" VARCHAR(100) NOT NULL,
    "email" VARCHAR(255),
    "dob" DATE NOT NULL,
    "school" VARCHAR(150),
    "grade" SMALLINT,
    "note" TEXT,
    "payer" "Payer" NOT NULL,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "anonymised_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "students_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parents" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "full_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "email" VARCHAR(255),
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "parents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "student_parents" (
    "student_id" UUID NOT NULL,
    "parent_id" UUID NOT NULL,
    "is_primary" BOOLEAN NOT NULL,

    CONSTRAINT "student_parents_pkey" PRIMARY KEY ("student_id","parent_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "students_user_id_key" ON "students"("user_id");

-- CreateIndex
CREATE INDEX "students_tutor_id_idx" ON "students"("tutor_id");

-- CreateIndex
CREATE INDEX "students_email_idx" ON "students"("email");

-- CreateIndex
CREATE UNIQUE INDEX "parents_user_id_key" ON "parents"("user_id");

-- CreateIndex
CREATE INDEX "parents_email_idx" ON "parents"("email");

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_student_id_fkey" FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "student_parents" ADD CONSTRAINT "student_parents_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "parents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one primary Parent per Student (BR-ST-06). Prisma cannot express a partial
-- unique index, so it is added here by hand.
CREATE UNIQUE INDEX "student_parents_one_primary_idx" ON "student_parents" ("student_id") WHERE "is_primary";
```

### `backend/student-service/prisma/migrations/20261119082228_parent_user_not_unique/migration.sql`

```sql
-- DropIndex
DROP INDEX "parents_user_id_key";

-- CreateIndex
CREATE INDEX "parents_user_id_idx" ON "parents"("user_id");
```

### `backend/student-service/prisma/migrations/20261119082854_student_status_changed_at/migration.sql`

```sql
-- AlterTable
ALTER TABLE "students" ADD COLUMN     "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "students_status_status_changed_at_idx" ON "students"("status", "status_changed_at");
```

### `backend/student-service/prisma/migrations/migration_lock.toml`

```text
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

### `backend/student-service/src/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

### `backend/student-service/src/prisma/prisma.service.ts`

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** This service's database client (ADR-0003). Connects lazily on the first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

## 5. class-service (`class_db`)

### `backend/class-service/prisma.config.ts`

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not env()) so `prisma generate` works without a database, e.g. in Docker builds.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

### `backend/class-service/prisma/schema.prisma`

```prisma
// class-service owns class_db. No other service may connect to it.
// Models are added by the issues that own this service (see GitHub #1).

generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

/// Outbox (docs/02 §1, @tms/common): events written in the same transaction as the
/// business change, published by the outbox relay. Same DDL as packages/common/sql/messaging.sql.
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  routingKey  String    @map("routing_key")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Events this service has already handled (idempotent consumer, @tms/common).
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@map("processed_events")
}

enum ClassType {
  ONE_ON_ONE
  GROUP
}

enum FeeType {
  PER_SESSION
  MONTHLY
}

enum ClassStatus {
  OPEN
  CLOSED
}

/// PENDING (Student Service unreachable), AWAITING_PAYMENT (Monthly-fee, BR-CL-07) and
/// ACTIVE hold a seat (BR-CL-06).
enum EnrollmentStatus {
  PENDING
  AWAITING_PAYMENT
  ACTIVE
  PAUSED
  WITHDRAWN
  REJECTED
}

enum WithdrawReason {
  REQUESTED
  UNPAID
  CLASS_CLOSED
  STUDENT_STATUS
  SYNC_FAILED
}

model Class {
  id               String       @id @default(uuid()) @db.Uuid
  /// Owner: a Tutor, or an Admin who teaches (BR-AU-01).
  tutorId          String       @map("tutor_id") @db.Uuid
  name             String       @db.VarChar(100)
  subject          String       @db.VarChar(50)
  type             ClassType
  /// 1 for ONE_ON_ONE (BR-CL-01), 2–8 for GROUP (BR-CL-02).
  maxStudents      Int          @map("max_students") @db.SmallInt
  feeType          FeeType      @map("fee_type")
  /// Whole VND.
  feeAmount        Int          @map("fee_amount")
  /// Charge unexcused absences on PER_SESSION Classes (BR-BI-08).
  chargeAbsent     Boolean      @default(true) @map("charge_absent")
  /// Billing period (YYYY-MM) from which the current fee applies (BR-CL-04).
  feeEffectiveFrom String       @map("fee_effective_from") @db.Char(7)
  status           ClassStatus  @default(OPEN)
  createdAt        DateTime     @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime     @updatedAt @map("updated_at") @db.Timestamptz(6)
  enrollments      Enrollment[]

  @@index([tutorId, status])
  @@map("classes")
}

/// A Student's membership in a Class (#12 builds the enrollment flow on this table).
model Enrollment {
  id                String           @id @default(uuid()) @db.Uuid
  classId           String           @map("class_id") @db.Uuid
  class             Class            @relation(fields: [classId], references: [id])
  studentId         String           @map("student_id") @db.Uuid
  /// Snapshot from student-service at enrollment time.
  studentName       String           @map("student_name") @db.VarChar(100)
  status            EnrollmentStatus
  /// AWAITING_PAYMENT only: 7 days after enrolling (BR-CL-07).
  paymentDeadline   DateTime?        @map("payment_deadline") @db.Timestamptz(6)
  rosterConfirmedAt DateTime?        @map("roster_confirmed_at") @db.Timestamptz(6)
  withdrawReason    WithdrawReason?  @map("withdraw_reason")
  joinedAt          DateTime         @default(now()) @map("joined_at") @db.Date
  leftAt            DateTime?        @map("left_at") @db.Date
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)

  /// BR-CL-03: one enrollment per Student per Class.
  @@unique([classId, studentId])
  @@index([studentId])
  @@index([status, paymentDeadline])
  @@map("enrollments")
}
```

### `backend/class-service/prisma/migrations/20261119011640_messaging/migration.sql`

```sql
-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
```

### `backend/class-service/prisma/migrations/20261119083636_classes/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "ClassType" AS ENUM ('ONE_ON_ONE', 'GROUP');

-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PER_SESSION', 'MONTHLY');

-- CreateEnum
CREATE TYPE "ClassStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "EnrollmentStatus" AS ENUM ('PENDING', 'AWAITING_PAYMENT', 'ACTIVE', 'PAUSED', 'WITHDRAWN', 'REJECTED');

-- CreateEnum
CREATE TYPE "WithdrawReason" AS ENUM ('REQUESTED', 'UNPAID', 'CLASS_CLOSED', 'STUDENT_STATUS', 'SYNC_FAILED');

-- CreateTable
CREATE TABLE "classes" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "subject" VARCHAR(50) NOT NULL,
    "type" "ClassType" NOT NULL,
    "max_students" SMALLINT NOT NULL,
    "fee_type" "FeeType" NOT NULL,
    "fee_amount" INTEGER NOT NULL,
    "charge_absent" BOOLEAN NOT NULL DEFAULT true,
    "fee_effective_from" CHAR(7) NOT NULL,
    "status" "ClassStatus" NOT NULL DEFAULT 'OPEN',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "classes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "enrollments" (
    "id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "student_name" VARCHAR(100) NOT NULL,
    "status" "EnrollmentStatus" NOT NULL,
    "payment_deadline" TIMESTAMPTZ(6),
    "roster_confirmed_at" TIMESTAMPTZ(6),
    "withdraw_reason" "WithdrawReason",
    "joined_at" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" DATE,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "enrollments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "classes_tutor_id_status_idx" ON "classes"("tutor_id", "status");

-- CreateIndex
CREATE INDEX "enrollments_student_id_idx" ON "enrollments"("student_id");

-- CreateIndex
CREATE INDEX "enrollments_status_payment_deadline_idx" ON "enrollments"("status", "payment_deadline");

-- CreateIndex
CREATE UNIQUE INDEX "enrollments_class_id_student_id_key" ON "enrollments"("class_id", "student_id");

-- AddForeignKey
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_class_id_fkey" FOREIGN KEY ("class_id") REFERENCES "classes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

### `backend/class-service/prisma/migrations/migration_lock.toml`

```text
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

### `backend/class-service/src/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

### `backend/class-service/src/prisma/prisma.service.ts`

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** This service's database client (ADR-0003). Connects lazily on the first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

## 6. schedule-service (`schedule_db`)

### `backend/schedule-service/prisma.config.ts`

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not env()) so `prisma generate` works without a database, e.g. in Docker builds.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

### `backend/schedule-service/prisma/schema.prisma`

```prisma
// schedule-service owns schedule_db. No other service may connect to it.
// Models are added by the issues that own this service (see GitHub #1).

generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

/// Outbox (docs/02 §1, @tms/common): events written in the same transaction as the
/// business change, published by the outbox relay. Same DDL as packages/common/sql/messaging.sql.
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  routingKey  String    @map("routing_key")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Events this service has already handled (idempotent consumer, @tms/common).
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@map("processed_events")
}

enum AttendanceStatus {
  PRESENT
  LATE
  EXCUSED
  ABSENT
}

enum SessionStatus {
  SCHEDULED
  IN_PROGRESS
  COMPLETED
  CANCELLED
  RESCHEDULED
  MISSED
}

/// Local copy of each Class (from ClassCreated / ClassUpdated / ClassClosed), so
/// scheduling never needs a synchronous call to class-service.
model ClassView {
  classId   String   @id @map("class_id") @db.Uuid
  tutorId   String   @map("tutor_id") @db.Uuid
  open      Boolean  @default(true)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("class_view")
}

/// A recurring weekly pattern; immutable (BR-SC-07): to change it, end it and create another.
model Schedule {
  id             String    @id @default(uuid()) @db.Uuid
  classId        String    @map("class_id") @db.Uuid
  tutorId        String    @map("tutor_id") @db.Uuid
  /// ISO weekday in Vietnam: 1 = Monday … 7 = Sunday.
  weekday        Int       @db.SmallInt
  /// Local Vietnam time, HH:MM.
  startTime      String    @map("start_time") @db.Char(5)
  endTime        String    @map("end_time") @db.Char(5)
  fromDate       DateTime  @map("from_date") @db.Date
  toDate         DateTime? @map("to_date") @db.Date
  /// Sessions exist up to this date; the weekly job extends it (3 months ahead).
  generatedUntil DateTime  @map("generated_until") @db.Date
  endedAt        DateTime? @map("ended_at") @db.Timestamptz(6)
  createdAt      DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  sessions       Session[]

  @@index([classId])
  @@map("schedules")
}

model Session {
  id           String        @id @default(uuid()) @db.Uuid
  scheduleId   String?       @map("schedule_id") @db.Uuid
  schedule     Schedule?     @relation(fields: [scheduleId], references: [id])
  classId      String        @map("class_id") @db.Uuid
  tutorId      String        @map("tutor_id") @db.Uuid
  /// Local Vietnam date and times (what people see) …
  date         DateTime      @db.Date
  startTime    String        @map("start_time") @db.Char(5)
  endTime      String        @map("end_time") @db.Char(5)
  /// … and the same instants in UTC (overlap checks, events; BR-SYS-02).
  startsAt     DateTime      @map("starts_at") @db.Timestamptz(6)
  endsAt       DateTime      @map("ends_at") @db.Timestamptz(6)
  status       SessionStatus @default(SCHEDULED)
  /// Makeup session: the cancelled Session it replaces (#14).
  makeupOf     String?       @map("makeup_of") @db.Uuid
  cancelReason String?       @map("cancel_reason") @db.VarChar(500)
  createdAt    DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt    DateTime      @updatedAt @map("updated_at") @db.Timestamptz(6)
  attendances  Attendance[]

  @@index([tutorId, startsAt])
  @@index([classId, startsAt])
  @@map("sessions")
}

/// Who is expected at a Class's Sessions (ACTIVE / AWAITING_PAYMENT enrollments),
/// copied from StudentEnrolled / StudentWithdrawn.
model RosterEntry {
  classId      String    @map("class_id") @db.Uuid
  studentId    String    @map("student_id") @db.Uuid
  enrollmentId String    @map("enrollment_id") @db.Uuid
  studentName  String    @map("student_name") @db.VarChar(100)
  joinedAt     DateTime  @map("joined_at") @db.Date
  leftAt       DateTime? @map("left_at") @db.Date

  @@id([classId, studentId])
  @@map("class_roster_view")
}

/// One Student's Attendance at one Session (BR-SC-02/03/08/09). Corrections overwrite it
/// in place; the history lives in the AttendanceCorrected events Billing receives.
model Attendance {
  sessionId  String           @map("session_id") @db.Uuid
  session    Session          @relation(fields: [sessionId], references: [id])
  studentId  String           @map("student_id") @db.Uuid
  status     AttendanceStatus
  note       String?          @db.VarChar(500)
  recordedBy String           @map("recorded_by") @db.Uuid
  recordedAt DateTime         @default(now()) @map("recorded_at") @db.Timestamptz(6)
  updatedAt  DateTime         @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@id([sessionId, studentId])
  @@index([studentId])
  @@map("attendances")
}
```

### `backend/schedule-service/prisma/migrations/20261119011642_messaging/migration.sql`

```sql
-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
```

### `backend/schedule-service/prisma/migrations/20261119085655_schedules/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED', 'RESCHEDULED', 'MISSED');

-- CreateTable
CREATE TABLE "class_view" (
    "class_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "open" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "class_view_pkey" PRIMARY KEY ("class_id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "from_date" DATE NOT NULL,
    "to_date" DATE,
    "generated_until" DATE NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "schedule_id" UUID,
    "class_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "starts_at" TIMESTAMPTZ(6) NOT NULL,
    "ends_at" TIMESTAMPTZ(6) NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'SCHEDULED',
    "makeup_of" UUID,
    "cancel_reason" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "class_roster_view" (
    "class_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "student_name" VARCHAR(100) NOT NULL,
    "joined_at" DATE NOT NULL,
    "left_at" DATE,

    CONSTRAINT "class_roster_view_pkey" PRIMARY KEY ("class_id","student_id")
);

-- CreateIndex
CREATE INDEX "schedules_class_id_idx" ON "schedules"("class_id");

-- CreateIndex
CREATE INDEX "sessions_tutor_id_starts_at_idx" ON "sessions"("tutor_id", "starts_at");

-- CreateIndex
CREATE INDEX "sessions_class_id_starts_at_idx" ON "sessions"("class_id", "starts_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_schedule_id_fkey" FOREIGN KEY ("schedule_id") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```

### `backend/schedule-service/prisma/migrations/20261119092239_attendance/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'EXCUSED', 'ABSENT');

-- CreateTable
CREATE TABLE "attendances" (
    "session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "note" VARCHAR(500),
    "recorded_by" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "attendances_pkey" PRIMARY KEY ("session_id","student_id")
);

-- CreateIndex
CREATE INDEX "attendances_student_id_idx" ON "attendances"("student_id");

-- AddForeignKey
ALTER TABLE "attendances" ADD CONSTRAINT "attendances_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
```

### `backend/schedule-service/prisma/migrations/migration_lock.toml`

```text
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

### `backend/schedule-service/src/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

### `backend/schedule-service/src/prisma/prisma.service.ts`

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** This service's database client (ADR-0003). Connects lazily on the first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

## 7. billing-service (`billing_db`)

### `backend/billing-service/prisma.config.ts`

```ts
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Read directly (not env()) so `prisma generate` works without a database, e.g. in Docker builds.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
```

### `backend/billing-service/prisma/schema.prisma`

```prisma
// billing-service owns billing_db. No other service may connect to it.
// Models are added by the issues that own this service (see GitHub #1).

generator client {
  provider     = "prisma-client"
  output       = "../src/generated/prisma"
  moduleFormat = "cjs"
}

datasource db {
  provider = "postgresql"
}

/// Outbox (docs/02 §1, @tms/common): events written in the same transaction as the
/// business change, published by the outbox relay. Same DDL as packages/common/sql/messaging.sql.
model OutboxEvent {
  id          String    @id @db.Uuid
  eventType   String    @map("event_type")
  routingKey  String    @map("routing_key")
  payload     Json
  createdAt   DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  publishedAt DateTime? @map("published_at") @db.Timestamptz(6)

  @@index([publishedAt, createdAt])
  @@map("outbox_events")
}

/// Events this service has already handled (idempotent consumer, @tms/common).
model ProcessedEvent {
  eventId     String   @id @map("event_id") @db.Uuid
  processedAt DateTime @default(now()) @map("processed_at") @db.Timestamptz(6)

  @@map("processed_events")
}

enum FeeType {
  PER_SESSION
  MONTHLY
}

enum StudentStatus {
  ACTIVE
  PAUSED
  GRADUATED
  DROPPED
}

enum CalendarStatus {
  SCHEDULED
  CANCELLED
  RESCHEDULED
}

/// Fee history per Class, from ClassCreated / ClassUpdated. A row applies from its
/// period on, until a later row (BR-CL-04: a fee change applies from the next period).
model FeePolicy {
  classId       String   @map("class_id") @db.Uuid
  /// YYYY-MM: the first period this fee applies to.
  effectiveFrom String   @map("effective_from") @db.Char(7)
  tutorId       String   @map("tutor_id") @db.Uuid
  feeType       FeeType  @map("fee_type")
  /// VND, integer.
  feeAmount     Int      @map("fee_amount")
  /// BR-BI-08: whether ABSENT is charged (per Class).
  chargeAbsent  Boolean  @map("charge_absent")
  updatedAt     DateTime @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@id([classId, effectiveFrom])
  @@map("fee_policies")
}

/// Student name and Payer contact as Billing prints them on Invoices
/// (StudentCreated / StudentUpdated / StudentStatusChanged).
model StudentSnapshot {
  studentId    String        @id @map("student_id") @db.Uuid
  tutorId      String        @map("tutor_id") @db.Uuid
  fullName     String        @map("full_name") @db.VarChar(100)
  /// { name, email?, phone? }
  payerContact Json          @map("payer_contact")
  status       StudentStatus @default(ACTIVE)
  updatedAt    DateTime      @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@map("student_snapshots")
}

/// Local copy of Sessions (SessionScheduled / SessionCancelled / SessionRescheduled), used
/// to prorate Monthly fees by Session count (BR-BI-05, BR-BI-06); no call to Schedule.
model SessionCalendar {
  sessionId String         @id @map("session_id") @db.Uuid
  classId   String         @map("class_id") @db.Uuid
  /// Local Vietnam date of the Session.
  date      DateTime       @db.Date
  status    CalendarStatus @default(SCHEDULED)
  updatedAt DateTime       @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@index([classId, date])
  @@map("session_calendar")
}

enum InvoiceKind {
  MONTHLY
  ENROLLMENT
}

enum InvoiceStatus {
  DRAFT
  ISSUED
  PARTIALLY_PAID
  PAID
  OVERDUE
  VOID
}

enum ItemType {
  FEE
  ADJUSTMENT
}

enum AttendanceStatus {
  PRESENT
  LATE
  EXCUSED
  ABSENT
}

/// Billing's copy of each Enrollment (StudentEnrolled / StudentWithdrawn): who is in which
/// Class and when, for Monthly fees and proration (BR-BI-05, BR-BI-06).
model EnrollmentCopy {
  enrollmentId String    @id @map("enrollment_id") @db.Uuid
  classId      String    @map("class_id") @db.Uuid
  studentId    String    @map("student_id") @db.Uuid
  feeType      FeeType   @map("fee_type")
  joinedAt     DateTime  @map("joined_at") @db.Date
  /// First day no longer enrolled (Vietnam date of the StudentWithdrawn event).
  leftAt       DateTime? @map("left_at") @db.Date

  @@index([classId])
  @@index([studentId])
  @@map("enrollment_copies")
}

/// One Monthly invoice per Student per period (partial unique index in the migration),
/// plus Enrollment invoices. Never edited once ISSUED (ADR-0002).
model Invoice {
  id                String        @id @default(uuid()) @db.Uuid
  kind              InvoiceKind
  studentId         String        @map("student_id") @db.Uuid
  /// The Student's Tutor (scopes what a Tutor sees).
  tutorId           String        @map("tutor_id") @db.Uuid
  /// ENROLLMENT invoices only.
  enrollmentId      String?       @map("enrollment_id") @db.Uuid
  studentName       String        @map("student_name_snapshot") @db.VarChar(100)
  payerContact      Json          @map("payer_contact_snapshot")
  period            String        @db.Char(7)
  /// VND; the sum of the items.
  total             Int           @default(0)
  status            InvoiceStatus @default(DRAFT)
  issuedAt          DateTime?     @map("issued_at") @db.Timestamptz(6)
  dueDate           DateTime?     @map("due_date") @db.Date
  replacesInvoiceId String?       @map("replaces_invoice_id") @db.Uuid
  voidReason        String?       @map("void_reason") @db.VarChar(500)
  createdAt         DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt         DateTime      @updatedAt @map("updated_at") @db.Timestamptz(6)
  items             InvoiceItem[]
  payments          Payment[]

  @@index([studentId, period])
  @@index([tutorId, period])
  @@map("invoices")
}

/// A FEE line (one per Session and Student, BR-BI-01; one per Enrollment and month for
/// Monthly fees) or an ADJUSTMENT correcting an earlier, already issued line (ADR-0002).
model InvoiceItem {
  id               String            @id @default(uuid()) @db.Uuid
  invoiceId        String            @map("invoice_id") @db.Uuid
  invoice          Invoice           @relation(fields: [invoiceId], references: [id])
  type             ItemType
  studentId        String            @map("student_id") @db.Uuid
  tutorId          String            @map("tutor_id") @db.Uuid
  /// Null only for balance carried between months (no single Class).
  classId          String?           @map("class_id") @db.Uuid
  sessionId        String?           @map("session_id") @db.Uuid
  enrollmentId     String?           @map("enrollment_id") @db.Uuid
  adjustsItemId    String?           @map("adjusts_item_id") @db.Uuid
  /// The month the charge is for (may differ from the invoice's period for late lines).
  servicePeriod    String            @map("service_period") @db.Char(7)
  attendanceStatus AttendanceStatus? @map("attendance_status")
  description      String            @db.VarChar(255)
  /// VND; an ADJUSTMENT may be negative.
  amount           Int
  /// Copied onto a replacement invoice (void-and-replace): the copy counts, this row no longer
  /// does. Lines of an invoice voided for a zero total still count (they net to zero).
  superseded       Boolean           @default(false)
  createdAt        DateTime          @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt        DateTime          @updatedAt @map("updated_at") @db.Timestamptz(6)

  @@index([invoiceId])
  @@index([sessionId, studentId])
  @@index([enrollmentId])
  @@map("invoice_items")
}

/// Months already closed (00:00 on the 1st): no new draft is opened for them; late charges
/// go to the next open month.
model PeriodClose {
  period   String   @id @db.Char(7)
  closedAt DateTime @default(now()) @map("closed_at") @db.Timestamptz(6)

  @@map("period_closes")
}

/// Overdue reminders already sent (BR-BI-03: due + 1, + 5, + 10 days), so a re-run sends none twice.
model InvoiceReminder {
  invoiceId   String   @map("invoice_id") @db.Uuid
  daysOverdue Int      @map("days_overdue") @db.SmallInt
  sentAt      DateTime @default(now()) @map("sent_at") @db.Timestamptz(6)

  @@id([invoiceId, daysOverdue])
  @@map("invoice_reminders")
}

enum PaymentKind {
  PAYMENT
  REVERSAL
}

enum PaymentMethod {
  CASH
  BANK_TRANSFER
  MOMO
}

/// Money in, insert-only (BR-BI-07, ADR-0002): a wrong entry is cancelled by a REVERSAL,
/// never edited or deleted (a trigger in the migration refuses UPDATE and DELETE).
model Payment {
  id                String        @id @default(uuid()) @db.Uuid
  invoiceId         String        @map("invoice_id") @db.Uuid
  invoice           Invoice       @relation(fields: [invoiceId], references: [id])
  kind              PaymentKind
  /// REVERSAL only: the PAYMENT it cancels (at most one Reversal per Payment).
  reversesPaymentId String?       @unique @map("reverses_payment_id") @db.Uuid
  /// VND, always positive; a REVERSAL subtracts it.
  amount            Int
  method            PaymentMethod
  paidAt            DateTime      @map("paid_at") @db.Timestamptz(6)
  recordedBy        String        @map("recorded_by") @db.Uuid
  note              String?       @db.VarChar(500)
  createdAt         DateTime      @default(now()) @map("created_at") @db.Timestamptz(6)

  @@index([invoiceId])
  @@index([paidAt])
  @@map("payments")
}
```

### `backend/billing-service/prisma/migrations/20261119011644_messaging/migration.sql`

```sql
-- CreateTable
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "routing_key" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "published_at" TIMESTAMPTZ(6),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processed_events" (
    "event_id" UUID NOT NULL,
    "processed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "outbox_events_published_at_created_at_idx" ON "outbox_events"("published_at", "created_at");
```

### `backend/billing-service/prisma/migrations/20261119093242_read_models/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "FeeType" AS ENUM ('PER_SESSION', 'MONTHLY');

-- CreateEnum
CREATE TYPE "StudentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'GRADUATED', 'DROPPED');

-- CreateEnum
CREATE TYPE "CalendarStatus" AS ENUM ('SCHEDULED', 'CANCELLED', 'RESCHEDULED');

-- CreateTable
CREATE TABLE "fee_policies" (
    "class_id" UUID NOT NULL,
    "effective_from" CHAR(7) NOT NULL,
    "tutor_id" UUID NOT NULL,
    "fee_type" "FeeType" NOT NULL,
    "fee_amount" INTEGER NOT NULL,
    "charge_absent" BOOLEAN NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "fee_policies_pkey" PRIMARY KEY ("class_id","effective_from")
);

-- CreateTable
CREATE TABLE "student_snapshots" (
    "student_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "full_name" VARCHAR(100) NOT NULL,
    "payer_contact" JSONB NOT NULL,
    "status" "StudentStatus" NOT NULL DEFAULT 'ACTIVE',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "student_snapshots_pkey" PRIMARY KEY ("student_id")
);

-- CreateTable
CREATE TABLE "session_calendar" (
    "session_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "status" "CalendarStatus" NOT NULL DEFAULT 'SCHEDULED',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_calendar_pkey" PRIMARY KEY ("session_id")
);

-- CreateIndex
CREATE INDEX "session_calendar_class_id_date_idx" ON "session_calendar"("class_id", "date");
```

### `backend/billing-service/prisma/migrations/20261119094155_invoices/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('MONTHLY', 'ENROLLMENT');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'ISSUED', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'VOID');

-- CreateEnum
CREATE TYPE "ItemType" AS ENUM ('FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'LATE', 'EXCUSED', 'ABSENT');

-- CreateTable
CREATE TABLE "enrollment_copies" (
    "enrollment_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "fee_type" "FeeType" NOT NULL,
    "joined_at" DATE NOT NULL,
    "left_at" DATE,

    CONSTRAINT "enrollment_copies_pkey" PRIMARY KEY ("enrollment_id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "kind" "InvoiceKind" NOT NULL,
    "student_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "enrollment_id" UUID,
    "student_name_snapshot" VARCHAR(100) NOT NULL,
    "payer_contact_snapshot" JSONB NOT NULL,
    "period" CHAR(7) NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "issued_at" TIMESTAMPTZ(6),
    "due_date" DATE,
    "replaces_invoice_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "type" "ItemType" NOT NULL,
    "student_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "session_id" UUID,
    "enrollment_id" UUID,
    "adjusts_item_id" UUID,
    "service_period" CHAR(7) NOT NULL,
    "attendance_status" "AttendanceStatus",
    "description" VARCHAR(255) NOT NULL,
    "amount" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "invoice_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "enrollment_copies_class_id_idx" ON "enrollment_copies"("class_id");

-- CreateIndex
CREATE INDEX "enrollment_copies_student_id_idx" ON "enrollment_copies"("student_id");

-- CreateIndex
CREATE INDEX "invoices_student_id_period_idx" ON "invoices"("student_id", "period");

-- CreateIndex
CREATE INDEX "invoices_tutor_id_period_idx" ON "invoices"("tutor_id", "period");

-- CreateIndex
CREATE INDEX "invoice_items_invoice_id_idx" ON "invoice_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_items_session_id_student_id_idx" ON "invoice_items"("session_id", "student_id");

-- CreateIndex
CREATE INDEX "invoice_items_enrollment_id_idx" ON "invoice_items"("enrollment_id");

-- AddForeignKey
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BR-BI-04: at most one non-void Monthly invoice per Student and period.
CREATE UNIQUE INDEX "invoices_one_monthly_per_period_idx" ON "invoices"("student_id", "period")
  WHERE "kind" = 'MONTHLY' AND "status" <> 'VOID';

-- BR-BI-06: at most one non-void Enrollment invoice per Enrollment.
CREATE UNIQUE INDEX "invoices_one_per_enrollment_idx" ON "invoices"("enrollment_id")
  WHERE "kind" = 'ENROLLMENT' AND "status" <> 'VOID';

-- BR-BI-01: at most one FEE line per (Session, Student), across all invoices.
CREATE UNIQUE INDEX "invoice_items_one_fee_per_session_idx" ON "invoice_items"("session_id", "student_id")
  WHERE "type" = 'FEE' AND "session_id" IS NOT NULL;

-- One Monthly FEE line per Enrollment and month.
CREATE UNIQUE INDEX "invoice_items_one_fee_per_enrollment_month_idx" ON "invoice_items"("enrollment_id", "service_period")
  WHERE "type" = 'FEE' AND "enrollment_id" IS NOT NULL;
```

### `backend/billing-service/prisma/migrations/20261119100545_invoice_lifecycle/migration.sql`

```sql
-- AlterTable
ALTER TABLE "invoice_items" ADD COLUMN     "superseded" BOOLEAN NOT NULL DEFAULT false,
ALTER COLUMN "class_id" DROP NOT NULL;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "void_reason" VARCHAR(500);

-- CreateTable
CREATE TABLE "period_closes" (
    "period" CHAR(7) NOT NULL,
    "closed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "period_closes_pkey" PRIMARY KEY ("period")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "invoice_id" UUID NOT NULL,
    "days_overdue" SMALLINT NOT NULL,
    "sent_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("invoice_id","days_overdue")
);

-- BR-BI-01 and one Monthly line per Enrollment and month, among lines that still count
-- (a superseded line has been copied onto a replacement invoice).
DROP INDEX "invoice_items_one_fee_per_session_idx";
CREATE UNIQUE INDEX "invoice_items_one_fee_per_session_idx" ON "invoice_items"("session_id", "student_id")
  WHERE "type" = 'FEE' AND "session_id" IS NOT NULL AND NOT "superseded";
DROP INDEX "invoice_items_one_fee_per_enrollment_month_idx";
CREATE UNIQUE INDEX "invoice_items_one_fee_per_enrollment_month_idx" ON "invoice_items"("enrollment_id", "service_period")
  WHERE "type" = 'FEE' AND "enrollment_id" IS NOT NULL AND NOT "superseded";
```

### `backend/billing-service/prisma/migrations/20261119201337_payments/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "PaymentKind" AS ENUM ('PAYMENT', 'REVERSAL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'MOMO');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "kind" "PaymentKind" NOT NULL,
    "reverses_payment_id" UUID,
    "amount" INTEGER NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paid_at" TIMESTAMPTZ(6) NOT NULL,
    "recorded_by" UUID NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payments_reverses_payment_id_key" ON "payments"("reverses_payment_id");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "payments_paid_at_idx" ON "payments"("paid_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- BR-BI-07 / ADR-0002: payments are insert-only. Corrections are REVERSAL rows.
CREATE FUNCTION payments_insert_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'payments are insert-only: record a REVERSAL instead of %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payments_no_update_or_delete
  BEFORE UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION payments_insert_only();

ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_reversal_shape"
  CHECK (("kind" = 'REVERSAL') = ("reverses_payment_id" IS NOT NULL));
```

### `backend/billing-service/prisma/migrations/migration_lock.toml`

```text
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```

### `backend/billing-service/src/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({ providers: [PrismaService], exports: [PrismaService] })
export class PrismaModule {}
```

### `backend/billing-service/src/prisma/prisma.service.ts`

```ts
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';

/** This service's database client (ADR-0003). Connects lazily on the first query. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? '' }) });
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```
