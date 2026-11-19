import { Module } from '@nestjs/common';
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
  ],
})
export class AppModule {}
