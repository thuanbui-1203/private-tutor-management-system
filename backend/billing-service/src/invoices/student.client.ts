import { Injectable } from '@nestjs/common';
import { HttpError, InternalHttpClient } from '@tms/common';
import { InternalStudentAccessResponse } from '@tms/contracts';

/** student-service internal API (timeout 2 s, 2 retries, circuit breaker; docs/02 §1). */
@Injectable()
export class StudentClient {
  private readonly client = new InternalHttpClient(
    process.env.STUDENT_SERVICE_URL ?? 'http://student-service:3002',
  );

  /** How `userId` relates to the Student; null relation when unknown. Throws when unavailable. */
  async access(studentId: string, userId: string): Promise<InternalStudentAccessResponse> {
    try {
      return await this.client.get(
        `/internal/students/${studentId}/access?userId=${userId}`,
        InternalStudentAccessResponse,
      );
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) {
        return { studentId, userId, relation: null, isPayer: false };
      }
      throw err;
    }
  }
}
