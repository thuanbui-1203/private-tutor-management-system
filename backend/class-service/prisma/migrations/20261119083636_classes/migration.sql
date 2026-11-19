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
