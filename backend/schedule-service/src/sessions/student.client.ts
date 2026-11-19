import { Injectable } from '@nestjs/common';
import { HttpError, InternalHttpClient } from '@tms/common';
import { InternalStudentAccessResponse, type StudentRelation } from '@tms/contracts';

/** student-service internal API (timeout 2 s, 2 retries, circuit breaker; docs/02 §1). */
@Injectable()
export class StudentClient {
  private readonly client = new InternalHttpClient(
    process.env.STUDENT_SERVICE_URL ?? 'http://student-service:3002',
  );

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
