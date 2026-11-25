import { Module } from '@nestjs/common';
import { CopiesModule } from '../copies/copies.module';
import { WorkService } from './work.service';

/** On its own so ChargesModule (which consumes Attendance events) can use it without a cycle. */
@Module({
  imports: [CopiesModule],
  providers: [WorkService],
  exports: [WorkService],
})
export class WorkModule {}
