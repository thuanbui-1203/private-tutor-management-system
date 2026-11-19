import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { z } from 'zod';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { Id } from '@tms/contracts';
import { EnrollmentsService } from './enrollments.service';

const EnrollBody = z.object({ studentId: Id });
const ChangeBody = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'WITHDRAWN']) });

@ApiTags('enrollments')
@Controller()
export class EnrollmentsController {
  constructor(private readonly enrollments: EnrollmentsService) {}

  /** 201 ACTIVE / AWAITING_PAYMENT, or 202 PENDING when student-service is unavailable. */
  @Roles('TUTOR', 'ADMIN')
  @Post('classes/:id/enrollments')
  async enroll(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) classId: string,
    @Body(new ZodBody(EnrollBody)) body: z.infer<typeof EnrollBody>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const { httpStatus, enrollment } = await this.enrollments.enroll(
      actor,
      classId,
      body.studentId,
    );
    res.status(httpStatus);
    return enrollment;
  }

  @Roles('TUTOR', 'ADMIN')
  @Patch('classes/:id/enrollments/:eid')
  change(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) classId: string,
    @Param('eid', ParseUUIDPipe) id: string,
    @Body(new ZodBody(ChangeBody)) body: z.infer<typeof ChangeBody>,
  ) {
    return this.enrollments.change(actor, classId, id, body.status);
  }

  /** Reached through the gateway's /students/{id}/classes exception route. */
  @Get('students/:studentId/classes')
  classesOf(@CurrentUser() actor: AuthUser, @Param('studentId', ParseUUIDPipe) studentId: string) {
    return this.enrollments.classesOf(actor, studentId);
  }
}
