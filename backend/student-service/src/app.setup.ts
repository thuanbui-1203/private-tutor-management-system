import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SERVICE_NAME = 'student-service';
export const DEFAULT_PORT = 3002;

/** Applies settings shared by main.ts and tests, so tests boot the app as production does. */
export function configureApp(app: INestApplication): void {
  app.enableShutdownHooks();
  const config = new DocumentBuilder().setTitle(SERVICE_NAME).setVersion('0.1.0').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
