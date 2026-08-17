import 'reflect-metadata';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { IncomingMessage } from 'node:http';
import { newId } from '@sms/kernel';
import { cleanupOpenApiDoc, ZodValidationPipe } from 'nestjs-zod';
import { Logger } from 'nestjs-pino';
import { getAuth, mountAuthHandler } from '@sms/identity';
import { AppModule } from './app.module.js';
import type { AppEnv } from './config/env.schema.js';

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // Honour an incoming x-request-id (useful behind a gateway/LB that
    // already assigns one); otherwise mint a fresh UUIDv7. nestjs-pino and
    // TenantContextInterceptor both read this same request.id afterwards,
    // so one id ties the log lines, the tenant context and any error
    // envelope together.
    genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string | undefined) || newId(),
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    bufferLogs: true,
  });

  app.useLogger(app.get(Logger));

  const configService = app.get<ConfigService<AppEnv, true>>(ConfigService);

  // `as any`: @nestjs/platform-fastify pins its own transitive `fastify`
  // version, distinct from the `fastify` these @fastify/* plugins resolve
  // against in this workspace. Both are fastify 5.x and structurally
  // compatible at runtime (this is the standard, documented way to
  // register fastify plugins on a Nest app) - only their generated type
  // identities differ, which TS can't reconcile across the two copies.
  await app.register(helmet as any);
  await app.register(cors as any, {
    origin: configService.get('APP_URL', { infer: true }),
    credentials: true,
    // @fastify/cors defaults `methods` to GET,HEAD,POST - so without this every
    // DELETE, PUT and PATCH from the browser fails its preflight, across the
    // entire API. curl never sees it (it does not enforce CORS), and GET/POST
    // traffic works fine, so the gap stays invisible until the first update or
    // delete is wired up in the UI.
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['content-type', 'authorization', 'x-campus-id', 'x-academic-year-id', 'x-request-id'],
  });
  await app.register(cookie as any);

  // Mounted directly on the underlying Fastify instance, at the exact path
  // contracted with the frontend (`/api/v1/auth/*`) - not through a Nest
  // controller. See mountAuthHandler's own comment (`@sms/identity`) for why:
  // Better Auth's Node handler reads the request body itself off the raw
  // stream, which Fastify's default content-type parsers would otherwise
  // have already consumed before a Nest controller ever saw it.
  // `as any`: same cross-package `fastify` instance mismatch as the
  // `@fastify/*` plugin registrations above - `@sms/identity` resolves its
  // own `fastify` types independently of `@nestjs/platform-fastify`'s.
  await mountAuthHandler(app.getHttpAdapter().getInstance() as any, getAuth(), {
    // These routes bypass Fastify's response hooks (see mountAuthHandler), so
    // @fastify/cors above does not cover them - the same origin has to be
    // passed through explicitly.
    allowedOrigins: [configService.get('APP_URL', { infer: true })],
  });

  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(new ZodValidationPipe());

  const swaggerConfig = new DocumentBuilder()
    .setTitle('School Management System API')
    .setDescription('Multi-tenant SIS platform - REST API (Phase 1)')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
  // SwaggerModule.setup() silently hangs app startup on the Fastify adapter if
  // @fastify/static is absent - it is a required peer for serving the UI assets.
  SwaggerModule.setup('docs', app, document, {
    jsonDocumentUrl: 'docs-json',
    swaggerOptions: { persistAuthorization: true },
  });

  const port = configService.get('PORT', { infer: true });
  await app.listen(port, '0.0.0.0');

  app.get(Logger).log(`API listening on http://0.0.0.0:${port}/api/v1 (docs at /docs)`);
}

bootstrap().catch((error: unknown) => {
  // Deliberately not a raw stack dump for config errors: env.schema.ts's
  // validateEnv() already formats a readable list of what's wrong.
  console.error('Failed to start the API.');
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
