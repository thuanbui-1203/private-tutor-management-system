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
