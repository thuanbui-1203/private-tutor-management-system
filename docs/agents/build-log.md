# Build log

What the implementing agent did, decided and verified, newest last. Each issue follows the
same loop: branch → implement → unit + integration tests → mutation checks (break a rule,
confirm a test fails, restore) → format, lint, build → `pnpm migrate:all` + rebuild the
container → commit (Vietnamese, `Closes #n`) → PR → merge → sync `main`.

## Before 2026-11-20 (summary)

| Issue | PR | Result |
|---|---|---|
| #2–#5 foundation | #22, #24, #25, #27 | Workspace, contracts, compose stack, `@tms/common` |
| docs reading guide | #26 | Docs split for 3 readers |
| #6–#7 Identity | #28, #29 | Tutor signup on Firebase Auth, Invitations, Admin users |
| #8 gateway | #30 | Token verification, routing, rate limiting |
| #9–#10 Student | #31, #32 | Student and Parent records, lifecycle, Anonymisation |
| #11 Classes | #33 | Class CRUD, seats, `/internal/tutors/{id}/open-classes` |
| #12 Enrollment Saga (Class side) | #34 | Row-locked seats, PENDING when Student is down, compensation |
| #13 Schedules | #35 | Recurring Schedules, 3-month generation, Roster, Saga reply |
| #14 Session lifecycle | #36 | start / cancel / reschedule (one `SessionRescheduled`), makeups, MISSED job |
| #15 Attendance | #37 | Record + 48h corrections, locked MISSED, per-student history (BR-SC-10) |
| #16 Billing copies | #38 | Fee history, student snapshots, `session_calendar`, `countSessions` |
| #17 Charges | #39 | Idempotent per-(Session, Student) reconcile, Adjustments, Monthly fees |
| #18 Enrollment invoices | #40 | Issued at once, prorated, withdrawal credit; `isPayer` on Student access |

Open item carried over: the Firebase Auth emulator listened only on 127.0.0.1, so containers
could not reach it; changing `firebase.json` to `0.0.0.0` had been blocked as a safety
measure and left to the user.

## 2026-11-20

- **Session resumed.** Machine had restarted: no containers running, checkout on `main`.
  Switched back to `feat/19-invoice-lifecycle` (WIP commit `81cd0b3`), started postgres,
  rabbitmq, redis.
- **Decision (delegated by the user): how containers reach the Firebase Auth emulator.**
  Instead of binding the host emulator to `0.0.0.0` (reachable from the whole LAN), the
  emulator will run as a dev-only compose service: it binds `0.0.0.0` *inside its
  container*, other containers reach it as `firebase-emulator:9099` on the private compose
  network, and its port is published to the host on `127.0.0.1` only, so the browser and
  host-run tests keep using `127.0.0.1:9099` and nothing is exposed beyond this machine.
  The real Firebase project is never used by tests (project `demo-tms`). To be done in the
  final deployment step, after #20.
- **Found:** PR #41 (my WIP commit for #19) was merged into `main` by the repo owner's
  account at 2026-11-19 10:23 UTC, after the checkpoint; issue #19 is still open. The WIP
  code (28/28 billing integration tests) is therefore on `main`. Finishing #19 on
  `feat/19-invoice-lifecycle-finish` from `main`; its PR closes #19.
- **#19 docs** (while mutation checks ran in the background): docs/02 §8 (close, overdue,
  void-and-replace, jobs), diagram 09 (DRAFT→VOID with carry-over, reminder days,
  OVERDUE→VOID), ERD (`void_reason`, nullable `class_id`, `superseded`, `period_closes`,
  `invoice_reminders`).
- **Tooling note:** Python heredocs run through Git Bash turned `"\n"` into real newlines
  in two diagram edits; diagram text with PlantUML `\n` is now edited with the Edit tool.
  Billing sources are CRLF, so mutation patterns are single-line; mutation runs now go
  through a script that restores the files on exit (`trap`), after the 2026-11-19 run was
  interrupted mid-mutation.
