import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { GatewayService } from './gateway/gateway.service';

export const SERVICE_NAME = 'api-gateway';
export const DEFAULT_PORT = 8080;

/**
 * Applies settings shared by main.ts and tests, so tests boot the app as production does.
 * Create the app with `bodyParser: false`: request bodies are streamed to the services.
 */
export function configureApp(app: INestApplication): void {
  app.enableShutdownHooks();
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(','),
    credentials: true,
    exposedHeaders: ['x-correlation-id', 'retry-after'],
  });
  app.use('/api', app.get(GatewayService).handle);
  const config = new DocumentBuilder().setTitle(SERVICE_NAME).setVersion('0.1.0').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
