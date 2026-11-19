import { Module } from '@nestjs/common';
import { TmsCommonModule } from '@tms/common';

// The gateway verifies Firebase ID tokens itself (#8), so the X-User-* guard is off here.
@Module({
  imports: [TmsCommonModule.forRoot({ service: 'api-gateway', auth: false })],
})
export class AppModule {}
