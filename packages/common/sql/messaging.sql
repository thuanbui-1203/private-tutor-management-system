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
