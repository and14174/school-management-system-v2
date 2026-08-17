// The public surface other modules should depend on: the port
// (`IdentityContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs: an actual NestJS module class to wire up
// (`IdentityModule`), the global auth guard and its `@Public()` opt-out
// (registered/used in `AppModule`), and the raw-Fastify mount for Better
// Auth's own routes (called once from `main.ts`) - see each file's own
// comment for why these can't just live behind the contract interface.
export { IdentityModule } from './api/identity.module.js';
export { AuthGuard } from './api/auth.guard.js';
export { Public, IS_PUBLIC_KEY } from './api/public.decorator.js';
export type { FastifyRequestWithIdentity, RequestIdentity } from './api/request-identity.js';
export { mountAuthHandler } from './api/mount-auth-handler.js';
export { getAuth, createAuth, resetAuthSingleton, type Auth } from './application/auth.js';
