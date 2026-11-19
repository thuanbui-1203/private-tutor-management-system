import { Module } from '@nestjs/common';
import { E2eHooksModule } from './e2e/e2e-hooks.module';
import { prismaDatabase, TmsCommonModule } from '@tms/common';
import { ClassesModule } from './classes/classes.module';
import { EnrollmentsModule } from './enrollments/enrollments.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';

@Module({
  imports: [
    PrismaModule,
    TmsCommonModule.forRoot({
      service: 'class',
      imports: [PrismaModule],
      inject: [PrismaService],
      useFactory: (prisma: PrismaService) => ({
        database: prismaDatabase(prisma),
        rabbitmqUrl: process.env.RABBITMQ_URL,
      }),
    }),
    ClassesModule,
    EnrollmentsModule,
    // Test-only hooks for the end-to-end suite (#21); off unless E2E_HOOKS=true.
    ...(process.env.E2E_HOOKS === 'true' ? [E2eHooksModule] : []),
  ],
})
export class AppModule {}
