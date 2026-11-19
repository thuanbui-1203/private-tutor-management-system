import { ConflictException, Logger } from '@nestjs/common';
import { InternalHttpClient } from '@tms/common';
import { InternalOpenInvoicesResponse } from '@tms/contracts';

export type StudentStatus = 'ACTIVE' | 'PAUSED' | 'GRADUATED' | 'DROPPED';

/** docs/diagrams/09-state-lifecycle.puml "Student". GRADUATED is final. */
const ALLOWED: Record<StudentStatus, StudentStatus[]> = {
  ACTIVE: ['PAUSED', 'GRADUATED', 'DROPPED'],
  PAUSED: ['ACTIVE', 'DROPPED'],
  DROPPED: ['ACTIVE'],
  GRADUATED: [],
};

export function checkTransition(from: StudentStatus, to: StudentStatus): void {
  if (!ALLOWED[from].includes(to)) {
    throw new ConflictException(`a ${from} Student cannot become ${to}`);
  }
}

/** BR-ST-02 */
export const PAUSE_LIMIT_DAYS = 60;

/** Answers BR-ST-08: which Invoices of a Student are not yet PAID or VOID. */
export interface OpenInvoicesChecker {
  openInvoiceIds(studentId: string): Promise<string[]>;
}

export const OPEN_INVOICES_CHECKER = Symbol('OPEN_INVOICES_CHECKER');

/** Asks billing-service `GET /internal/students/{id}/open-invoices`. */
export class BillingOpenInvoicesChecker implements OpenInvoicesChecker {
  private readonly client: InternalHttpClient;

  constructor(baseUrl: string) {
    this.client = new InternalHttpClient(baseUrl);
  }

  async openInvoiceIds(studentId: string): Promise<string[]> {
    const res = await this.client.get(
      `/internal/students/${studentId}/open-invoices`,
      InternalOpenInvoicesResponse,
    );
    return res.invoiceIds;
  }
}

/**
 * Used only when BILLING_SERVICE_URL is unset (host-run tests without billing); docker
 * compose sets it, so the real check against billing-service runs there.
 */
export class NoOpenInvoicesStub implements OpenInvoicesChecker {
  private warned = false;

  async openInvoiceIds(): Promise<string[]> {
    if (!this.warned) {
      new Logger('OpenInvoicesChecker').warn(
        'BILLING_SERVICE_URL not set: BR-ST-08 open-invoice check is stubbed',
      );
      this.warned = true;
    }
    return [];
  }
}

export const openInvoicesCheckerProvider = {
  provide: OPEN_INVOICES_CHECKER,
  useFactory: (): OpenInvoicesChecker =>
    process.env.BILLING_SERVICE_URL
      ? new BillingOpenInvoicesChecker(process.env.BILLING_SERVICE_URL)
      : new NoOpenInvoicesStub(),
};
