import { Module } from '@nestjs/common';
import { ClassesModule } from '../classes/classes.module';
import { EnrollmentsConsumers } from './enrollments.consumers';
import { EnrollmentsController } from './enrollments.controller';
import { EnrollmentsService } from './enrollments.service';
import { StudentClient } from './student.client';

@Module({
  imports: [ClassesModule],
  controllers: [EnrollmentsController],
  providers: [EnrollmentsService, EnrollmentsConsumers, StudentClient],
})
export class EnrollmentsModule {}
