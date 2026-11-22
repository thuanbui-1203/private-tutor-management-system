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
  const trustProxy = process.env.TRUST_PROXY;
  if (trustProxy) {
    // Behind cloudflared or a reverse proxy, req.ip must come from X-Forwarded-For, or every
    // client shares the proxy's IP and its rate-limit bucket. Takes what Express takes:
    // a hop count ("1"), "true", or a subnet list such as "loopback, uniquelocal".
    const value = /^\d+$/.test(trustProxy)
      ? Number(trustProxy)
      : trustProxy === 'true' || trustProxy;
    (app.getHttpAdapter().getInstance() as { set(key: string, value: unknown): void }).set(
      'trust proxy',
      value,
    );
  }
  app.enableCors({
    origin: (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((o) => o.trim()),
    credentials: true,
    exposedHeaders: ['x-correlation-id', 'retry-after'],
  });
  app.use('/api', app.get(GatewayService).handle);
  const config = new DocumentBuilder().setTitle(SERVICE_NAME).setVersion('0.1.0').build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));
}
