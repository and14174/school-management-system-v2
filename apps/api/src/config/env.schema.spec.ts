import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.schema.js';

const validEnv = {
  DATABASE_URL: 'postgres://sms_app:dev@localhost:5432/sms',
  DATABASE_MIGRATION_URL: 'postgres://sms_owner:dev@localhost:5432/sms',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'sms-dev',
  S3_ACCESS_KEY: 'minioadmin',
  S3_SECRET_KEY: 'minioadmin',
  S3_FORCE_PATH_STYLE: 'true',
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'School Management System <no-reply@localhost>',
  AUTH_SECRET: 'a'.repeat(32),
  APP_URL: 'http://localhost:3000',
  API_URL: 'http://localhost:3333',
  SMS_PROVIDER: 'console',
  WHATSAPP_PROVIDER: 'console',
  PAYMENTS_PROVIDER: 'console',
  LOG_LEVEL: 'debug',
  OTEL_ENABLED: 'false',
};

describe('validateEnv', () => {
  it('accepts a complete, valid .env.example-shaped environment', () => {
    const result = validateEnv(validEnv);
    expect(result.DATABASE_URL).toBe(validEnv.DATABASE_URL);
    expect(result.S3_FORCE_PATH_STYLE).toBe(true);
    expect(result.OTEL_ENABLED).toBe(false);
  });

  it('defaults PORT and NODE_ENV when not provided', () => {
    const result = validateEnv(validEnv);
    expect(result.PORT).toBe(3333);
    expect(result.NODE_ENV).toBe('development');
  });

  it('rejects a missing required variable with a readable message, not a stack trace', () => {
    const { DATABASE_URL: _omit, ...rest } = validEnv;
    expect(() => validateEnv(rest)).toThrowError(/DATABASE_URL/);
  });

  it('rejects an AUTH_SECRET shorter than 32 characters', () => {
    expect(() => validateEnv({ ...validEnv, AUTH_SECRET: 'too-short' })).toThrowError(/AUTH_SECRET/);
  });

  it('rejects a malformed URL', () => {
    expect(() => validateEnv({ ...validEnv, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/);
  });

  it('lists every problem in one error, not just the first', () => {
    try {
      validateEnv({});
      expect.unreachable();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('REDIS_URL');
      expect(message).toContain('AUTH_SECRET');
    }
  });
});
