import { Inject, Injectable } from '@nestjs/common';
import { HealthIndicatorService, type HealthIndicatorResult } from '@nestjs/terminus';
import { getAppSqlClient } from '@sms/db';

/**
 * Genuinely exercises the connection the API serves traffic on (`sms_app`,
 * `DATABASE_URL`): `select 1` proves the socket/auth work, then reading the
 * seeded row from `platform.schema_version` (written by the first
 * migration) proves the schema is actually migrated and `sms_app` has the
 * grants it needs - not just that Postgres is reachable.
 */
@Injectable()
export class PostgresHealthIndicator {
  // Explicit @Inject(): see health.controller.ts for why.
  constructor(@Inject(HealthIndicatorService) private readonly healthIndicatorService: HealthIndicatorService) {}

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const indicator = this.healthIndicatorService.check(key);

    try {
      const sql = getAppSqlClient();
      await sql`select 1`;

      const rows = await sql<{ version: string }[]>`
        select version from platform.schema_version where id = 1
      `;
      const version = rows[0]?.version;

      if (!version) {
        return indicator.down({ message: 'platform.schema_version has no seeded row - has db:migrate run?' });
      }

      return indicator.up({ schemaVersion: version });
    } catch (error) {
      return indicator.down({ message: error instanceof Error ? error.message : 'unknown error' });
    }
  }
}
