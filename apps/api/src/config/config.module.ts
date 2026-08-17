import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.schema.js';

// __dirname is repo-root/apps/api/src/config at dev time (tsx) and
// repo-root/apps/api/dist/config after `tsc` build - both 4 levels below
// the repo root, so this resolves correctly either way. Computed relative
// to this file (not process.cwd()) since @sms/api's scripts are commonly
// invoked with the repo root as cwd (`pnpm dev`) as well as apps/api as
// cwd (`pnpm --filter @sms/api dev`).
const repoRootEnvFile = join(__dirname, '..', '..', '..', '..', '.env');

/**
 * Wraps `@nestjs/config` with the Zod validation from `env.schema.ts`.
 * Global, so `ConfigService<AppEnv, true>` can be injected anywhere
 * without re-importing this module.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [repoRootEnvFile],
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
