import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { ScheduleInput, SchedulesService } from './schedules.service';

const ListQuery = z.object({ classId: z.uuid().optional() });

@ApiTags('schedules')
@Roles('TUTOR', 'ADMIN')
@Controller('schedules')
export class SchedulesController {
  constructor(private readonly schedules: SchedulesService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query(new ZodBody(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    return this.schedules.list(actor, query.classId);
  }

  /** The Sessions a Schedule would create and their conflicts; writes nothing. */
  @Post('preview')
  @HttpCode(HttpStatus.OK)
  preview(@CurrentUser() actor: AuthUser, @Body(new ZodBody(ScheduleInput)) body: ScheduleInput) {
    return this.schedules.preview(actor, body);
  }

  /** 201, or 409 with the conflicts (BR-SC-01) unless skipConflicts. */
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body(new ZodBody(ScheduleInput)) body: ScheduleInput) {
    return this.schedules.create(actor, body);
  }

  /** Ends the Schedule (it is immutable, BR-SC-07) and cancels its future Sessions. */
  @Delete(':id')
  end(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.schedules.end(actor, id);
  }
}