- **#19 mutation checks:** 13/14 caught on the first run. Survivor: removing the
  in-transaction DRAFT re-check of the close. It only matters when two closes run at once,
  which no test did. Added a test running two `closeMonth` calls concurrently (each invoice
  issued once, one `InvoiceIssued`); stable 3/3, and the mutant now fails 3/3.
- **Emulator:** after the restart the gateway suite failed with `ECONNREFUSED
  127.0.0.1:9099`; restarted the host emulator (`pnpm emulators`, 127.0.0.1) for tests.
- **#19 gate:** format, lint, 9/9 builds, unit tests, 137 integration tests (billing 29).
  `pnpm migrate:all` applied `invoice_lifecycle`; billing rebuilt; whole stack started again
  after the restart: identity 3001, student 3002, class 3003, schedule 3004, billing 3006
  ready, gateway healthy on 8080.
- **#19 merged** as PR #42 (closes #19).
- **#20 started** on `feat/20-payments`. Design decisions:
  - `payments` is insert-only, enforced by a database trigger (UPDATE/DELETE raise), plus
    CHECKs (`amount > 0`, `reverses_payment_id` iff `REVERSAL`) and a unique
    `reverses_payment_id` (one Reversal per Payment).
  - One status rule for every money movement (`deriveStatus`): fully paid → PAID; else past
    due → OVERDUE; else some money → PARTIALLY_PAID; else ISSUED. A partial payment on an
    overdue invoice keeps it OVERDUE (reminders continue); `PaymentReceived.invoiceStatus`
    still says PARTIALLY_PAID / PAID, as the contract requires. Diagram 09 updated.
  - Void now checks net money received instead of the status (an OVERDUE invoice can hold
    a partial payment).
  - Revenue report: `billed` by month of service from issued invoices' lines (`tutor_id`),
    `collected` by month received (Vietnam time) from Payments minus Reversals.
  - VietQR: EMVCo payload built in-house (NAPAS GUID `A000000727`, service `QRIBFTTA`,
    CRC-16/CCITT-FALSE verified against the standard check value `29B1`); bank account
    from `BILLING_BANK_*` env, empty → 503. No real account is committed.
  - student-service now gets `BILLING_SERVICE_URL` in compose, so its BR-ST-08 check calls
    billing's new `/internal/students/{id}/open-invoices` instead of the stub.
- **#20 test fixes while writing:** two revenue-test setups were wrong, not the code: an
  attendance recorded after January had closed went (correctly) to February; and another
  test's Monthly enrollment (same tutor) was (correctly) billed for January. The revenue
  test now uses two tutors of its own. 37/37 billing tests, stable over reruns.
- **Auth decision, refined after reading the compose file.** Compose already runs in one of
  two modes: the real Firebase project by default (Auth only, free on Spark, Admin SDK key in
  the gitignored `infra/keys/`), or the emulator when `FIREBASE_AUTH_EMULATOR_HOST` is set.
  Final setup:
  1. **Running the app** (the "deployed" local stack): the real project
     `private-tutor-management-sys`, as compose does today. Real sign-in works in the browser.
  2. **End-to-end tests (#21) and offline dev:** a compose *profile* `emulator` adds a
     `firebase-emulator` container (project `demo-tms`) bound to 0.0.0.0 inside the compose
     network only, published to the host as `127.0.0.1:9099`; the services get
     `FIREBASE_AUTH_EMULATOR_HOST=firebase-emulator:9099`. Tests never touch the real project.
  The host `firebase.json` stays on 127.0.0.1, so nothing listens on the LAN.
- **#20 mutation checks:** 17/17 caught (overpayment, paying drafts, future `paidAt`, event
  status, missing `enrollmentId`, double reversal, reversing a reversal, status not
  refreshed, reversals ignored, PAID boundary, OVERDUE after reversal, balance access,
  revenue scope, QR amount, CRC init, open-invoice filter, void with money).
