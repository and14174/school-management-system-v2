import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  readonly remaining: number;
}

/** Small port so a test can swap in a deterministic fake if it ever needs to - the real suite here uses the actual Redis (`docker-compose`'s), same reasoning as `@sms/documents`' `ObjectStorage`. */
export interface RateLimiter {
  consume(key: string): Promise<RateLimitResult>;
}

export const RATE_LIMITER = Symbol('RATE_LIMITER');

const WINDOW_SECONDS = 60;
const DEFAULT_LIMIT_PER_MINUTE = 60;

function requireRedisUrl(): string {
  const url = process.env.REDIS_URL;
  if (!url) {
    throw new Error("REDIS_URL is not set. Copy .env.example to .env before using @sms/public-api's RedisRateLimiter.");
  }
  return url;
}

function configuredLimit(): number {
  const raw = process.env.API_KEY_RATE_LIMIT_PER_MINUTE;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LIMIT_PER_MINUTE;
}

/**
 * Fixed-window (per-minute) rate limiter, one counter per API key id, backed
 * by the Redis already running in `infra/docker-compose.yml` (already wired
 * for health checks - see `apps/api/src/health/indicators/redis.health-indicator.ts`).
 *
 * FAIL-OPEN ON REDIS FAILURE - a deliberate, documented choice, not an
 * oversight. Rate limiting here is an ABUSE-PREVENTION layer, not the
 * primary security boundary: key validity (hash check), revocation,
 * expiry, tenant isolation (RLS) and the granted-permission subset check
 * all happen in Postgres inside `ApiKeysService`/`ApiKeyGuard` and do not
 * depend on Redis at all. If Redis is unreachable, EVERY machine
 * integration in EVERY tenant would otherwise go down at once because a
 * secondary, best-effort control lost its cache - that is a worse outcome
 * than temporarily allowing unthrottled (but still fully authenticated and
 * authorized) traffic through. Contrast `RedisHealthIndicator`, which
 * exists precisely so an operator is paged when Redis is down, rather than
 * this guard silently masking the outage from them.
 */
@Injectable()
export class RedisRateLimiter implements RateLimiter, OnModuleDestroy {
  private readonly logger = new Logger(RedisRateLimiter.name);
  private readonly client: Redis;
  private readonly limit: number;

  constructor() {
    this.client = new Redis(requireRedisUrl(), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // fail fast into the catch block below, not a retry storm
    });
    // A failed connect/command already surfaces via the try/catch in
    // consume(); avoid an unhandled 'error' event crashing the process while
    // disconnected/retrying - same pattern as RedisHealthIndicator.
    this.client.on('error', () => {});
    this.limit = configuredLimit();
  }

  async consume(key: string): Promise<RateLimitResult> {
    const windowIndex = Math.floor(Date.now() / (WINDOW_SECONDS * 1000));
    const redisKey = `public-api:ratelimit:${key}:${windowIndex}`;

    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        await this.client.connect();
      }
      const count = await this.client.incr(redisKey);
      if (count === 1) {
        await this.client.expire(redisKey, WINDOW_SECONDS);
      }
      return { allowed: count <= this.limit, limit: this.limit, remaining: Math.max(0, this.limit - count) };
    } catch (error) {
      this.logger.warn(
        `Redis unavailable for API key rate limiting - failing OPEN (see this class's own comment). ${error instanceof Error ? error.message : String(error)}`,
      );
      return { allowed: true, limit: this.limit, remaining: this.limit };
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
