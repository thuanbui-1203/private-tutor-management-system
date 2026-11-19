import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentUser, Public, Roles, ZodBody, type AuthUser } from '@tms/common';
import { ClassesService, CreateClass, UpdateClass } from './classes.service';

const ListQuery = z.object({ status: z.enum(['OPEN', 'CLOSED']).optional() });

@ApiTags('classes')
@Roles('TUTOR', 'ADMIN')
@Controller('classes')
export class ClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query(new ZodBody(ListQuery)) query: z.infer<typeof ListQuery>,
  ) {
    return this.classes.list(actor, query.status);
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body(new ZodBody(CreateClass)) body: CreateClass) {
    return this.classes.create(actor, body);
  }

  @Get(':id')
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.classes.owned(actor, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(UpdateClass)) body: UpdateClass,
  ) {
    return this.classes.update(actor, id, body);
  }

  @Post(':id/close')
  @HttpCode(HttpStatus.OK)
  close(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.classes.close(actor, id);
  }

  @Get(':id/students')
  students(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.classes.students(actor, id);
  }
}

/** Service-to-service; the gateway never routes /internal/**. */
@ApiTags('internal')
@Public()
@Controller('internal')
export class InternalClassesController {
  constructor(private readonly classes: ClassesService) {}

  @Get('tutors/:id/open-classes')
  openClasses(@Param('id', ParseUUIDPipe) tutorId: string) {
    return this.classes.openClasses(tutorId);
  }
}
