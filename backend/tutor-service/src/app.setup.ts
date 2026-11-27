import { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export const SERVICE_NAME = 'tutor-service';
export const DEFAULT_PORT = 3009;

/** Applies settings shared by main.ts and tests, so tests boot the app as production does. */
export function configureApp(app: INestApplication): void {
  app.enableShutdownHooks();
  // A credential carries its file as base64: 5 MB becomes about 6.7 MB of JSON.
  (app as NestExpressApplication).useBodyParser('json', { limit: '8mb' });
  const config = new DocumentBuilder().setTitle(SERVICE_NAME).setVersion('0.1.0').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
