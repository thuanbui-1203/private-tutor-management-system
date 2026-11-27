-- CreateEnum
CREATE TYPE "TutorKind" AS ENUM ('STUDENT', 'TEACHER', 'GRADUATE');

-- CreateEnum
CREATE TYPE "ProfileStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'NEEDS_CHANGES', 'VERIFIED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "ItemStatus" AS ENUM ('PENDING', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CredentialKind" AS ENUM ('STUDENT_CARD', 'DEGREE', 'CERTIFICATE', 'TRANSCRIPT');

-- CreateEnum
CREATE TYPE "AreaKind" AS ENUM ('LOCAL', 'ONLINE', 'ABROAD');

-- CreateEnum
CREATE TYPE "Decision" AS ENUM ('VERIFY', 'NEEDS_CHANGES', 'REJECT', 'SUSPEND', 'REINSTATE');

-- CreateEnum
CREATE TYPE "FileStatus" AS ENUM ('UPLOADING', 'READY');

-- CreateTable
CREATE TABLE "tutor_profiles" (
    "tutor_id" UUID NOT NULL,
    "kind" "TutorKind",
    "display_name" VARCHAR(100),
    "bio" VARCHAR(2000),
    "school" VARCHAR(200),
    "school_country" CHAR(2),
    "reported_to_principal" BOOLEAN NOT NULL DEFAULT false,
    "no_own_pupils" BOOLEAN NOT NULL DEFAULT false,
    "gpa" DECIMAL(4,2),
    "gpa_scale" DECIMAL(4,2),
    "transcript_public" BOOLEAN NOT NULL DEFAULT false,
    "status" "ProfileStatus" NOT NULL DEFAULT 'DRAFT',
    "submitted_at" TIMESTAMPTZ(6),
    "verified_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tutor_profiles_pkey" PRIMARY KEY ("tutor_id")
);

-- CreateTable
CREATE TABLE "credentials" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "kind" "CredentialKind" NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "issuer" VARCHAR(200) NOT NULL,
    "country" CHAR(2) NOT NULL,
    "number" VARCHAR(100),
    "issued_on" DATE,
    "expires_on" DATE,
    "file_id" UUID,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tutor_subjects" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "subject" VARCHAR(50) NOT NULL,
    "grade_from" SMALLINT,
    "grade_to" SMALLINT,
    "suggested_fee" INTEGER,
    "status" "ItemStatus" NOT NULL DEFAULT 'PENDING',
    "review_note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tutor_subjects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_areas" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "kind" "AreaKind" NOT NULL,
    "province_code" INTEGER,
    "ward_code" INTEGER,
    "country" CHAR(2),
    "city" VARCHAR(100),
    "timezone" VARCHAR(50),

    CONSTRAINT "service_areas_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availabilities" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_time" CHAR(5) NOT NULL,
    "end_time" CHAR(5) NOT NULL,
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',

    CONSTRAINT "availabilities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" UUID NOT NULL,
    "tutor_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" "Decision" NOT NULL,
    "reason" VARCHAR(1000),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stored_files" (
    "id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "name" VARCHAR(200) NOT NULL,
    "mime" VARCHAR(100) NOT NULL,
    "size" INTEGER NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "location" VARCHAR(100) NOT NULL,
    "chunks" INTEGER NOT NULL,
    "key_version" VARCHAR(10) NOT NULL,
    "status" "FileStatus" NOT NULL DEFAULT 'UPLOADING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stored_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tutor_profiles_status_submitted_at_idx" ON "tutor_profiles"("status", "submitted_at");

-- CreateIndex
CREATE UNIQUE INDEX "credentials_file_id_key" ON "credentials"("file_id");

-- CreateIndex
CREATE INDEX "credentials_tutor_id_idx" ON "credentials"("tutor_id");

-- CreateIndex
CREATE INDEX "tutor_subjects_subject_status_idx" ON "tutor_subjects"("subject", "status");

-- CreateIndex
CREATE UNIQUE INDEX "tutor_subjects_tutor_id_subject_grade_from_grade_to_key" ON "tutor_subjects"("tutor_id", "subject", "grade_from", "grade_to");

-- CreateIndex
CREATE INDEX "service_areas_province_code_ward_code_idx" ON "service_areas"("province_code", "ward_code");

-- CreateIndex
CREATE INDEX "reviews_tutor_id_created_at_idx" ON "reviews"("tutor_id", "created_at");

-- CreateIndex
CREATE INDEX "stored_files_status_created_at_idx" ON "stored_files"("status", "created_at");

-- CreateIndex
CREATE INDEX "stored_files_owner_id_idx" ON "stored_files"("owner_id");

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor_profiles"("tutor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credentials" ADD CONSTRAINT "credentials_file_id_fkey" FOREIGN KEY ("file_id") REFERENCES "stored_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tutor_subjects" ADD CONSTRAINT "tutor_subjects_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor_profiles"("tutor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor_profiles"("tutor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availabilities" ADD CONSTRAINT "availabilities_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor_profiles"("tutor_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_tutor_id_fkey" FOREIGN KEY ("tutor_id") REFERENCES "tutor_profiles"("tutor_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Not generated by Prisma (docs/07 §2).
ALTER TABLE "tutor_subjects" ADD CONSTRAINT "tutor_subjects_grades"
  CHECK ("grade_from" IS NULL OR ("grade_from" BETWEEN 1 AND 12 AND "grade_to" BETWEEN "grade_from" AND 12));
ALTER TABLE "tutor_subjects" ADD CONSTRAINT "tutor_subjects_fee" CHECK ("suggested_fee" IS NULL OR "suggested_fee" > 0);
ALTER TABLE "availabilities" ADD CONSTRAINT "availabilities_slot"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "start_time" ~ '^[0-2][0-9]:[0-5][0-9]$'
    AND "end_time" ~ '^[0-2][0-9]:[0-5][0-9]$' AND "start_time" < "end_time");
ALTER TABLE "service_areas" ADD CONSTRAINT "service_areas_kind" CHECK (
  ("kind" = 'LOCAL' AND "province_code" IS NOT NULL AND "country" IS NULL)
  OR ("kind" = 'ONLINE' AND "province_code" IS NULL AND "country" IS NULL)
  OR ("kind" = 'ABROAD' AND "province_code" IS NULL AND "country" IS NOT NULL));
ALTER TABLE "stored_files" ADD CONSTRAINT "stored_files_size" CHECK ("size" > 0 AND "size" <= 5242880);

-- Admin decisions are evidence: insert-only.
CREATE FUNCTION reviews_insert_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'reviews is insert-only';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER reviews_no_update_delete BEFORE UPDATE OR DELETE ON "reviews"
  FOR EACH ROW EXECUTE FUNCTION reviews_insert_only();
