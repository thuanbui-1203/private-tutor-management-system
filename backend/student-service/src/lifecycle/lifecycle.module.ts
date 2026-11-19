import { Module } from '@nestjs/common';
import { StudentsModule } from '../students/students.module';
import { openInvoicesCheckerProvider } from './lifecycle';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';

@Module({
  imports: [StudentsModule],
  controllers: [LifecycleController],
  providers: [LifecycleService, openInvoicesCheckerProvider],
})
export class LifecycleModule {}
