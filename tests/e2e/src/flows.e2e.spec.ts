/**
 * The six cross-service flows of #21, against the real stack through the API gateway.
 * Each scenario has its own Tutor, so their Sessions never overlap (BR-SC-01).
 */
import {
  addDays,
  compose,
  eventually,
  hook,
  newClass,
  newStudent,
  newTutor,
  nextPeriod,
  vnDate,
  vnInstant,
  type Client,
} from './support';

const DAY = 86_400_000;

/** A one-off future Session, once the Class has reached schedule-service (it is async). */
async function futureSession(tutor: Client, classId: string, daysAhead: number, time = '10:00') {
  return eventually(async () => {
    const date = addDays(vnDate(), daysAhead);
    const r = await tutor.post('/sessions', {
      classId,
      date,
      startTime: time,
      endTime: addMinutes(time, 90),
    });
    if (r.status !== 201) throw new Error(`session: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body as { id: string; date: string };
  });
}
function addMinutes(time: string, minutes: number) {
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + minutes;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}
const rosterOf = async (tutor: Client, sessionId: string) => {
  const r = await tutor.get(`/sessions/${sessionId}/attendance`);
  if (r.status !== 200) throw new Error(`sheet: ${r.status}`);
  return (r.body.students as { studentId: string }[]).map((s) => s.studentId);
};
const enrollmentOf = async (tutor: Client, classId: string, studentId: string) =>
  (
    (await tutor.get(`/classes/${classId}/students`)).body as {
      studentId: string;
      status: string;
    }[]
  ).find((e) => e.studentId === studentId);

describe('End-to-end: flows across services through the gateway (#21)', () => {
  test('1–2. Monthly Class: enroll → AWAITING_PAYMENT + Enrollment invoice + Roster; payment → ACTIVE', async () => {
    const tutor = await newTutor();
    const student = await newStudent(tutor);
    const cls = await newClass(tutor, 'MONTHLY', 1_200_000);
    const session = await futureSession(tutor, cls.id, 2);

    const enrolled = await eventually(async () => {
      const r = await tutor.post(`/classes/${cls.id}/enrollments`, { studentId: student.id });
      if (r.status !== 201) throw new Error(`enroll: ${r.status} ${JSON.stringify(r.body)}`);
      return r.body as { id: string; status: string; paymentDeadline: string };
    });
    expect(enrolled.status).toBe('AWAITING_PAYMENT');
    expect(new Date(enrolled.paymentDeadline).getTime() - Date.now()).toBeGreaterThan(6 * DAY);

    // Billing issued the Enrollment invoice (StudentEnrolled → billing).
    const invoice = await eventually(async () => {
      const r = await tutor.get(`/billing/enrollments/${enrolled.id}/invoice`);
      if (r.status !== 200) throw new Error(`invoice: ${r.status}`);
      return r.body as { id: string; kind: string; status: string; total: number; dueDate: string };
    });
    expect(invoice).toMatchObject({ kind: 'ENROLLMENT', status: 'ISSUED' });
    expect(invoice.total).toBeGreaterThan(0);
    expect(invoice.total).toBeLessThanOrEqual(1_200_000);

    // Schedule put the Student on the Roster and confirmed it (StudentEnrolled → EnrollmentConfirmed).
    await eventually(async () => expect(await rosterOf(tutor, session.id)).toContain(student.id));

    // 2. The Tutor records the payment in full → PaymentReceived → Class activates the Enrollment.
    const paid = await tutor.post(`/billing/invoices/${invoice.id}/payments`, {
      amount: invoice.total,
      method: 'CASH',
    });
    expect(paid.status).toBe(201);
    expect(paid.body.invoiceStatus).toBe('PAID');
    await eventually(async () =>
      expect((await enrollmentOf(tutor, cls.id, student.id))?.status).toBe('ACTIVE'),
    );
  });

  test('3. No payment for 7 days → WITHDRAWN (UNPAID), off the Roster of future Sessions', async () => {
    const tutor = await newTutor();
    const student = await newStudent(tutor);
    const cls = await newClass(tutor, 'MONTHLY', 900_000);
    const session = await futureSession(tutor, cls.id, 2);
    const enrolled = await eventually(async () => {
      const r = await tutor.post(`/classes/${cls.id}/enrollments`, { studentId: student.id });
      if (r.status !== 201) throw new Error(`enroll: ${r.status}`);
      return r.body as { id: string; status: string };
    });
    expect(enrolled.status).toBe('AWAITING_PAYMENT');
    await eventually(async () => expect(await rosterOf(tutor, session.id)).toContain(student.id));
    const invoice = await eventually(async () => {
      const r = await tutor.get(`/billing/enrollments/${enrolled.id}/invoice`);
      if (r.status !== 200) throw new Error(`invoice: ${r.status}`);
      return r.body as { id: string; total: number; status: string };
    });

    // The clock moves 8 days on: class-service's hourly job expires the unpaid Enrollment.
    const ran = await hook('class', 'jobs', { now: new Date(Date.now() + 8 * DAY).toISOString() });
    expect(ran.expired).toBeGreaterThanOrEqual(1);
    await eventually(async () =>
      expect(await enrollmentOf(tutor, cls.id, student.id)).toBeUndefined(),
    ); // no longer live
    const history = await tutor.get(`/students/${student.id}/classes`);
    expect(
      (history.body as { enrollmentId: string }[]).some((c) => c.enrollmentId === enrolled.id),
    ).toBe(false);

    // StudentWithdrawn → schedule takes the Student off the Roster of future Sessions.
    await eventually(async () =>
      expect(await rosterOf(tutor, session.id)).not.toContain(student.id),
    );
    // Billing never edits or deletes the Enrollment invoice (BR-BI-05).
    const after = await tutor.get(`/billing/invoices/${invoice.id}`);
    expect(after.body).toMatchObject({ id: invoice.id, total: invoice.total });
    expect(after.body.status).not.toBe('VOID');
  });

  test('4. Per-session: attend, close the month, correct → Adjustment on the next Invoice', async () => {
    const tutor = await newTutor();
    const student = await newStudent(tutor);
    const cls = await newClass(tutor, 'PER_SESSION', 250_000);
    const enrolled = await eventually(async () => {
      const r = await tutor.post(`/classes/${cls.id}/enrollments`, { studentId: student.id });
      if (r.status !== 201) throw new Error(`enroll: ${r.status}`);
      return r.body as { status: string };
    });
    expect(enrolled.status).toBe('ACTIVE');

    // A Session that started 10 minutes ago (the API only schedules the future).
    const session = await eventually(async () =>
      hook<{ id: string; date: string }>('schedule', 'sessions', {
        classId: cls.id,
        startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    );
    const period = session.date.slice(0, 7);
    await eventually(async () => expect(await rosterOf(tutor, session.id)).toContain(student.id));
    const record = await tutor.put(`/sessions/${session.id}/attendance`, {
      records: [{ studentId: student.id, status: 'PRESENT' }],
    });
    expect(record.status).toBe(200);

    // AttendanceRecorded → billing: a FEE line on the Student's DRAFT invoice for this month.
    const draft = await eventually(async () => {
      const list = await tutor.get(
        `/billing/invoices?period=${period}&kind=MONTHLY&studentId=${student.id}`,
      );
      const inv = (list.body as { id: string; total: number; status: string }[])[0];
      if (!inv || inv.total !== 250_000) throw new Error('no charge yet');
      return inv;
    });
    expect(draft.status).toBe('DRAFT');

    // 00:00 on the 1st of next month: the month closes and the invoice is issued.
    const next = nextPeriod(period);
    await hook('billing', 'close-month', { now: vnInstant(`${next}-01`, '00:01').toISOString() });
    const issued = (await tutor.get(`/billing/invoices/${draft.id}`)).body;
    expect(issued.status).toBe('ISSUED');

    // Corrected within 48h: PRESENT → EXCUSED. The issued invoice is never edited; the credit
    // is an Adjustment on next month's DRAFT (ADR-0002).
    const correct = await tutor.put(`/sessions/${session.id}/attendance`, {
      records: [{ studentId: student.id, status: 'EXCUSED' }],
    });
    expect(correct.status).toBe(200);
    const adjustment = await eventually(async () => {
      const list = await tutor.get(
        `/billing/invoices?period=${next}&kind=MONTHLY&studentId=${student.id}`,
      );
      const inv = (list.body as { id: string }[])[0];
      if (!inv) throw new Error('no next invoice yet');
      const detail = (await tutor.get(`/billing/invoices/${inv.id}`)).body;
      const line = detail.items.find((i: { type: string }) => i.type === 'ADJUSTMENT');
      if (!line) throw new Error('no adjustment yet');
      return { detail, line };
    });
    expect(adjustment.line).toMatchObject({
      amount: -250_000,
      sessionId: session.id,
      servicePeriod: period,
    });
    expect(adjustment.detail.status).toBe('DRAFT');
    const unchanged = (await tutor.get(`/billing/invoices/${draft.id}`)).body;
    expect(unchanged).toMatchObject({ status: 'ISSUED', total: 250_000 });
    expect(unchanged.items).toEqual(issued.items);
  });

  test('5. A rescheduled Session is counted once by Billing', async () => {
    const tutor = await newTutor();
    const cls = await newClass(tutor, 'MONTHLY', 1_000_000);
    const a = await futureSession(tutor, cls.id, 3, '09:00');
    await futureSession(tutor, cls.id, 4, '09:00');
    const from = vnDate();
    const to = addDays(from, 40);
    const count = (f = from, t = to) =>
      hook<{ count: number }>('billing', `session-count?classId=${cls.id}&from=${f}&to=${t}`).then(
        (r) => r.count,
      );
    await eventually(async () => expect(await count()).toBe(2));

    const moved = await tutor.post(`/sessions/${a.id}/reschedule`, {
      date: addDays(from, 6),
      startTime: '15:00',
      endTime: '16:30',
    });
    expect(moved.status).toBe(200);
    // SessionRescheduled → billing: old date no longer counted, new date counted, total still 2.
    await eventually(async () => {
      expect(await count(a.date, a.date)).toBe(0);
      expect(await count(addDays(from, 6), addDays(from, 6))).toBe(1);
    });
    expect(await count()).toBe(2);
  });

  test('6. student-service down → 202 PENDING; back up → the Enrollment completes', async () => {
    const tutor = await newTutor();
    const student = await newStudent(tutor);
    const cls = await newClass(tutor, 'PER_SESSION', 200_000);
    // Make sure the Class has reached the other services before the outage.
    await futureSession(tutor, cls.id, 2);

    compose('stop', 'student-service');
    try {
      const r = await tutor.post(`/classes/${cls.id}/enrollments`, { studentId: student.id });
      expect(r.status).toBe(202);
      expect(r.body.status).toBe('PENDING');
      expect((await enrollmentOf(tutor, cls.id, student.id))?.status).toBe('PENDING');
    } finally {
      compose('start', 'student-service');
    }
    compose('up', '-d', '--wait', 'student-service');

    // class-service re-checks PENDING Enrollments every minute; run that job now (retries ride
    // out the circuit breaker's cool-down after the outage).
    await eventually(
      async () => {
        await hook('class', 'jobs', { now: new Date().toISOString() });
        expect((await enrollmentOf(tutor, cls.id, student.id))?.status).toBe('ACTIVE');
      },
      90_000,
      3_000,
    );
  });
});