- **#20 gate:** format, lint, 9/9 builds, unit tests, 145 integration tests (billing 37).
  Migration `payments` applied; student + billing rebuilt. Live: student-service has
  `BILLING_SERVICE_URL=http://billing-service:3006` and gets `{"invoiceIds":[]}` from
  billing over the compose network; the gateway still answers 404 for `/api/internal/...`.
- **#20 merged** as PR #43 (closes #20). Backend issues #2–#20 are all closed.
- **#23 frontend, group 1 (auth + shell)** on `feat/23-frontend-auth`:
  - Added `firebase` 13.4.0 and `@playwright/test` 1.65.1 to the catalog; frontend depends
    on `@tms/contracts` for status enums (type-only imports, so no Node code reaches the
    browser). The frontend Dockerfile now builds `@tms/frontend...` so contracts are built
    first, and takes an optional `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` build arg.
  - Read `node_modules/next/dist/docs` first (Next 16: `useParams` in client components,
    `useSearchParams` needs `<Suspense>`, `middleware` → `proxy`; not used here).
  - Modules: auth (Firebase client SDK + claims), API client (Bearer, typed errors, 401 →
    sign out), role gate, app shell, shared UI; pages: login, register (incl. "finish
    sign-up" for an account without a role), forgot password, invitation, role homes.
  - Browser tests (Playwright, one seam): `/api/*` stubbed per test with a recorder that
    returns 501 for anything unstubbed; accounts and claims created in the Auth Emulator
    through its REST API (`Bearer owner`), never the real project.
  - Problems found and fixed while testing:
    1. All tests failed at first: Next 16 dev blocks dev resources for origins other
       than `localhost` (the HMR socket failed and the page never hydrated, so the form
       did a native submit). Tests now use `http://localhost:5174`.
    2. Next's dev route announcer also has `role="alert"`; tests scope to `main`.
    3. A field hint was part of the input's accessible name ("Mật khẩu Ít nhất 8 ký tự").
       `Field` now links the hint with `aria-describedby` (real accessibility fix).
    4. Sign-out raced with the role gate (ended at `/login?next=…`). The auth module now
       remembers a deliberate sign-out.
  - Result: 14/14 browser tests, stable over two runs.
  - Lint (React Compiler rules) rejected the first `useLoad` (ref written during render,
    synchronous setState in an effect). Rewritten with a reload counter and state set only
    from promise callbacks; stale responses are ignored. One test had relied on Strict
    Mode's double effect (first call 503, second OK); it now keeps the stub failing until
    the test brings the "service" back.
  - Mutation checks 6/6 caught (no Bearer, 401 not signing out, gate letting every role
    in, sign-up without claim refresh, token sent on the public invitation call, 403 shown
    as a plain error). The invitation one first survived because nobody was signed in; the
    test now opens the invitation while another user is still signed in.
  - Gate: format, lint, 9/9 builds, unit tests; `tms-frontend` image builds (contracts built
    first) and serves `/`, `/login`, `/register`, `/tutor`, `/invite/x` with 200.
- **#23 group 1 merged** as PR #44.
- **#23 group 2 (Tutor: Students, Classes, enrollment)** on `feat/23-frontend-students-classes`:
  - Read the real request/response shapes from student-service and class-service first
    (schemas, `viewFor`, enrollment errors, what class-service does on each Student status)
    so screen texts describe what the backend actually does.
  - Screens:
    - Students: list with search, status filter and paging; create with Parents (the
      minor-needs-primary-Parent rule is checked before sending); detail with payer, private
      note, edit, status change behind a confirmation that explains the effect, invitation
      resend, Parents, Classes.
    - Classes: list, create, detail with the current fee and its start period; a fee change
      tells the Tutor it applies from the next period.
    - Enrollment: the 201 ACTIVE, 201 AWAITING_PAYMENT (deadline in Vietnam time), 202
      PENDING and 409 outcomes; pause, resume and withdraw; closing a Class lists its
      consequences first.
  - Next.js only allows certain exports from page files, so helpers live in `src/lib/rules.ts`
    and `src/components/badges.tsx`. The menu highlights a role home only on itself.
  - 11 new browser tests (25 total, stable over two runs); mutation checks 8/8 caught. One
    mutation pattern broke on shell quoting and was rewritten as "the dialog never opens".
- **#23 group 2 merged** as PR #45.
- **#23 group 3 (Tutor: Schedules, calendar, Attendance)** on `feat/23-frontend-schedule`:
  - Teaching calendar (`/tutor/schedule`): week or month, filter by Class, Sessions grouped
    by day with their Class and status. Actions: open the Session (only from 15 minutes
    before the start), take Attendance, cancel with a reason (says nobody is charged, then
    offers a makeup linked by `makeupOf`), reschedule (a 409 lists the overlapping Session
    and its Class), and one-off Sessions. A panel lists missed Sessions of the last 3 days
    for late Attendance before the 48h lock.
  - Recurring Schedules on the Class page: the BR-SC-07 notice, preview with the Sessions
    it would create and their overlaps; saving is blocked while there are overlaps unless
    the Tutor chooses "save and skip N"; ending a Schedule asks first.
  - Attendance sheet: four statuses per Student plus a note, "the rest are present", one
    PUT with every Student; correction mode says until when; after 48h the inputs are
    disabled, there is no save button, and missed Sessions say they are not charged. A 409
    lock from the API is explained too.
  - Attendance history (month picker, totals, per-Session rows) on the Student page.
  - Lint: the React Compiler purity rule rejects `Date.now()` during render; "now" is
    captured once per card with `useState(Date.now)`.
  - 9 new browser tests (34 total, stable over two runs, all passed on the first run).
  - Mutation checks 11/11 caught (save despite overlaps, skip flag never sent, ending without confirmation, makeup without its link, start at any time, no missed panel, unnamed conflicting Class, partial sheet saved, never locked, raw 409 lock text, note dropped).
- **#23 group 3 merged** as PR #46.
- **#23 group 4 (Tutor billing)** on `feat/23-frontend-billing`:
  - **Backend gap found and closed:** the invoice detail had no payment history, which the
    Payer screens need too (story 68). `GET /billing/invoices/{id}` and the Enrollment
    invoice now include `payments`, `paid` and `outstanding`. New billing integration test
    (38/38); the mutation that counts reversals as payments is caught.
  - Screens:
    - Invoice list with period, status and kind filters.
    - Invoice detail: FEE and ADJUSTMENT lines; each Adjustment says it corrects a Session,
      an enrollment fee or a balance of an earlier period, without editing the issued
      invoice. Paid and outstanding amounts, payment history.
    - Record a payment: amounts over the outstanding balance are blocked in the page, and
      the API's own 422 (someone paid meanwhile) is explained.
    - Reverse a payment with a reason; void-and-replace with a reason, which opens the
      replacement.
    - VietQR drawn in the browser with `qrcode` 1.5.4 (added to the catalog); the 503 for an
      unconfigured bank account is explained.
    - Balance section on the Student page; revenue report by month range.
  - UX bugs the tests caught: after a partial payment the form kept the old amount (it now
    remounts and pre-fills what is left); the "reason required" errors of the reversal and
    void dialogs appeared behind the dialog (now inside it).
  - The Git Bash heredoc broke twice on JSX content; files are now written with the
    Write tool.
  - 8 new browser tests (42 total, stable over two runs).
  - Mutation checks 9/9 caught after strengthening the reversal test (empty reason must not send; the reversal button must disappear once used). The two that first survived showed those gaps.
- **#23 group 4 merged** as PR #47.
- **#23 group 5 (Parent, Student, Admin) — closes #23** on `feat/23-frontend-family-admin`:
  - **Three backend gaps found while planning, each closed with an integration test:**
    1. student-service `GET /students/me`: a Student had no way to find their own record
       (only Parents had `/parents/me/children`). Declared before `/:id` so "me" is not
       parsed as an id. 404 when not linked, 403 for other roles.
    2. billing `GET /billing/students/{id}/invoices` (Tutor, Admin, Payer): the Payer could
       not list their child's invoices (`/billing/invoices` is staff-only and the balance
       shows open ones only), so paid invoices were invisible (story 68). Drafts are not
       listed. Two mutations (drafts listed, no access check) caught.
    3. identity `GET /users?role=&status=` (Admin): needed for the Tutors list (story 12).
  - Screens:
    - A shared family module for Parents and Students: child switcher (remembered per
      browser, with safe `localStorage` access), upcoming 4 weeks with cancelled (with the
      reason) and moved Sessions marked, own-child Attendance.
    - Billing menu only when the API says the viewer is the Payer: a Parent needs
      `PRIMARY_PARENT`, a Student needs `SELF`; nothing is inferred from age. Payer
      billing: balance, every issued invoice incl. paid ones, read-only detail with VietQR.
    - Admin: Tutors list with disable / re-enable (a 409 shows "N open Classes",
      BR-CL-08), the Tutor screens in the menu, and Students created on the Admin's own
      account (`tutorId`).
  - **Bug the tests caught:** the billing page loaded billing data before checking whether
    the viewer is the Payer, so a secondary Parent fired requests the API refuses. The
    loading now lives in a child component rendered only for the Payer.
  - 7 new browser tests (49 total, stable over two runs); mutation checks 8/8 caught.
  - Gate: format, lint, 9/9 builds, unit tests, 148 integration tests; identity, student,
    billing and frontend rebuilt. Live: `/students/me` 404 unlinked,
    `/billing/students/{id}/invoices` 404 unknown, `/users?role=TUTOR` lists 1 tutor,
    frontend `/parent` and `/admin` 200.
