import type { LoggerService } from '@nestjs/common';
import { currentCorrelationId } from './correlation';

export type Logger = Pick<LoggerService, 'log' | 'error' | 'warn'>;

const LEVELS = ['error', 'warn', 'info', 'debug', 'verbose'] as const;
type Level = (typeof LEVELS)[number];

/**
 * One JSON line per log entry, with the service name and the current correlation
 * id, so `docker compose logs | grep <correlationId>` follows a request across
 * services (docs/03 §7). Level comes from LOG_LEVEL (default `info`).
 */
export class JsonLogger implements LoggerService {
  private readonly maxLevel: number;

  constructor(
    private readonly service: string,
    level: string = process.env.LOG_LEVEL ?? 'info',
  ) {
    const index = LEVELS.indexOf(level as Level);
    this.maxLevel = index === -1 ? LEVELS.indexOf('info') : index;
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }
  error(message: unknown, traceOrContext?: string, context?: string): void {
    // Nest calls error(message, stack, context) or error(message, context).
    const [trace, ctx] =
      context === undefined ? [undefined, traceOrContext] : [traceOrContext, context];
    this.write('error', message, ctx, trace);
  }
  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }
  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }
  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(level: Level, message: unknown, context?: string, trace?: string): void {
    if (LEVELS.indexOf(level) > this.maxLevel) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      service: this.service,
      context,
      correlationId: currentCorrelationId(),
      msg: message instanceof Error ? message.message : message,
      trace,
    };
    const stream = level === 'error' ? process.stderr : process.stdout;
    stream.write(JSON.stringify(entry) + '\n');
  }
}
