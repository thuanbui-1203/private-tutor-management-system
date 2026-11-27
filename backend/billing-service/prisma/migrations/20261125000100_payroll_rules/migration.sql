-- Rules Prisma cannot express (docs/07 §6).

-- A Session is paid at most once, and has at most one correction waiting for the next run.
CREATE UNIQUE INDEX "work_items_one_work_per_session" ON "work_items"("session_id")
  WHERE "kind" = 'WORK';
CREATE UNIQUE INDEX "work_items_one_open_adjustment" ON "work_items"("session_id")
  WHERE "kind" = 'ADJUSTMENT' AND "payout_id" IS NULL;

-- One payroll at a time until it is funded and paid out.
CREATE UNIQUE INDEX "payroll_runs_one_open" ON "payroll_runs"((true))
  WHERE "status" IN ('DRAFT', 'AWAITING_FUNDS', 'SETTLING');

ALTER TABLE "pay_rates" ADD CONSTRAINT "pay_rates_amount" CHECK ("amount" > 0);
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_amounts"
  CHECK ("total" > 0 AND "received" >= 0);
ALTER TABLE "payroll_fundings" ADD CONSTRAINT "payroll_fundings_amount" CHECK ("amount" > 0);
ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount" CHECK ("amount" > 0);
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_amount" CHECK (
  "kind" = 'ADJUSTMENT' OR "amount" IS NULL
  OR "amount" = CASE WHEN "attended" THEN "rate" ELSE 0 END
);
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_paid_has_amount"
  CHECK ("payout_id" IS NULL OR "amount" IS NOT NULL);
