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
