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
