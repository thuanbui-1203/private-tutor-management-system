import { Module } from '@nestjs/common';
import { prismaDatabase, TmsCommonModule } from '@tms/common';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

// Feature modules are added by the issues that own this service (see GitHub #1).
@Module({
  imports: [
    PrismaModule,
    TmsCommonModule.forRoot({
      service: 'student',
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        database: prismaDatabase(prisma),
        rabbitmqUrl: process.env.RABBITMQ_URL,
      }),
    }),
  ],
})
export class AppModule {}
