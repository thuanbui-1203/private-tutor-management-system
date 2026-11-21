-- Access records (ADR-0005), written only by audit-service's consumer.

-- CreateTable
CREATE TABLE "access_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "user_id" UUID,
    "role" TEXT,
    "ip" TEXT NOT NULL,
    "user_agent" TEXT,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "query_keys" TEXT[],
    "status" INTEGER NOT NULL,
    "duration_ms" DOUBLE PRECISION NOT NULL,
    "service" TEXT,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_log_occurred_at_id_idx" ON "access_log"("occurred_at", "id");

-- CreateIndex
CREATE INDEX "access_log_user_id_occurred_at_idx" ON "access_log"("user_id", "occurred_at");

-- CreateIndex
CREATE INDEX "access_log_correlation_id_idx" ON "access_log"("correlation_id");

-- Insert-only. The retention purge is the one allowed DELETE: it runs in a transaction
-- that first sets `SET LOCAL audit.purge = 'on'`.
CREATE FUNCTION access_log_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('audit.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'access_log is insert-only (ADR-0005)';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER access_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "access_log"
  FOR EACH ROW EXECUTE FUNCTION access_log_guard();

CREATE TRIGGER access_log_no_truncate
  BEFORE TRUNCATE ON "access_log"
  FOR EACH STATEMENT EXECUTE FUNCTION access_log_guard();
