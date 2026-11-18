import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp, DEFAULT_PORT, SERVICE_NAME } from './app.setup';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  await app.listen(port);
  Logger.log(`${SERVICE_NAME} listening on ${port}, docs at /docs`, 'Bootstrap');
}

void bootstrap();
