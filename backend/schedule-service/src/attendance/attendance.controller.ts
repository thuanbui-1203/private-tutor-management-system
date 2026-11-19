import { Body, Controller, Get, Param, ParseUUIDPipe, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { AttendanceInput, AttendanceService, HistoryQuery } from './attendance.service';

@ApiTags('attendance')
@Controller()
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  /** The Tutor's sheet: the day's Roster with current statuses and the edit deadline. */
  @Get('sessions/:id/attendance')
  @Roles('TUTOR', 'ADMIN')
  sheet(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.attendance.sheet(actor, id);
  }

  /** Record, or correct within 48h (BR-SC-02/03/09); 409 when not started, cancelled or locked. */
  @Put('sessions/:id/attendance')
  @Roles('TUTOR', 'ADMIN')
  record(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(AttendanceInput)) body: AttendanceInput,
  ) {
    return this.attendance.record(actor, id, body);
  }

  /** One Student's Attendance for a month; never other Students' data (BR-SC-10). */
  @Get('students/:id/attendance')
  @Roles('TUTOR', 'ADMIN', 'PARENT', 'STUDENT')
  history(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodBody(HistoryQuery)) query: HistoryQuery,
  ) {
    return this.attendance.history(actor, id, query);
  }
}
