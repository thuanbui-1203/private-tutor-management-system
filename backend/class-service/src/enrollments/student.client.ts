import { Injectable } from '@nestjs/common';
import { HttpError, InternalHttpClient } from '@tms/common';
import {
  InternalStudentAccessResponse,
  InternalStudentResponse,
  type StudentRelation,
} from '@tms/contracts';

export type StudentLookup =
  | { kind: 'found'; student: InternalStudentResponse }
  | { kind: 'not-found' }
  /** Timed out, unreachable, 5xx after retries, or circuit open: enroll as PENDING. */
  | { kind: 'unavailable' };

/** student-service internal API (timeout 2 s, 2 retries, circuit breaker; docs/02 §1). */
@Injectable()
export class StudentClient {
  private readonly client = new InternalHttpClient(
    process.env.STUDENT_SERVICE_URL ?? 'http://student-service:3002',
  );

  async lookup(studentId: string): Promise<StudentLookup> {
    try {
      const student = await this.client.get(
        `/internal/students/${studentId}`,
        InternalStudentResponse,
      );
      return { kind: 'found', student };
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return { kind: 'not-found' };
      if (err instanceof HttpError) throw err;
      return { kind: 'unavailable' };
    }
  }

  /** How `userId` relates to the Student (null = may not see it); throws when unavailable. */
  async relation(studentId: string, userId: string): Promise<StudentRelation | null> {
    try {
      const res = await this.client.get(
        `/internal/students/${studentId}/access?userId=${userId}`,
        InternalStudentAccessResponse,
      );
      return res.relation;
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null;
      throw err;
    }
  }
}
