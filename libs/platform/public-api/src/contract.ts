import type { DomainError, NotFoundError, Result } from '@sms/kernel';

export * from './domain/types.js';

import type {
  ApiKeyRequestInfo,
  ApiKeySummary,
  AuthenticatedApiKey,
  MintApiKeyInput,
  MintedApiKey,
  RevokeApiKeyInput,
} from './domain/types.js';

/**
 * The public surface of `@sms/public-api`. `apps/api`'s `ApiKeysController`
 * and `ApiKeyGuard` are the only intended callers - see each's own comment.
 */
export interface PublicApiContract {
  /**
   * Mints a new key. `input.grantedPermissions` must be a non-empty,
   * explicit subset of the AMBIENT caller's own effective permissions in
   * the ambient tenant (resolved via `@sms/access`'s
   * `AccessContract.listEffectivePermissions`) - anything else is rejected
   * with a `ForbiddenError`, never silently narrowed. `plaintext` on the
   * returned `MintedApiKey` is shown exactly once; nothing durable holds it.
   */
  mint(input: MintApiKeyInput): Promise<Result<MintedApiKey, DomainError>>;

  /** Permanent and immediate - see the 1600 migration header. Idempotent: revoking an already-revoked key succeeds without changing anything. */
  revoke(input: RevokeApiKeyInput): Promise<Result<void, NotFoundError>>;

  /** Every key in the ambient tenant, newest first. Never includes a secret or a hash. */
  list(): Promise<ApiKeySummary[]>;

  get(id: string): Promise<Result<ApiKeySummary, NotFoundError>>;

  /**
   * Authenticates a presented `Authorization: Bearer <token>` value.
   * Verifies the key's shape, hash, revocation and expiry; on success,
   * records `last_used_at` and an `api_key_request_log` row (see the 1600
   * migration header) and returns the resolved principal. Returns
   * `undefined` for anything invalid, revoked or expired - deliberately
   * undifferentiated, so a caller can never learn WHY a key failed.
   *
   * Does NOT check the granted-permission subset against the route being
   * called - that is `ApiKeyGuard`'s job (it has the route's
   * `@RequirePermission` metadata; this method does not).
   */
  authenticate(plaintext: string, request: ApiKeyRequestInfo): Promise<AuthenticatedApiKey | undefined>;
}

/** Nest DI token for `PublicApiContract`. */
export const PUBLIC_API_CONTRACT = Symbol('PUBLIC_API_CONTRACT');
