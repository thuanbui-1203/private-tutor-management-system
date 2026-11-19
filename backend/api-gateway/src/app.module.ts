import { Module } from '@nestjs/common';
import { TmsCommonModule } from '@tms/common';
import { GatewayService } from './gateway/gateway.service';

// The gateway verifies Firebase ID tokens itself (#8), so the X-User-* guard is off here.
@Module({
  imports: [TmsCommonModule.forRoot({ service: 'api-gateway', auth: false })],
  providers: [GatewayService],
})
export class AppModule {}
