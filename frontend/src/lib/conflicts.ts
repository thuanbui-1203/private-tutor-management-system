import { ApiError, describeError } from './api';
import { formatDate } from './format';
import type { Conflict } from './types';

/** The overlap list a 409 carries (BR-SC-01), in Vietnamese. */
export function conflictText(err: unknown, classNames: Map<string, string>): string {
  const conflicts = (err as ApiError)?.body as { conflicts?: Conflict[] } | undefined;
  if (err instanceof ApiError && err.status === 409 && conflicts?.conflicts?.length) {
    const list = conflicts.conflicts
      .map(
        (c) =>
          `${formatDate(c.date)} ${c.startTime}–${c.endTime} trùng với lớp ${classNames.get(c.conflictsWith.classId) ?? '(khác)'} ${c.conflictsWith.startTime}–${c.conflictsWith.endTime}`,
      )
      .join('; ');
    return `Trùng giờ với buổi khác của bạn (BR-SC-01): ${list}.`;
  }
  return describeError(err);
}
