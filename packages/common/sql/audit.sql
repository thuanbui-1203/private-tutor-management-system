-- Change records (ADR-0005), one table per business service database.
-- Reference DDL: each service's Prisma migration `audit` contains the same statements.
-- Insert-only: the trigger rejects UPDATE, DELETE and TRUNCATE, so a record cannot be
-- rewritten after the fact, not even by the service's own database role.

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "correlation_id" UUID,
    "actor_id" UUID,
    "actor_role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "changes" JSONB NOT NULL,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "audit_log_correlation_id_idx" ON "audit_log"("correlation_id");
CREATE INDEX "audit_log_entity_id_occurred_at_idx" ON "audit_log"("entity_id", "occurred_at");
CREATE INDEX "audit_log_actor_id_occurred_at_idx" ON "audit_log"("actor_id", "occurred_at");
CREATE INDEX "audit_log_occurred_at_idx" ON "audit_log"("occurred_at");

CREATE FUNCTION audit_log_insert_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is insert-only (ADR-0005)';
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_no_update_delete
  BEFORE UPDATE OR DELETE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_insert_only();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_insert_only();
