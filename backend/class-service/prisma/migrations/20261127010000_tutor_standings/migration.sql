-- BR-TU-01: a copy of each Tutor's verification status, from TutorStatusChanged (docs/07 §2).
CREATE TABLE "tutor_standings" (
    "tutor_id" UUID NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "tutor_standings_pkey" PRIMARY KEY ("tutor_id")
);
