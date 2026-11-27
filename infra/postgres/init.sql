-- Runs once, on the first start of an empty data volume (docker-entrypoint-initdb.d).
-- One database and one login role per service (ADR-0003). Each role owns only its
-- own database, and CONNECT is revoked from PUBLIC, so a service cannot open
-- another service's database. Passwords are for local development only.
--
-- CREATEDB lets `prisma migrate dev` create its temporary shadow database and lets
-- integration tests create a throwaway database per run. A role still cannot
-- connect to databases it does not own.

CREATE ROLE identity LOGIN CREATEDB PASSWORD 'identity';
CREATE DATABASE identity_db OWNER identity;
REVOKE CONNECT ON DATABASE identity_db FROM PUBLIC;

CREATE ROLE student LOGIN CREATEDB PASSWORD 'student';
CREATE DATABASE student_db OWNER student;
REVOKE CONNECT ON DATABASE student_db FROM PUBLIC;

CREATE ROLE class LOGIN CREATEDB PASSWORD 'class';
CREATE DATABASE class_db OWNER class;
REVOKE CONNECT ON DATABASE class_db FROM PUBLIC;

CREATE ROLE schedule LOGIN CREATEDB PASSWORD 'schedule';
CREATE DATABASE schedule_db OWNER schedule;
REVOKE CONNECT ON DATABASE schedule_db FROM PUBLIC;

CREATE ROLE billing LOGIN CREATEDB PASSWORD 'billing';
CREATE DATABASE billing_db OWNER billing;
REVOKE CONNECT ON DATABASE billing_db FROM PUBLIC;

-- audit-service (ADR-0005). On a data volume created before it existed, run
-- infra/postgres/add-audit-db.sql once (docs/03-cach-chay.md).
CREATE ROLE audit LOGIN CREATEDB PASSWORD 'audit';
CREATE DATABASE audit_db OWNER audit;
REVOKE CONNECT ON DATABASE audit_db FROM PUBLIC;

-- tutor-service (docs/07 §2). On an older data volume run infra/postgres/add-tutor-db.sql once.
CREATE ROLE tutor LOGIN CREATEDB PASSWORD 'tutor';
CREATE DATABASE tutor_db OWNER tutor;
REVOKE CONNECT ON DATABASE tutor_db FROM PUBLIC;

-- The default `postgres` database must not be a back door either.
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
