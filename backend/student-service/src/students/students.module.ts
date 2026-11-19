import { Module } from '@nestjs/common';
import { IdentityClient } from './identity.client';
import { ParentsService } from './parents.service';
import {
  InternalStudentsController,
  ParentsController,
  StudentsController,
} from './students.controller';
import { StudentsService } from './students.service';
import { UserLinker } from './user-linker';

@Module({
  controllers: [StudentsController, ParentsController, InternalStudentsController],
  providers: [StudentsService, ParentsService, IdentityClient, UserLinker],
  exports: [StudentsService],
})
export class StudentsModule {}
