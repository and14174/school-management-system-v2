import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  ConflictError,
  NotFoundError,
  ValidationError,
  newId,
  type DomainError,
  type Result,
  type TenantId,
  type UserId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import { IDENTITY_CONTRACT, type IdentityContract } from '@sms/identity';
import type { StartImpersonationInput } from '../contract.js';
import type { Impersonation } from '../domain/types.js';
import { toImpersonation } from '../infrastructure/mappers.js';
import { impersonationTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Every impersonated session must be traceable to a named human and a
 * stated reason (`access.impersonation.reason` is `NOT NULL` - see the
 * `0400` migration). `startImpersonation`/`endImpersonation` only manage
 * *that record*; making the ambient request context reflect "acting as the
 * target, attributable to the actor" is `apps/api`'s
 * `TenantContextInterceptor`'s job (it reads `getActiveImpersonation` on
 * every request) - this service does not, and cannot, change ambient
 * context for the request that started the session, since the impersonation
 * only takes effect from the *next* request onward.
 */
@Injectable()
export class ImpersonationService {
  constructor(@Inject(IDENTITY_CONTRACT) private readonly identity: IdentityContract) {}

  async start(tenantId: TenantId, actorUserId: UserId, input: StartImpersonationInput): Promise<Result<Impersonation, DomainError>> {
    if (!input.reason || input.reason.trim().length === 0) {
      return err(new ValidationError('An impersonation reason is required.'));
    }
    if (actorUserId === input.targetUserId) {
      return err(new ValidationError('Cannot impersonate yourself.'));
    }

    const targetResult = await this.identity.getUser(input.targetUserId);
    if (!targetResult.ok) {
      return err(new NotFoundError(`User ${input.targetUserId} not found.`));
    }

    const ctx = scopedContext(tenantId);
    const id = newId();

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(impersonationTable)
          .values({ id, tenantId, actorUserId, targetUserId: input.targetUserId, reason: input.reason.trim() })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new ConflictError('Insert returned no row.'));
      }
      return ok(toImpersonation(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not start impersonation - an active session may already exist.') as DomainError);
    }
  }

  async end(tenantId: TenantId, actorUserId: UserId): Promise<Result<boolean, DomainError>> {
    const ctx = scopedContext(tenantId);

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(impersonationTable)
          .set({ endedAt: new Date() })
          .where(
            and(
              eq(impersonationTable.tenantId, tenantId),
              eq(impersonationTable.actorUserId, actorUserId),
              isNull(impersonationTable.endedAt),
            ),
          )
          .returning(),
      );
      // Ending an already-ended (or never-started) session is not an error,
      // but the caller must be told which happened. Discarding this is what
      // hid the actor/effective-user mix-up above: the endpoint reported
      // `{ ended: true }` for an UPDATE that matched zero rows, so the banner
      // never cleared and nothing anywhere said why.
      return ok(rows.length > 0);
    } catch (error) {
      return err(toDomainError(error, 'Could not end impersonation.') as DomainError);
    }
  }

  async getActive(tenantId: TenantId, actorUserId: UserId): Promise<Impersonation | null> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(impersonationTable)
        .where(
          and(
            eq(impersonationTable.tenantId, tenantId),
            eq(impersonationTable.actorUserId, actorUserId),
            isNull(impersonationTable.endedAt),
          ),
        )
        .limit(1),
    );
    const row = rows[0];
    return row ? toImpersonation(row) : null;
  }
}
