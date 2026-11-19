import { UnprocessableEntityException } from '@nestjs/common';

/** Today's date in Vietnam (BR-SYS-02), as YYYY-MM-DD. */
export function todayInVietnam(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
}

/** Whole years between a date of birth and `today` (both YYYY-MM-DD). */
export function ageOn(dob: string, today: string): number {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

export const isMinor = (dob: string, today = todayInVietnam()) => ageOn(dob, today) < 18;

export type PayerKind = 'PRIMARY_PARENT' | 'SELF';

/**
 * BR-ST-04 / BR-ST-05: a minor needs a primary Parent and that Parent pays; an adult
 * may pay themselves (and then needs an email, so Billing can reach them). The Payer
 * never switches by itself when a Student turns 18.
 */
export function checkPayer(input: {
  dob: string;
  payer: PayerKind;
  hasPrimaryParent: boolean;
  email?: string | null;
}): void {
  if (isMinor(input.dob)) {
    if (!input.hasPrimaryParent) {
      throw new UnprocessableEntityException(
        'a Student under 18 needs a primary Parent (BR-ST-04)',
      );
    }
    if (input.payer !== 'PRIMARY_PARENT') {
      throw new UnprocessableEntityException("a minor's Payer is the primary Parent (BR-ST-05)");
    }
  }
  if (input.payer === 'PRIMARY_PARENT' && !input.hasPrimaryParent) {
    throw new UnprocessableEntityException('Payer is the primary Parent, but there is none');
  }
  if (input.payer === 'SELF' && !input.email) {
    throw new UnprocessableEntityException('a Student who pays for themselves needs an email');
  }
}

/** At most one primary Parent (BR-ST-06). */
export function checkSinglePrimary(parents: { isPrimary: boolean }[]): void {
  if (parents.filter((p) => p.isPrimary).length > 1) {
    throw new UnprocessableEntityException('a Student has exactly one primary Parent (BR-ST-06)');
  }
}
