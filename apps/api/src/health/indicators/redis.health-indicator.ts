import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import Redis from 'ioredis';
import type { AppEnv } from '../../config/env.schema.js';

/** Genuinely PINGs Redis - not just "is the URL well-formed". */
@Injectable()
export class RedisHealthIndicator implements OnModuleDestroy {
  private readonly client: Redis;

  constructor(
    @Inject(HealthIndicatorService) private readonly healthIndicatorService: HealthIndicatorService,
    @Inject(ConfigService) configService: ConfigService<AppEnv, true>,
  ) {
    this.client = new Redis(configService.get('REDIS_URL', { infer: true }), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // a health check should fail fast, not keep retrying
    });
    // A failed PING already surfaces via isHealthy(); avoid an unhandled
    // 'error' event crashing the process while disconnected/retrying.
    this.client.on('error', () => {});
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      if (this.client.status === 'wait' || this.client.status === 'end') {
        await this.client.connect();
      }
      const pong = await this.client.ping();

      if (pong !== 'PONG') {
        return indicator.down({ message: `unexpected PING response: ${pong}` });
      }
      return indicator.up();
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.message : 'unknown error' });
    }
  }

  onModuleDestroy(): void {
    this.client.disconnect();
  }
}
