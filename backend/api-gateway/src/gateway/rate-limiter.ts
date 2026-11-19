import { Logger } from '@nestjs/common';
import Redis from 'ioredis';

export interface RateDecision {
  allowed: boolean;
  /** Seconds until the window resets. */
  retryAfter: number;
}

/**
 * Fixed one-minute windows in Redis (INCR + EXPIRE), per IP before auth and per
 * user after. If Redis is unreachable it fails open: rate limiting must not take
 * the whole API down.
 */
export class RateLimiter {
  private readonly logger = new Logger(RateLimiter.name);
  private readonly redis?: Redis;

  constructor(
    redisUrl: string | undefined,
    private readonly prefix: string,
    private readonly perIpPerMinute: number,
    private readonly perUserPerMinute: number,
  ) {
    if (redisUrl) {
      // Queue commands while (re)connecting, but give up after 200 ms so a Redis outage
      // costs each request at most that before failing open.
      this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, commandTimeout: 200 });
      this.redis.on('error', () => undefined); // reported per request below
    }
  }

  forIp(ip: string): Promise<RateDecision> {
    return this.hit(`ip:${ip}`, this.perIpPerMinute);
  }

  forUser(userId: string): Promise<RateDecision> {
    return this.hit(`user:${userId}`, this.perUserPerMinute);
  }

  private async hit(key: string, limit: number): Promise<RateDecision> {
    const window = Math.floor(Date.now() / 60_000);
    const retryAfter = 60 - Math.floor((Date.now() % 60_000) / 1000);
    if (!this.redis) return { allowed: true, retryAfter };
    try {
      const redisKey = `${this.prefix}:${key}:${window}`;
      const [[, count]] = (await this.redis.multi().incr(redisKey).expire(redisKey, 61).exec()) as [
        [Error | null, number],
      ];
      return { allowed: count <= limit, retryAfter };
    } catch (err) {
      this.logger.warn(`rate limiting skipped, Redis unavailable: ${(err as Error).message}`);
      return { allowed: true, retryAfter };
    }
  }

  async close(): Promise<void> {
    await this.redis?.quit().catch(() => undefined);
  }
}
