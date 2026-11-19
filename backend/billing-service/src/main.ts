import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { JsonLogger } from '@tms/common';
import { AppModule } from './app.module';
import { configureApp, DEFAULT_PORT, SERVICE_NAME } from './app.setup';

async function bootstrap(): Promise<void> {
  const logger = new JsonLogger(SERVICE_NAME);
  const app = await NestFactory.create(AppModule, { logger });
  configureApp(app);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  logger.log(`listening on ${port}, docs at /docs`, 'Bootstrap');
}

void bootstrap();
