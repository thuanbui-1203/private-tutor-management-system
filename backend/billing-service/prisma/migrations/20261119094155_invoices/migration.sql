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
