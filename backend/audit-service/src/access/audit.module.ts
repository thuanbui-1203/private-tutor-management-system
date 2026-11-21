import { Module } from '@nestjs/common';
import { AccessLogConsumer } from './access-log.consumer';
import { AccessLogStore } from './access-log.store';
import { AuditController } from './audit.controller';
import { ChangeFanOut } from './change-fan-out';

@Module({
  controllers: [AuditController],
  providers: [AccessLogStore, AccessLogConsumer, ChangeFanOut],
})
export class AuditModule {}
