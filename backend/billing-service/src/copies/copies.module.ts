import { Module } from '@nestjs/common';
import { CopiesService } from './copies.service';

@Module({
  providers: [CopiesService],
  exports: [CopiesService],
})
export class CopiesModule {}
