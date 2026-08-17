import { z } from 'zod';

/**
 * Validates every environment variable the API needs at boot, mirroring
 * `.env.example`. Fails fast with a readable list of what's missing/wrong
 * rather than letting a `TypeError: undefined is not a function` surface
 * three modules deep the first time something tries to use a bad value.
 */
export const envSchema = z.object({
  // --- Database ---------------------------------------------------------
  DATABASE_URL: z.string().url(),
  DATABASE_MIGRATION_URL: z.string().url(),

  // --- Cache and queues ---------------------------------------------------
  REDIS_URL: z.string().url(),

  // --- Object storage -----------------------------------------------------
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: z.stringbool(),

  // --- Mail -----------------------------------------------------------------
  SMTP_URL: z.string().min(1),
  MAIL_FROM: z.string().min(1),

  // --- Auth -------------------------------------------------------------
  AUTH_SECRET: z
    .string()
    .min(32, 'AUTH_SECRET must be at least 32 characters (openssl rand -base64 32)'),

  // --- URLs ---------------------------------------------------------------
  APP_URL: z.string().url(),
  API_URL: z.string().url(),

  // --- Provider adapters --------------------------------------------------
  SMS_PROVIDER: z.string().min(1),
  WHATSAPP_PROVIDER: z.string().min(1),
  PAYMENTS_PROVIDER: z.string().min(1),

  // --- Observability ------------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  OTEL_ENABLED: z.stringbool().default(false),

  // --- Process (not in .env.example - sensible defaults for local dev) ----
  PORT: z.coerce.number().int().positive().default(3333),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

export type AppEnv = z.infer<typeof envSchema>;

/**
 * Used as `@nestjs/config`'s `validate` option. Throws a single, readable
 * error listing every missing/invalid variable - not a Zod stack trace -
 * so a misconfigured `.env` fails obviously at boot instead of causing a
 * confusing crash later.
 */
export function validateEnv(raw: Record<string, unknown>): AppEnv {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues.map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(
      [
        'Invalid or missing environment variables. Copy .env.example to .env and fill in real values, then retry:',
        ...issues,
      ].join('\n'),
    );
  }

  return result.data;
}
