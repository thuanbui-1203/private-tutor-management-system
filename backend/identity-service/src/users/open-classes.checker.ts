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
 * TODO(#11): class-service does not expose /internal/tutors/{id}/open-classes yet.
 * Until it does, CLASS_SERVICE_URL stays unset and this stub allows every disable.
 * Once #11 lands, set CLASS_SERVICE_URL for identity-service in docker-compose.yml.
 */
export class NoOpenClassesStub implements OpenClassesChecker {
  private warned = false;

  async openClassIds(): Promise<string[]> {
    if (!this.warned) {
      new Logger('OpenClassesChecker').warn(
        'CLASS_SERVICE_URL not set: BR-CL-08 open-class check is stubbed (see #11)',
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
