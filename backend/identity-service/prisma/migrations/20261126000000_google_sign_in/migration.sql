-- Google sign-in (ADR-0004): an invited or seeded user has no Firebase account until the
-- first sign-in with Google, which is matched by the e-mail Google verified.
ALTER TABLE "users" ALTER COLUMN "firebase_uid" DROP NOT NULL;
