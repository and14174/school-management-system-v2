import { Inject, Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  ForbiddenError,
  NotFoundError,
  ValidationError,
  err,
  isSystemContext,
  newId,
  ok,
  type DomainError,
  type Result,
  type TenantContext,
  type TenantId,
  type UserId,
} from '@sms/kernel';
import { getContext, withSystemTx, withTenantTx } from '@sms/db';
import { ACCESS_CONTRACT, isKnownPermission, type AccessContract } from '@sms/access';
import type {
  ApiKeyRequestInfo,
  ApiKeySummary,
  AuthenticatedApiKey,
  MintApiKeyInput,
  MintedApiKey,
  RevokeApiKeyInput,
} from '../domain/types.js';
import type { PublicApiContract } from '../contract.js';
import { generateApiKey, hashApiKeySecret, parseApiKey, verifyApiKeySecret } from './key-material.js';
import { apiKey, apiKeyRequestLog, apiKeyUsage } from '../infrastructure/schema.js';

type ApiKeyRow = typeof apiKey.$inferSelect;

function requireTenantContext(): TenantContext {
  const context = getContext();
  if (!context || isSystemContext(context)) {
    throw new ForbiddenError('@sms/public-api operations require a resolved tenant context.');
  }
  return context;
}

/**
 * A minimal, tenant-scoped `TenantContext` for work that starts with only a
 * `tenantId` in hand - `ApiKeysService.authenticate` runs before any HTTP
 * request's own `TenantContext` exists (it IS what resolves the tenant), so
 * it builds one exactly the way `@sms/identity`'s `MembershipService` does
 * for the same reason (see that module's private `scopedContext` helper and
 * `docs/decisions.md`'s "`MembershipService.listForUserDuringAuthentication`
 * is the one exception").
 */
function scopedContext(tenantId: TenantId, userId: UserId): TenantContext {
  return { tenantId, roles: [], requestId: newId(), userId, actorUserId: userId };
}

function toSummary(row: ApiKeyRow, lastUsedAt: Date | null): ApiKeySummary {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    prefix: row.prefix,
    grantedPermissions: row.grantedPermissions,
    createdByUserId: row.createdByUserId as UserId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    neverExpires: row.neverExpires,
    revokedAt: row.revokedAt ?? null,
    revokedByUserId: (row.revokedByUserId ?? null) as UserId | null,
    revokeReason: row.revokeReason ?? null,
    lastUsedAt,
  };
}

/**
 * Implements `PublicApiContract`. See the 1600 migration header for the
 * design this exists to serve: a key can never exceed the permissions of
 * the user who minted it, revocation is immediate and permanent, and every
 * authenticated call is attributable without ever storing or logging the
 * plaintext secret.
 */
@Injectable()
export class ApiKeysService implements PublicApiContract {
  constructor(@Inject(ACCESS_CONTRACT) private readonly access: AccessContract) {}

  async mint(input: MintApiKeyInput): Promise<Result<MintedApiKey, DomainError>> {
    const ctx = requireTenantContext();
    const creatorUserId = (ctx.actorUserId ?? ctx.userId) as UserId | undefined;
    if (!creatorUserId) {
      return err(new ForbiddenError('A signed-in user is required to mint an API key.'));
    }

    if (input.grantedPermissions.length === 0) {
      return err(new ValidationError('At least one permission must be granted.'));
    }

    const unknown = input.grantedPermissions.filter((key) => !isKnownPermission(key));
    if (unknown.length > 0) {
      return err(new ValidationError(`Unknown permission key(s): ${unknown.join(', ')}.`));
    }

    if (!input.neverExpires && !input.expiresAt) {
      return err(new ValidationError('expiresAt is required unless neverExpires is explicitly set.'));
    }

    // THE rule that matters most: a key can never exceed the permissions of
    // the principal minting it. Checked against the CREATOR's own effective
    // permissions (role-derived, resolved fresh right now) - never against
    // some other user's, and never widened by the request itself.
    const effective = await this.access.listEffectivePermissions(creatorUserId, ctx.tenantId);
    const held = new Set(effective.map((permission) => permission.key));
    const exceeded = input.grantedPermissions.filter((key) => !held.has(key));
    if (exceeded.length > 0) {
      return err(
        new ForbiddenError(
          `Cannot grant permission(s) you do not hold yourself: ${exceeded.join(', ')}.`,
        ),
      );
    }

    const generated = generateApiKey();
    const keyHash = hashApiKeySecret(generated.secret);

    const row = await withTenantTx(ctx, async (tx) => {
      const [inserted] = await tx
        .insert(apiKey)
        .values({
          id: newId(),
          tenantId: ctx.tenantId,
          name: input.name,
          prefix: generated.prefix,
          keyHash,
          grantedPermissions: [...input.grantedPermissions],
          createdByUserId: creatorUserId,
          createdAt: new Date(),
          expiresAt: input.neverExpires ? null : (input.expiresAt ?? null),
          neverExpires: Boolean(input.neverExpires),
          revokedAt: null,
          revokedByUserId: null,
          revokeReason: null,
        })
        .returning();
      if (!inserted) throw new Error('public_api.api_key insert returned no row.');
      return inserted;
    });

    return ok({ ...toSummary(row, null), plaintext: generated.plaintext });
  }

