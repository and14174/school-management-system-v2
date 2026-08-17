import { Controller, Get, Inject } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiTags } from '@nestjs/swagger';
import { Public } from '@sms/identity';
import { PostgresHealthIndicator } from './indicators/postgres.health-indicator.js';
import { RedisHealthIndicator } from './indicators/redis.health-indicator.js';

// @Public(): health checks run before there is any session to check (load
// balancers, uptime monitors) - see AuthGuard, registered globally in
// AppModule, for what this opts out of.
@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  // Explicit @Inject() on every param: under tsx/esbuild's decorator
  // metadata emission, implicit type-based DI for @nestjs/terminus classes
  // was observed to resolve to undefined at runtime (see the same fix in
  // RedisHealthIndicator) even though `tsc --noEmit` type-checks cleanly -
  // esbuild's emitDecoratorMetadata support has known gaps tsc doesn't
  // have. Explicit tokens sidestep it entirely.
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(PostgresHealthIndicator) private readonly postgres: PostgresHealthIndicator,
    @Inject(RedisHealthIndicator) private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  check() {
    return this.health.check([
      () => this.postgres.isHealthy('postgres'),
      () => this.redis.isHealthy('redis'),
    ]);
  }
}
