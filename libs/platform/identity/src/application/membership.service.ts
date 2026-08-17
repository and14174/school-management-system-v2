import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { newId, type Result, err, ok, type TenantContext, type TenantId, type UserId } from '@sms/kernel';
import { withAuthTx, withSystemTx, withTenantTx } from '@sms/db';
import type { Membership, MembershipStatus } from '../domain/types.js';
import { toMembership } from '../infrastructure/mappers.js';
import { membershipTable } from '../infrastructure/schema.js';
import { toDomainError } from './sql-errors.js';

export interface CreateMembershipInput {
  readonly tenantId: TenantId;
  readonly userId: UserId;
  readonly personId?: string | null;
  readonly status?: MembershipStatus;
}

/** A throwaway single-purpose context for a membership read/write scoped to exactly one tenant. */
function scopedContext(tenantId: TenantId): TenantContext {
  return { tenantId, roles: [], requestId: newId() };
}

@Injectable()
export class MembershipService {
  /**
   * Onboarding a membership (sign-up, invite). Like `TenantService.create` in
   * `@sms/tenancy`, this is a system-level operation - there is no ambient
   * tenant context to trust yet for a membership that doesn't exist, so it
   * runs through `withSystemTx` (bypassing RLS as table owner) rather than
   * fabricating one around a tenantId nothing has agreed to yet.
   */
  async create(input: CreateMembershipInput): Promise<Result<Membership, Error>> {
    const id = newId();

    try {
      const rows = await withSystemTx((db) =>
        db
          .insert(membershipTable)
          .values({
            id,
            tenantId: input.tenantId,
            userId: input.userId,
            personId: input.personId ?? null,
            status: input.status ?? 'invited',
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new Error('Insert returned no row.'));
      }
      return ok(toMembership(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not create membership.'));
    }
  }

  /**
   * Every tenant a user belongs to, regardless of status. Inherently
   * cross-tenant (that is the entire point of `identity.membership` - one
   * login spanning several schools), so it cannot go through `withTenantTx`:
   * there is no single tenant to scope it to yet.
   *
   * It does NOT use `withSystemTx` either. `AuthGuard` calls this on every
   * authenticated request, and `withSystemTx` connects as the table owner,
   * which bypasses row-level security entirely - that would put the hottest
   * path in the product outside all tenant isolation. `withAuthTx` runs as the
   * ordinary `sms_app` role with only `app.user_id` set, which the
   * `membership_self_read` policy (migration 0302) matches. The database, not
   * this WHERE clause, is what guarantees only this user's rows come back.
   */
  async listForUser(userId: UserId): Promise<Membership[]> {
    const rows = await withAuthTx(userId, (db) =>
      db.select().from(membershipTable).where(eq(membershipTable.userId, userId)),
    );
    return rows.map(toMembership);
  }

  /**
   * Identical result to `listForUser`, but on the owner connection.
   *
   * ONLY for Better Auth's `session.create.before` hook. That hook runs while
   * Better Auth's own write is already in flight on the pooled `sms_app`
   * client, and `withAuthTx` opens a *nested* transaction on that same client -
   * which deadlocks, hanging sign-in until the request times out. The failure
   * is silent and total: sign-up and sign-in simply never resolve.
   *
   * The exposure is deliberately bounded. This is not the per-request path -
   * `AuthGuard` uses `getForUserAndTenant`, which is tenant-scoped through
   * `withTenantTx`. This runs once, at session creation, to auto-select the
   * active tenant for a single-membership user. Everything reached from a
   * request handler goes through `listForUser` and its RLS self-read policy.
   *
   * Do not call this from anywhere else.
   */
  async listForUserDuringAuthentication(userId: UserId): Promise<Membership[]> {
    const rows = await withSystemTx((db) =>
      db.select().from(membershipTable).where(eq(membershipTable.userId, userId)),
    );
    return rows.map(toMembership);
  }

  /**
   * A single (user, tenant) membership, scoped to that exact tenant via
   * `withTenantTx` - RLS, not application filtering, is what proves the row
   * (if any) belongs to `tenantId`. Returns `null` (not a `NotFoundError`)
   * when absent: callers (`AuthGuard`, `setActiveTenant`) treat "no
   * membership" and "suspended membership" as different, deliberate
   * outcomes, not a single generic not-found.
   */
  async getForUserAndTenant(userId: UserId, tenantId: TenantId): Promise<Membership | null> {
    const rows = await withTenantTx(scopedContext(tenantId), (db) =>
      db
        .select()
        .from(membershipTable)
        .where(and(eq(membershipTable.userId, userId), eq(membershipTable.tenantId, tenantId)))
        .limit(1),
    );
    const row = rows[0];
    return row ? toMembership(row) : null;
  }
}