  async revoke(input: RevokeApiKeyInput): Promise<Result<void, NotFoundError>> {
    const ctx = requireTenantContext();
    const revokerUserId = (ctx.actorUserId ?? ctx.userId ?? null) as UserId | null;

    // Idempotent, single-statement guard - same shape as
    // `docs/decisions.md`'s "An applicant is not yet a person" `converted_at`
    // precedent: `WHERE revoked_at IS NULL RETURNING *` means a double-clicked
    // revoke can never race itself into two different revoke_reasons.
    const updated = await withTenantTx(ctx, async (tx) => {
      const [row] = await tx
        .update(apiKey)
        .set({ revokedAt: new Date(), revokedByUserId: revokerUserId, revokeReason: input.reason ?? null })
        .where(and(eq(apiKey.id, input.id), eq(apiKey.tenantId, ctx.tenantId), isNull(apiKey.revokedAt)))
        .returning({ id: apiKey.id });
      return row;
    });

    if (updated) return ok(undefined);

    // Zero rows updated: either the key doesn't exist (or belongs to another
    // tenant - RLS makes the two indistinguishable, same as elsewhere in
    // this codebase), or it was already revoked. The latter is not usefully
    // different from success.
    const existing = await withTenantTx(ctx, (tx) =>
      tx.select({ id: apiKey.id }).from(apiKey).where(and(eq(apiKey.id, input.id), eq(apiKey.tenantId, ctx.tenantId))).limit(1),
    );
    if (existing.length > 0) return ok(undefined);
    return err(new NotFoundError(`API key "${input.id}" was not found.`));
  }

  async list(): Promise<ApiKeySummary[]> {
    const ctx = requireTenantContext();
    return withTenantTx(ctx, async (tx) => {
      const rows = await tx.select().from(apiKey).where(eq(apiKey.tenantId, ctx.tenantId)).orderBy(desc(apiKey.createdAt));
      const usageRows = await tx.select().from(apiKeyUsage).where(eq(apiKeyUsage.tenantId, ctx.tenantId));
      const lastUsedById = new Map(usageRows.map((usage) => [usage.apiKeyId, usage.lastUsedAt]));
      return rows.map((row) => toSummary(row, lastUsedById.get(row.id) ?? null));
    });
  }

  async get(id: string): Promise<Result<ApiKeySummary, NotFoundError>> {
    const ctx = requireTenantContext();
    const found = await withTenantTx(ctx, async (tx) => {
      const [row] = await tx.select().from(apiKey).where(and(eq(apiKey.id, id), eq(apiKey.tenantId, ctx.tenantId))).limit(1);
      if (!row) return undefined;
      const [usage] = await tx.select().from(apiKeyUsage).where(eq(apiKeyUsage.apiKeyId, id)).limit(1);
      return toSummary(row, usage?.lastUsedAt ?? null);
    });
    if (!found) return err(new NotFoundError(`API key "${id}" was not found.`));
    return ok(found);
  }

  async authenticate(plaintext: string, request: ApiKeyRequestInfo): Promise<AuthenticatedApiKey | undefined> {
    const parsed = parseApiKey(plaintext);
    if (!parsed) return undefined;

    // The ONE legitimate use of withSystemTx in this module: a single,
    // indexed lookup by the non-secret `prefix`, run BEFORE any tenant is
    // known - this is exactly what determines the tenant. Same documented
    // exception as @sms/identity's MembershipService.listForUserDuringAuthentication
    // (see docs/decisions.md) - bounded to one SELECT, never anything wider,
    // and never reachable once the tenant is known (everything below this
    // point uses withTenantTx, which is subject to RLS as normal).
    const rows = await withSystemTx((db) => db.select().from(apiKey).where(eq(apiKey.prefix, parsed.prefix)).limit(1));
    const row = rows[0];
    if (!row) return undefined;

    // Constant-time compare against the stored HMAC - see key-material.ts.
    if (!verifyApiKeySecret(parsed.secret, row.keyHash)) return undefined;

    // Revoked is immediate and permanent - see the 1600 migration header.
    if (row.revokedAt) return undefined;

    // Expired fails closed.
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return undefined;

    const tenantId = row.tenantId as TenantId;
    const createdByUserId = row.createdByUserId as UserId;
    const ctx = scopedContext(tenantId, createdByUserId);

    await withTenantTx(ctx, async (tx) => {
      const now = new Date();
      await tx
        .insert(apiKeyUsage)
        .values({ apiKeyId: row.id, tenantId, lastUsedAt: now, useCount: 1 })
        .onConflictDoUpdate({
          target: apiKeyUsage.apiKeyId,
          set: { lastUsedAt: now, useCount: sql`${apiKeyUsage.useCount} + 1` },
        });

      await tx.insert(apiKeyRequestLog).values({
        id: newId(),
        tenantId,
        apiKeyId: row.id,
        method: request.method,
        // Query strings may carry values a caller would not expect to be
        // logged (even attributional logging should not become an
        // accidental PII sink) - only the path itself is recorded.
        path: request.path.split('?')[0] ?? request.path,
        occurredAt: now,
      });
    });

    return {
      id: row.id,
      tenantId,
      prefix: row.prefix,
      grantedPermissions: row.grantedPermissions,
      createdByUserId,
    };
  }
}
