import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { z } from 'zod';
import { CurrentUser, Public, Roles, ZodBody, type AuthUser } from '@tms/common';
import { ParentsService } from './parents.service';
import {
  CreateStudent,
  ListStudents,
  NewParent,
  ParentLink,
  UpdateParent,
  UpdateStudent,
} from './schemas';
import { StudentsService } from './students.service';

@ApiTags('students')
@Controller('students')
export class StudentsController {
  constructor(private readonly students: StudentsService) {}

  @Roles('TUTOR', 'ADMIN')
  @Get()
  list(
    @CurrentUser() actor: AuthUser,
    @Query(new ZodBody(ListStudents)) query: z.infer<typeof ListStudents>,
  ) {
    return this.students.list(actor, query);
  }

  @Roles('TUTOR', 'ADMIN')
  @Post()
  create(@CurrentUser() actor: AuthUser, @Body(new ZodBody(CreateStudent)) body: CreateStudent) {
    return this.students.create(actor, body);
  }

  /** Tutor (owner) or Admin see everything; Parents their children; a Student themselves. Others 404. */
  @Get(':id')
  get(@CurrentUser() actor: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.students.get(actor, id);
  }

  @Roles('TUTOR', 'ADMIN')
  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(UpdateStudent)) body: UpdateStudent,
  ) {
    return this.students.update(actor, id, body);
  }

  @Roles('TUTOR', 'ADMIN')
  @Post(':id/parents')
  addParent(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(ParentLink)) link: ParentLink,
  ) {
    return this.students.addParent(actor, id, link);
  }

  @Roles('TUTOR', 'ADMIN')
  @Delete(':id/parents/:parentId')
  removeParent(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('parentId', ParseUUIDPipe) parentId: string,
  ) {
    return this.students.removeParent(actor, id, parentId);
  }
}

@ApiTags('parents')
@Controller('parents')
export class ParentsController {
  constructor(private readonly parents: ParentsService) {}

  @Roles('PARENT')
  @Get('me/children')
  myChildren(@CurrentUser() actor: AuthUser) {
    return this.parents.myChildren(actor);
  }

  @Roles('TUTOR', 'ADMIN')
  @Post()
  create(
    @CurrentUser() actor: AuthUser,
    @Body(new ZodBody(NewParent)) body: z.infer<typeof NewParent>,
  ) {
    return this.parents.create(actor, body);
  }

  @Roles('TUTOR', 'ADMIN')
  @Patch(':id')
  update(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodBody(UpdateParent)) body: z.infer<typeof UpdateParent>,
  ) {
    return this.parents.update(actor, id, body);
  }
}

/** Service-to-service; the gateway never routes /internal/**. */
@ApiTags('internal')
@Public()
@Controller('internal/students')
export class InternalStudentsController {
  constructor(private readonly students: StudentsService) {}

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.students.internal(id);
  }

  /** InternalStudentAccessResponse: the caller's relation to the Student, or null. */
  @Get(':id/access')
  access(@Param('id', ParseUUIDPipe) id: string, @Query('userId', ParseUUIDPipe) userId: string) {
    return this.students.access(id, userId);
  }
}
