import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Roles } from '@tms/common';
import { Id, InternalAuditQuery, IsoDateTime } from '@tms/contracts';
import { z } from 'zod';
import { AccessLogStore } from './access-log.store';
import { ChangeFanOut } from './change-fan-out';

const AccessQuery = z.object({
  userId: Id.optional(),
  correlationId: Id.optional(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD']).optional(),
  status: z.coerce.number().int().min(0).max(599).optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

function parse<T>(schema: z.ZodType<T>, query: unknown): T {
  const result = schema.safeParse(query);
  if (!result.success) throw new BadRequestException(result.error.issues);
  return result.data;
}

/** The audit trail for Admins (ADR-0005). */
@ApiTags('audit')
@Roles('ADMIN')
@Controller('audit')
export class AuditController {
  constructor(
    private readonly store: AccessLogStore,
    private readonly changes: ChangeFanOut,
  ) {}

  /** Access records, newest first; `nextCursor` fetches the next page. */
  @Get('access')
  access(@Query() query: Record<string, unknown>) {
    return this.store.list(parse(AccessQuery, query));
  }

  /** Change records of every service, merged newest first; `unavailable` lists services that did not answer. */
  @Get('changes')
  changesOf(@Query() query: Record<string, unknown>) {
    return this.changes.query(parse(InternalAuditQuery, query));
  }
}
