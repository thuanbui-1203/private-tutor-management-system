import { Module } from '@nestjs/common';
import { ClassesController, InternalClassesController } from './classes.controller';
import { ClassesService } from './classes.service';

@Module({
  controllers: [ClassesController, InternalClassesController],
  providers: [ClassesService],
  exports: [ClassesService],
})
export class ClassesModule {}
