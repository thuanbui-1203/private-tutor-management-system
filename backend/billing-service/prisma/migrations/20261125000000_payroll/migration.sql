-- CreateEnum
CREATE TYPE "WorkItemKind" AS ENUM ('WORK', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "PayrollRunStatus" AS ENUM ('DRAFT', 'AWAITING_FUNDS', 'SETTLING', 'PARTIAL', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PROCESSING', 'PAID', 'FAILED');

-- CreateTable
CREATE TABLE "pay_rates" (
    "class_id" UUID NOT NULL,
    "effective_from" CHAR(7) NOT NULL,
    "amount" INTEGER NOT NULL,
    "set_by" UUID NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "pay_rates_pkey" PRIMARY KEY ("class_id","effective_from")
);

-- CreateTable
CREATE TABLE "session_attendance" (
    "session_id" UUID NOT NULL,
    "student_id" UUID NOT NULL,
    "status" "AttendanceStatus" NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "session_attendance_pkey" PRIMARY KEY ("session_id","student_id")
);

-- CreateTable
CREATE TABLE "work_items" (
    "id" UUID NOT NULL,
    "kind" "WorkItemKind" NOT NULL,
    "session_id" UUID NOT NULL,
    "class_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "period" CHAR(7) NOT NULL,
    "attended" BOOLEAN NOT NULL,
    "rate" INTEGER,
    "amount" INTEGER,
    "payout_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "work_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_runs" (
    "id" UUID NOT NULL,
    "period" CHAR(7) NOT NULL,
    "status" "PayrollRunStatus" NOT NULL DEFAULT 'DRAFT',
    "total" INTEGER NOT NULL,
    "received" INTEGER NOT NULL DEFAULT 0,
    "created_by" UUID NOT NULL,
    "approved_by" UUID,
    "approved_at" TIMESTAMPTZ(6),
    "funded_at" TIMESTAMPTZ(6),
    "completed_at" TIMESTAMPTZ(6),
    "pay_token_hash" TEXT,
    "pay_token_expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payroll_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_fundings" (
    "transaction_id" VARCHAR(100) NOT NULL,
    "run_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_fundings_pkey" PRIMARY KEY ("transaction_id")
);

-- CreateTable
CREATE TABLE "payouts" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "bank_bin" TEXT,
    "account_last4" TEXT,
    "provider_ref" TEXT,
    "failure_reason" VARCHAR(300),
    "claimed_at" TIMESTAMPTZ(6),
    "paid_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "payouts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "work_items_session_id_idx" ON "work_items"("session_id");

-- CreateIndex
CREATE INDEX "work_items_tutor_id_period_idx" ON "work_items"("tutor_id", "period");

-- CreateIndex
CREATE INDEX "work_items_payout_id_idx" ON "work_items"("payout_id");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_runs_pay_token_hash_key" ON "payroll_runs"("pay_token_hash");

-- CreateIndex
CREATE INDEX "payroll_runs_created_at_idx" ON "payroll_runs"("created_at");

-- CreateIndex
CREATE INDEX "payroll_fundings_run_id_idx" ON "payroll_fundings"("run_id");

-- CreateIndex
CREATE INDEX "payouts_tutor_id_idx" ON "payouts"("tutor_id");

-- CreateIndex
CREATE UNIQUE INDEX "payouts_run_id_tutor_id_key" ON "payouts"("run_id", "tutor_id");

-- AddForeignKey
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_payout_id_fkey" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_fundings" ADD CONSTRAINT "payroll_fundings_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "payroll_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

