import { Logger } from '@nestjs/common';
import { InternalHttpClient } from '@tms/common';
import { InternalOpenClassesResponse } from '@tms/contracts';

/** Answers BR-CL-08: which open Classes a Tutor still owns. */
export interface OpenClassesChecker {
  openClassIds(tutorId: string): Promise<string[]>;
}

export const OPEN_CLASSES_CHECKER = Symbol('OPEN_CLASSES_CHECKER');

/** Asks class-service `GET /internal/tutors/{id}/open-classes`. */
export class ClassServiceOpenClassesChecker implements OpenClassesChecker {
  private readonly client: InternalHttpClient;

  constructor(baseUrl: string) {
    this.client = new InternalHttpClient(baseUrl);
  }

  async openClassIds(tutorId: string): Promise<string[]> {
    const res = await this.client.get(
      `/internal/tutors/${tutorId}/open-classes`,
      InternalOpenClassesResponse,
    );
    return res.classIds;
  }
}

/**
 * Used only when CLASS_SERVICE_URL is unset (e.g. running Identity alone): allows every
 * disable and warns once. docker-compose.yml sets CLASS_SERVICE_URL, so BR-CL-08 is enforced.
 */
export class NoOpenClassesStub implements OpenClassesChecker {
  private warned = false;

  async openClassIds(): Promise<string[]> {
    if (!this.warned) {
      new Logger('OpenClassesChecker').warn(
        'CLASS_SERVICE_URL not set: BR-CL-08 open-class check is skipped',
      );
      this.warned = true;
    }
    return [];
  }
}

export const openClassesCheckerProvider = {
  provide: OPEN_CLASSES_CHECKER,
  useFactory: (): OpenClassesChecker =>
    process.env.CLASS_SERVICE_URL
      ? new ClassServiceOpenClassesChecker(process.env.CLASS_SERVICE_URL)
      : new NoOpenClassesStub(),
};
