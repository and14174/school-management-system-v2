import type { IncomingMessage } from 'node:http';
import { toNodeHandler } from 'better-auth/node';
import type { FastifyInstance } from 'fastify';
import type { Auth } from '../application/auth.js';

/**
 * Mounts Better Auth's own handler directly on the underlying Fastify
 * instance at `/api/v1/auth/*` - the exact path contracted with the
 * frontend (see the module spec). Deliberately not a Nest controller:
 * Better Auth's Node handler (`toNodeHandler`, from `better-auth/node`)
 * needs the raw request body - but Fastify's default JSON/text
 * content-type parsers already consume it before a request ever reaches a
 * Nest controller, so by then there is nothing left for Better Auth to read.
 *
 * The fix is Fastify's own plugin encapsulation: `fastify.register()` opens
 * a new child scope, and a content-type parser added inside it only shadows
 * the default for routes registered in that same scope - every other route
 * (including this app's Nest controllers, registered on the root instance,
 * and `AuthController`'s own `GET /api/v1/auth/me`) keeps the normal
 * default parsers untouched.
 *
 * Within that scope, the parser reads the body as a plain string
 * (`parseAs: 'string'`) rather than passing the raw stream straight
 * through: Fastify's own request lifecycle already begins consuming
 * `request.raw` before a route handler runs (byte-counting against
 * `bodyLimit`), so by the time this route's handler executes, the
 * underlying stream `toNodeHandler` would otherwise try to read is no
 * longer readable - `better-call` (which `toNodeHandler` is built on)
 * silently produces an empty body in that case (observed: every request
 * failing Better Auth's own body validation). It falls back correctly to
 * `request.body` (i.e. the string this parser produced) when the raw
 * stream isn't readable - which is why the Fastify *request* (not
 * `request.raw`) is passed as `toNodeHandler`'s first argument here: that
 * fallback keys off `request.body`, which only exists on the Fastify
 * wrapper.
 *
 * `reply.hijack()` tells Fastify this handler - not Fastify's own reply
 * lifecycle - owns writing the response via `reply.raw`.
 *
 * `GET /api/v1/auth/me` (Nest, static route) and this wildcard both matching
 * `/api/v1/auth/*` is not a conflict: Fastify's router (find-my-way) always
 * prefers a more specific static route over a wildcard one, independent of
 * registration order.
 */
export interface MountAuthHandlerOptions {
  /** Origins allowed to call the auth routes with credentials (the web app). */
  readonly allowedOrigins: readonly string[];
}

export async function mountAuthHandler(
  fastify: FastifyInstance,
  auth: Auth,
  options: MountAuthHandlerOptions,
): Promise<void> {
  await fastify.register(async (instance) => {
    instance.addContentTypeParser('*', { parseAs: 'string' }, (_request, body, done) => {
      done(null, body);
    });

    instance.all('/api/v1/auth/*', async (request, reply) => {
      // CORS has to be applied by hand here, and this is not optional.
      //
      // `reply.hijack()` below tells Fastify to stop managing this response, so
      // Better Auth can write directly to the raw Node socket. That also means
      // NONE of Fastify's response hooks run - including the `onSend` hook that
      // `@fastify/cors` uses to attach Access-Control-Allow-Origin. Nest's own
      // controllers keep working, so the breakage is invisible until a browser
      // (not curl) posts to a route mounted here, and then every sign-in fails
      // with an opaque "Failed to fetch".
      const origin = request.headers.origin;
      if (origin && options.allowedOrigins.includes(origin)) {
        reply.raw.setHeader('access-control-allow-origin', origin);
        reply.raw.setHeader('access-control-allow-credentials', 'true');
        // The response varies by Origin, so it must not be cached across origins.
        reply.raw.setHeader('vary', 'Origin');
      }

      // Preflight is answered here rather than delegated: Better Auth has no
      // route for OPTIONS, and the wildcard above already claimed it.
      if (request.method === 'OPTIONS') {
        reply.raw.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        reply.raw.setHeader(
          'access-control-allow-headers',
          request.headers['access-control-request-headers'] ?? 'content-type,authorization',
        );
        reply.raw.setHeader('access-control-max-age', '600');
        reply.hijack();
        reply.raw.writeHead(204);
        reply.raw.end();
        return;
      }

      reply.hijack();
      // Cast, not `request.raw`: see the fallback-to-`request.body` comment
      // above for why the Fastify request wrapper itself is what
      // `toNodeHandler` needs here. Structurally compatible at the fields it
      // actually reads (`headers`, `method`, `url`, `body`), not literally
      // an `IncomingMessage`.
      await toNodeHandler(auth)(request as unknown as IncomingMessage, reply.raw);
    });
  });
}
