import type { TenantId, UserId } from '@sms/kernel';

/**
 * What `ApiKeysController` lists/reads. Deliberately has no field that could
 * ever hold the secret - see the 1600 migration header's "never a readable
 * secret". `prefix` is the only key-shaped thing here, and it is
 * non-secret by construction (see `application/key-material.ts`).
 */
export interface ApiKeySummary {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly prefix: string;
  readonly grantedPermissions: readonly string[];
  readonly createdByUserId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date | null;
  readonly neverExpires: boolean;
  readonly revokedAt: Date | null;
  readonly revokedByUserId: UserId | null;
  readonly revokeReason: string | null;
  readonly lastUsedAt: Date | null;
}

/**
 * What `POST /public-api/keys` returns - the ONLY place `plaintext` ever
 * appears anywhere in this system. It is not derivable from `key_hash` and
 * is never logged or persisted - see the 1600 migration header.
 */
export interface MintedApiKey extends ApiKeySummary {
  readonly plaintext: string;
}

export interface MintApiKeyInput {
  readonly name: string;
  /** Must be a non-empty, explicit subset of the creating user's own effective permissions - see `ApiKeysService.mint`. */
  readonly grantedPermissions: readonly string[];
  /** Required unless `neverExpires` is `true` - see the 1600 migration header. */
  readonly expiresAt?: Date;
  /** Explicit opt-out of expiry. */
  readonly neverExpires?: boolean;
}

export interface RevokeApiKeyInput {
  readonly id: string;
  readonly reason?: string;
}

/**
 * The resolved principal `ApiKeysService.authenticate` hands back to
 * `ApiKeyGuard` - never the row itself, and never anything secret.
 */
export interface AuthenticatedApiKey {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly prefix: string;
  readonly grantedPermissions: readonly string[];
  readonly createdByUserId: UserId;
}

/** What `ApiKeyGuard` reports about the inbound call, for `ApiKeysService.authenticate`'s own attribution log. */
export interface ApiKeyRequestInfo {
  readonly method: string;
  readonly path: string;
}
