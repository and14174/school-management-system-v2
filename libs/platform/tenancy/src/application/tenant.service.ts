import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { NotFoundError, newId, type Result, err, ok, type TenantContext, type TenantId } from '@sms/kernel';
import { withSystemTx, withTenantTx } from '@sms/db';
import type { Tenant } from '../domain/types.js';
import { toTenant } from '../infrastructure/mappers.js';
import { tenantTable } from '../infrastructure/schema.js';
import { createTenantSchema, updateTenantSchema, type CreateTenantInput, type UpdateTenantInput } from './schemas.js';
import { toDomainError } from './sql-errors.js';

/** A throwaway single-purpose context for reading exactly one tenant's own row (see `getById`). */
function selfScopedContext(tenantId: TenantId): TenantContext {
  return { tenantId, roles: [], requestId: newId() };
}

@Injectable()
export class TenantService {
  /**
   * Reads a tenant by its own id, scoped to that same id via `withTenantTx`.
   * RLS on `tenancy.tenant` only ever exposes a tenant its own row
   * (`tenant_id` is generated = `id`), so this is both a normal tenant-scoped
   * read and, structurally, proof that no id can read a different tenant's
   * row.
   */
  async getById(id: TenantId): Promise<Result<Tenant, NotFoundError>> {
    const rows = await withTenantTx(selfScopedContext(id), (db) =>
      db.select().from(tenantTable).where(eq(tenantTable.id, id)).limit(1),
    );
    const row = rows[0];
    return row ? ok(toTenant(row)) : err(new NotFoundError(`Tenant ${id} not found.`));
  }

  /**
   * Looks up a tenant by slug - the one legitimate read of this table that
   * cannot go through `withTenantTx`, because the id (and therefore the
   * `app.tenant_id` RLS needs) is exactly what's being looked up. This is
   * the same pre-context bootstrap `resolveScope` performs, and like it,
   * deliberately narrow: a single exact-slug lookup via the `sms_owner`
   * (RLS-bypassing) connection, not general query access to the table.
   */
  async getBySlug(slug: string): Promise<Result<Tenant, NotFoundError>> {
    const rows = await withSystemTx((db) => db.select().from(tenantTable).where(eq(tenantTable.slug, slug)).limit(1));
    const row = rows[0];
    return row ? ok(toTenant(row)) : err(new NotFoundError(`Tenant with slug "${slug}" not found.`));
  }

  /**
   * Onboarding a new school. There is, by definition, no ambient tenant
   * context yet for a tenant that doesn't exist - this is a system-level
   * operation (compare: schema migrations, scheduled jobs), so it runs
   * through `withSystemTx` rather than fabricating a tenant context around
   * an id nothing has agreed to yet.
   */
  async create(input: CreateTenantInput): Promise<Result<Tenant, Error>> {
    const parsed = createTenantSchema.parse(input);
    const id = newId() as TenantId;

    try {
      const rows = await withSystemTx((db) =>
        db
          .insert(tenantTable)
          .values({
            id,
            slug: parsed.slug,
            name: parsed.name,
            legalName: parsed.legalName ?? null,
            locale: parsed.locale,
            timezone: parsed.timezone,
            currency: parsed.currency,
            status: parsed.status,
            branding: parsed.branding,
            featureFlags: parsed.featureFlags,
            terminology: parsed.terminology,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new Error('Insert returned no row.'));
      }
      return ok(toTenant(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not create tenant.'));
    }
  }

  /** Also system-scoped, for the same reason as `create` - see above. */
  async updateById(id: TenantId, input: UpdateTenantInput): Promise<Result<Tenant, Error>> {
    const parsed = updateTenantSchema.parse(input);

    try {
      const rows = await withSystemTx((db) =>
        db
          .update(tenantTable)
          .set({
            ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
            ...(parsed.name !== undefined ? { name: parsed.name } : {}),
            ...(parsed.legalName !== undefined ? { legalName: parsed.legalName } : {}),
            ...(parsed.locale !== undefined ? { locale: parsed.locale } : {}),
            ...(parsed.timezone !== undefined ? { timezone: parsed.timezone } : {}),
            ...(parsed.currency !== undefined ? { currency: parsed.currency } : {}),
            ...(parsed.status !== undefined ? { status: parsed.status } : {}),
            ...(parsed.branding !== undefined ? { branding: parsed.branding } : {}),
            ...(parsed.featureFlags !== undefined ? { featureFlags: parsed.featureFlags } : {}),
            ...(parsed.terminology !== undefined ? { terminology: parsed.terminology } : {}),
          })
          .where(eq(tenantTable.id, id))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Tenant ${id} not found.`));
      }
      return ok(toTenant(row));
    } catch (error) {
      return err(toDomainError(error, 'Could not update tenant.'));
    }
  }
}
