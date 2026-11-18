# Tutor Management System

A system for independent tutors and small tutoring centres to manage students, classes, schedules, attendance, grades and tuition billing.

## Language

### People

**Tutor**:
The person who teaches classes and owns their data. An Admin who also teaches is treated as a Tutor for the classes they own.
_Avoid_: Teacher, giáo viên, gia sư, instructor

**Admin**:
The owner of a centre, with access to all data and to Tutor management. A separate role from Tutor; one person holds exactly one role.
_Avoid_: Owner, manager

**Parent**:
A guardian linked to a Student. A Student may have several Parents, exactly one of them primary (the Payer); only the primary Parent sees billing.
_Avoid_: Guardian

**Invitation**:
A single-use link, valid for 7 days, that lets a Student or Parent activate their login and set a password. Re-sending revokes the previous link.
_Avoid_: Activation email, signup link

**Student**:
A learner enrolled in one or more classes. Every Student has a login by default; a Student under 18 must also have guardian details recorded.
_Avoid_: Pupil, child

**Payer**:
The one contact per Student who receives and settles Invoices. For a minor this is the primary Parent; for an adult learner it is the Student themselves.
_Avoid_: Bill-to, customer

**Anonymisation**:
Erasing a departed Student's name, contact details and notes on request, once all their Invoices are settled. Money records are kept under a pseudonymous id.
_Avoid_: Deletion, GDPR delete

### Classes and sessions

**Class**:
A taught group (or one-on-one) offering of one subject, with a fee policy.
_Avoid_: Course

**Session**:
A single dated meeting of a Class.
_Avoid_: Lesson, meeting, buổi học

**Schedule**:
An immutable recurring weekly pattern that generates a Class's Sessions. To change it, the Tutor ends it and creates a replacement.
_Avoid_: Timetable, recurring session

**Missed session**:
A Session with no Attendance recorded 24 hours after it ended. Attendance can still be recorded until 48 hours after the end; after that it is locked and bills nothing.
_Avoid_: Skipped session

**Makeup session**:
A Session that replaces a cancelled one and is linked back to it.
_Avoid_: Replacement class, dạy bù

**Enrollment**:
A Student's membership in a Class, with a status such as `PENDING`, `AWAITING_PAYMENT`, `ACTIVE`, `PAUSED`, `WITHDRAWN` or `REJECTED`. `PENDING`, `AWAITING_PAYMENT` and `ACTIVE` all hold a seat.
_Avoid_: Registration, ghi danh

**Awaiting payment**:
The Enrollment status of a Student in a Monthly-fee Class who has not yet paid the first-period Invoice. It becomes `WITHDRAWN` (reason `UNPAID`) after 7 days. Per-session Classes skip this status.
_Avoid_: Unpaid enrollment, deposit pending

**Roster**:
The Students with an `ACTIVE` or `AWAITING_PAYMENT` Enrollment in a Class, used to know who is expected at its Sessions. Awaiting-payment Students attend during their 7-day window.
_Avoid_: Class list, attendance list

### Attendance

**Attendance**:
The record of whether a Student was present at a Session: `PRESENT`, `LATE`, `EXCUSED` or `ABSENT`.

**Excused absence**:
An absence the Tutor chooses to mark `EXCUSED` because the Student gave notice roughly 24 hours ahead. The system does not verify the notice.
_Avoid_: Approved absence

### Billing

**Invoice**:
A request for payment addressed to a Student's Payer, made of lines tagged by Tutor. Either a Monthly invoice or an Enrollment invoice.
_Avoid_: Bill

**Monthly invoice**:
The regular Invoice for one Student and one month. At most one non-void Monthly invoice exists per Student per month; a voided one may be replaced.
_Avoid_: Statement, bill

**Enrollment invoice**:
An Invoice issued immediately on enrolling in a Monthly-fee Class, covering only the prorated fee for the first period. The Monthly invoice later skips lines already billed this way.
_Avoid_: Deposit, first invoice

**Payment**:
An immutable record of money received against an Invoice, never exceeding its outstanding balance. Invoice status is derived from Payments and Reversals.
_Avoid_: Receipt, transaction

**Reversal**:
A Payment entry that cancels an earlier, wrongly recorded Payment.
_Avoid_: Refund, payment edit

**Adjustment**:
A line on the next open Invoice that corrects a charge on an already-issued Invoice, such as after an Attendance correction. Issued Invoices are never edited.
_Avoid_: Credit note, refund line

**Per-session fee**:
A Class fee charged for each attended or billable Session, including Makeup sessions.

**Monthly fee**:
A flat Class fee for the month that does not depend on session count. Makeup sessions and cancellations never change it.
_Avoid_: Package fee, subscription