- **#23 merged** (group 5, PR #48); issue #23 closed. Frontend: 49 browser tests.
- **#21 end-to-end** on `feat/21-e2e`:
  - Design:
    - A separate compose project `tms-e2e` (`docker-compose.e2e.yml` overlay): its own
      databases and broker, production images, every host port moved to 2xxxx and bound
      to 127.0.0.1 (Compose `!override` / `!reset`).
    - A Firebase Auth Emulator container (`infra/firebase-emulator`, firebase-tools
      15.36.0, project `demo-tms`) reached as `firebase-emulator:9099`. This is how the
      delegated auth decision is implemented: the emulator binds 0.0.0.0 only inside the
      container, and the host `firebase.json` is unchanged.
  - Time control: test-only hooks `/internal/test/*`, mounted only when `E2E_HOOKS=true`
    (set only by the e2e overlay, never routed by the gateway):
    - class: run the expire-unpaid and reconcile-PENDING jobs at a given instant;
    - billing: close a month at a given instant, and count `session_calendar`;
    - schedule: create a Session at any instant (one already under way).
    Everything else goes through the gateway with real emulator ID tokens.
  - `pnpm test:e2e` (scripts/e2e.mjs): fresh project → infrastructure → Prisma migrations
    against `127.0.0.1:25432` → services (healthy) → `tests/e2e` (Jest, new workspace
    folder `tests/*`) → teardown unless `--keep`.
  - Problems while bringing it up:
    1. Compose v5 built through Bake and demanded `--allow=fs.read=<Dockerfile>` when
       launched straight from Git Bash, but not when launched by pnpm. Ruled out `PWD`,
       `SHELL`, `_` and the docker binary (same file); the environments differ only in
       `PATH` and pnpm's own variables. The script now runs Docker through the existing
       `pnpm compose` wrapper. The emulator image also builds from the repo root like the
       others.
    2. Six images built in parallel crashed BuildKit ("rpc error ... EOF", out of memory).
       Bake ignores `COMPOSE_PARALLEL_LIMIT`, so the script builds one image at a time.
  - **Result:** all 6 scenarios pass (5 tests; scenarios 1 and 2 share one) on the first
    run that reached the tests, and again from scratch with the documented `pnpm test:e2e`
    (5/5 in 30.6s, stack removed afterwards).
  - Proof the suite can fail: with billing-service stopped on the kept stack, scenario 1
    fails (no Enrollment invoice); it passes again once billing is back.
  - The hooks are absent in the normal stack: on the rebuilt dev containers,
    `POST /internal/test/{jobs,sessions,close-month}` answer 404, and so does
    `/api/internal/test/jobs` through the gateway.
  - Gate: format, lint, 9/9 builds, unit tests, 148 integration tests.
  - Known limit: scenario 4 creates a Session that started 10 minutes ago, so running it
    between 00:00 and 00:10 Vietnam time puts the Session on the previous day.
