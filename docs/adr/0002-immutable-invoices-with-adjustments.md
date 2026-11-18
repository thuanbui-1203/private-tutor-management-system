# Issued invoices are immutable; corrections are Adjustments

Once an Invoice is `ISSUED`, nothing edits it. Attendance corrections, proration differences and similar fixes become **Adjustment** lines on the next open Invoice. Payments are append-only, and mistakes are fixed with Reversals, so Invoice status is always derived from its Payments.

The alternative was to re-open and edit issued Invoices. We rejected it because Parents have already received the amount and may have paid part of it, and because the 48-hour Attendance correction window overlaps the Invoice issue date on the 1st of the month.

## Consequences

- A Parent can see an Adjustment on a later Invoice that refers to an earlier month.
- Billing must track which lines on a Monthly invoice came from an Adjustment and which Session or Enrollment each one corrects.
