import { Module } from '@nestjs/common';
import { prismaDatabase, TmsCommonModule } from '@tms/common';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { SchedulesModule } from './schedules/schedules.module';
import { SessionsModule } from './sessions/sessions.module';
import { AttendanceModule } from './attendance/attendance.module';

@Module({
  imports: [
    PrismaModule,
    TmsCommonModule.forRoot({
      service: 'schedule',
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        database: prismaDatabase(prisma),
        rabbitmqUrl: process.env.RABBITMQ_URL,
      }),
    }),
    SchedulesModule,
    SessionsModule,
    AttendanceModule,
  ],
})
export class AppModule {}