- **#21 merged** as PR #49 (closes #21). All 21 sub-issues of tracking issue #1 are closed.
- **Final deploy (local stack, real Firebase project as decided):**
  - Rebuilt every image from `main` one at a time (identity, student, class, schedule,
    billing, gateway, frontend); `pnpm migrate:all` reported no pending migrations; all
    eleven containers healthy (gateway 8080, identity 3001, student 3002, class 3003,
    schedule 3004, billing 3006, frontend 5173, postgres, rabbitmq, redis, mailpit).
  - Found and fixed during the check: the frontend container was still running an
    image from group 1 (the dev override keeps the frontend behind the
    `frontend-in-docker` profile, so `up -d` had not recreated it). Recreated it with
    `pnpm compose --profile frontend-in-docker up -d --force-recreate frontend`.
  - Verified that real routes answer 200 (`/login`, `/tutor/invoices`, `/tutor/schedule`,
    `/parent/billing`, `/admin`) and unknown routes under the same layouts answer 404.
    The status code alone was not conclusive on the stale image, so the check compares
    against known-bad routes.
  - The e2e test hooks are absent from this stack (404).
- **Audit trail + bank details with consent (tracking #51, 2026-11-22):** the user asked that
  every user action be logged and that bank details be stored only with consent. Decisions
  (asked, not assumed): bank details for both Tutor and Payer; log every request including
  `GET`; store at the gateway (Access records → new audit-service) *and* per service
  (Change records); on consent withdrawal mask and keep. Issues #52–#58, blockers wired.
  - Other sessions were editing the shared checkout at the same time (monitoring work), so
    this work runs in its own worktree `../microservices_final-audit`.
- **#52 foundation** on `feat/52-audit-foundation`:
  - `@tms/contracts`: `AccessRecord`, `ChangeRecord`, `InternalAuditQuery/Response`,
    exchange `tms.audit`, queue `audit.access-recorded`.
  - `@tms/common`: actor in the request context (AuthGuard), `recordChange(tx, …)` (only
    changed fields; personal data → `[personal]`, secrets → `[secret]`, account numbers →
    `••••1234`), `GET /internal/audit` in business services, `sql/audit.sql` with a trigger
    that rejects UPDATE/DELETE/TRUNCATE.
  - Personal values are never stored in Change records: `audit_log` is immutable, so storing
    them would make Anonymisation (BR-ST-08) impossible. Recorded in ADR-0005.
  - ADR-0005 (audit log), ADR-0006 (bank details with consent), GLOSSARY section
    "Nhật ký và dữ liệu nhạy cảm", docs/01 §6 rows.
  - Tests: 45 unit (common) incl. 12 new, 8 integration incl. 4 new (rollback leaves no
    record; UPDATE/DELETE/TRUNCATE fail), contracts 104. Mutation checks: removing the
    actor hand-off in AuthGuard, the personal mask, or the unchanged-field skip each fails tests.
- **#53 Change records in the five services** on `feat/53-change-records` (stacked on #52):
  - Migration `20261122000000_audit` + `AuditLog` model in identity, student, class, schedule
    and billing (same DDL as `packages/common/sql/audit.sql`, insert-only triggers).
  - `recordChange` inside the transaction of every user action: `user.register|update`,
    `invitation.create|accept`, `student.create|update|add-parent|remove-parent|change-status|anonymise`,
    `parent.create|update|anonymise`, `class.create|update|close`,
    `enrollment.create|pause|resume|withdraw`, `schedule.create|end`,
    `session.create|start|cancel|reschedule`, `attendance.record|correct`, `invoice.void`,
    `payment.record|reverse`. Two writes that ran outside a transaction (remove a Parent
    link, create a Parent) now run in one. The BR-ST-02 job records `SYSTEM` as actor.
  - Extra personal fields per service: `firebaseUid` (identity), `school` (student),
    `studentName` (class), attendance `note`, invoice `voidReason`.
  - Tests: one new integration test per service (actor, correlation id, changed fields,
    no personal values, refused change leaves none, `GET /internal/audit`). Integration:
    identity 15, student 37, class 24, schedule 23, billing 40, all passing. Mutation checks:
    removing `class.update`'s record or mislabelling `payment.reverse` each fails a test.
- **#54 audit-service** on `feat/54-audit-service` (stacked on #53):
  - New NestJS service on port **3008** (3007 stays reserved for notification-service), own
    `audit_db` + role (init.sql; `infra/postgres/add-audit-db.sql` for existing volumes).
  - Consumes `tms.audit` / `access.recorded` into `access_log` (idempotent on id; contract
    violations → `audit.dlq`; DB failure → requeue after 1 s). Triggers reject UPDATE and
    TRUNCATE, and DELETE except inside the retention purge (`SET LOCAL audit.purge = 'on'`).
  - `GET /audit/access` (filters, keyset paging) and `GET /audit/changes` (fan-out to the
    five `/internal/audit`, merged, `unavailable` for services that did not answer); ADMIN only.
  - Gateway routes `/audit/**`; compose, dev override, e2e stack and `scripts/e2e.mjs` include it.
  - Tests: 5 integration (real broker publish → stored; duplicate → one row; invalid →
    dead-lettered; filters/paging/403/401/400; insert-only + purge; fan-out with three
    services down), 2 unit; gateway 19 unit + 10 integration. Mutation checks: dropping
    `skipDuplicates` or opening the API to TUTOR each fails a test.
  - Ran the production image on the dev network: `/health/ready` database up, broker up.
- **#55 gateway Access records** on `feat/55-gateway-access-records` (stacked on #54):
  - `AccessLogPublisher`: one Access record per request under `/api` when the response
    finishes (status 0 if the client left first), including what the gateway rejects itself.
    User id + role only when the token carried them; `service` only when proxied.
  - Never recorded: bodies, headers, query values; `/auth/invitations/{token}/accept` and
    `/calendar/{token}.ics` become `:token`.
  - Publisher confirms on its own RabbitMQ connection (a broker outage must not make the
    gateway "not ready"); unconfirmed → append-only spool file (`AUDIT_SPOOL_DIR`, volume
    `gateway-audit-spool`), replayed every 5 s; metric `tms_audit_access_records_total{outcome}`.
  - Tests: 4 unit (path/query sanitising), 3 new integration against broker + Redis +
    emulator (200/401/404/501/429 each one record; no secret in path/query/body; spool then
    replay). Gateway: 23 unit, 13 integration. Mutation checks: not recording the user, or
    not masking the invitation token, each fails a test.
