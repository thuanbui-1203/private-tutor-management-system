# PostgreSQL in Docker, one database per service

Each service stores its data in its own database (`identity_db`, `student_db`, `class_db`, `schedule_db`, `billing_db`) on a single **PostgreSQL 18 container** in `docker compose`. Each database has its own login role that can connect only to that database, so database-per-service is enforced by PostgreSQL permissions, not by convention. Schema and queries go through Prisma 7 (generated client in `src/generated/prisma`, `pg` driver adapter), one Prisma schema per service.

We considered Cloud Firestore, since Firebase already handles sign-in (ADR-0004). On the free Spark plan it allows only one database per project, which reduces database-per-service to a naming convention, and its daily quota (50,000 reads, 20,000 writes) is tight for an outbox relay and tests. It also lacks the unique constraints and joins that the business rules lean on, such as `UNIQUE(class_id, student_id)` and one non-void Monthly invoice per Student and month. We also briefly ran PostgreSQL installed on the developer's machine and dropped it so that every machine gets the same database from `docker compose up`.

## Consequences

- One server, many databases, keeps the stack light enough for a laptop; splitting a database onto its own server later only changes that service's `DATABASE_URL`.
- `infra/postgres/` creates the databases and roles on first start; data lives in a named Docker volume. The PostgreSQL 18 image keeps data under `/var/lib/postgresql` (not `/var/lib/postgresql/data` as in older images), so the volume is mounted there.
- Port 5432 is published to the host so migrations (`pnpm migrate:all`) and Prisma Studio run from the host.
- Integration tests use the same container, with a separate database per test run.
