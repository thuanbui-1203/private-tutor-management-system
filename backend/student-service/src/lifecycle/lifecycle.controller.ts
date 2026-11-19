import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Roles, ZodBody, type AuthUser } from '@tms/common';
import { LifecycleService } from './lifecycle.service';

const ChangeStatus = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'GRADUATED', 'DROPPED']) });

@ApiTags('students')
@Controller('students')
export class LifecycleController {
  constructor(private readonly lifecycle: LifecycleService) {}

  /** Status change along the state diagram; forbidden transitions → 409. */
  @Roles('TUTOR', 'ADMIN')
  @Post(':id/status')
  @HttpCode(HttpStatus.OK)
  changeStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(ChangeStatus)) body: z.infer<typeof ChangeStatus>,
  ) {
    return this.lifecycle.changeStatus(actor, id, body.status);
  }

  /** Anonymisation, never a hard delete (BR-ST-08). */
  @Roles('ADMIN')
  @Delete(':id')
  anonymise(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.lifecycle.anonymise(actor, id);
  }
}
