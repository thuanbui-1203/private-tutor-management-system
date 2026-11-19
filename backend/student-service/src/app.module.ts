import { Module } from '@nestjs/common';
import { prismaDatabase, TmsCommonModule } from '@tms/common';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { PrismaModule } from './prisma/prisma.module';
import { PrismaService } from './prisma/prisma.service';
import { StudentsModule } from './students/students.module';

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
    StudentsModule,
    LifecycleModule,
  ],
})
export class AppModule {}
