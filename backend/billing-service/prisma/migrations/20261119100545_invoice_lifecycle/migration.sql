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
