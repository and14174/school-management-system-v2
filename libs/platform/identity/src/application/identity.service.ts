import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { APIError } from 'better-auth';
import { ConflictError, ForbiddenError, NotFoundError, type DomainError, type Result, err, ok, type TenantId, type UserId } from '@sms/kernel';
import type {
  CreateUserWithMembershipInput,
  CreateUserWithMembershipResult,
  IdentityContract,
} from '../contract.js';
import type { IdentityUser, Membership, ResolvedSession } from '../domain/types.js';
import { getAuth } from './auth.js';
import { getIdentityDb } from '../infrastructure/db.js';
import { sessionTable, userTable } from '../infrastructure/schema.js';
import { toIdentityUser } from '../infrastructure/mappers.js';
import { MembershipService } from './membership.service.js';

@Injectable()
export class IdentityService implements IdentityContract {
  constructor(private readonly memberships: MembershipService = new MembershipService()) {}

  async getSession(headers: Headers): Promise<ResolvedSession | null> {
    const result = await getAuth().api.getSession({ headers });
    if (!result) {
      return null;
    }
    const { session, user } = result;
    return {
      sessionToken: session.token,
      activeTenantId: ((session as Record<string, unknown>).activeTenantId as TenantId | null | undefined) ?? null,
      user: {
        id: user.id as UserId,
        email: user.email,
        name: user.name,
        emailVerified: user.emailVerified,
        twoFactorEnabled: Boolean((user as Record<string, unknown>).twoFactorEnabled),
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
    };
  }

  listMemberships(userId: UserId): Promise<Membership[]> {
    return this.memberships.listForUser(userId);
  }

  async setActiveTenant(sessionToken: string, tenantId: TenantId): Promise<Result<void, DomainError>> {
    const db = getIdentityDb();
    const rows = await db.select().from(sessionTable).where(eq(sessionTable.token, sessionToken)).limit(1);
    const sessionRow = rows[0];
    if (!sessionRow) {
      return err(new NotFoundError('Session not found.'));
    }

    const membership = await this.memberships.getForUserAndTenant(sessionRow.userId as UserId, tenantId);
    if (!membership || membership.status !== 'active') {
      return err(new ForbiddenError(`User does not have an active membership in tenant ${tenantId}.`));
    }

    await db.update(sessionTable).set({ activeTenantId: tenantId }).where(eq(sessionTable.token, sessionToken));
    return ok(undefined);
  }

  async createUserWithMembership(
    input: CreateUserWithMembershipInput,
  ): Promise<Result<CreateUserWithMembershipResult, DomainError>> {
    let userId: string;
    try {
      const signUpResult = await getAuth().api.signUpEmail({
        body: { name: input.name, email: input.email, password: input.password },
      });
      userId = signUpResult.user.id;
    } catch (error) {
      if (error instanceof APIError) {
        return err(new ConflictError(error.message || `Could not create user "${input.email}".`));
      }
      throw error;
    }

    const membershipResult = await this.memberships.create({
      tenantId: input.tenantId,
      userId: userId as UserId,
      status: 'active',
    });
    if (!membershipResult.ok) {
      return err(
        membershipResult.error instanceof Error
          ? (membershipResult.error as unknown as DomainError)
          : new ConflictError('Could not create membership.'),
      );
    }

    const userResult = await this.getUser(userId as UserId);
    if (!userResult.ok) {
      return err(userResult.error);
    }

    return ok({ user: userResult.value, membership: membershipResult.value });
  }

  async getUser(id: UserId): Promise<Result<IdentityUser, NotFoundError>> {
    const rows = await getIdentityDb().select().from(userTable).where(eq(userTable.id, id)).limit(1);
    const row = rows[0];
    return row ? ok(toIdentityUser(row)) : err(new NotFoundError(`User ${id} not found.`));
  }
}
