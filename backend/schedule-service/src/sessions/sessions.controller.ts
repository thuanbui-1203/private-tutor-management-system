import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import {
  CancelInput,
  RescheduleInput,
  SessionInput,
  SessionQuery,
  SessionsService,
} from './sessions.service';

@ApiTags('sessions')
@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  /** Calendar view; Parents / Students pass `studentId`. */
  @Get()
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  list(@CurrentUser() actor: AuthUser, @Query(new ZodBody(SessionQuery)) query: SessionQuery) {
    return this.sessions.list(actor, query);
  }

  /** One-off Session or Makeup session (`makeupOf`); 409 on overlap (BR-SC-01). */
  @Post()
  @Roles('TUTOR', 'ADMIN')
  create(@CurrentUser() actor: AuthUser, @Body(new ZodBody(SessionInput)) body: SessionInput) {
    return this.sessions.create(actor, body);
  }

  @Post(':id/start')
  @Roles('TUTOR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  start(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.sessions.start(actor, id);
  }

  @Post(':id/cancel')
  @Roles('TUTOR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  cancel(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(CancelInput)) body: CancelInput,
  ) {
    return this.sessions.cancel(actor, id, body);
  }

  /** Publishes one SessionRescheduled (not a cancel + schedule pair). */
  @Post(':id/reschedule')
  @Roles('TUTOR', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  reschedule(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(RescheduleInput)) body: RescheduleInput,
  ) {
    return this.sessions.reschedule(actor, id, body);
  }
}
