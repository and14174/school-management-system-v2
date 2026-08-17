import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateIdentifierInput } from '../contract.js';
import type { PersonIdentifier } from '../domain/types.js';
import { toPersonIdentifier } from '../infrastructure/mappers.js';
import { personIdentifierTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

@Injectable()
export class IdentifierService {
  async addIdentifier(tenantId: TenantId, input: CreateIdentifierInput): Promise<Result<PersonIdentifier, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(personIdentifierTable)
          .values({ id, tenantId, personId: input.personId, type: input.type, value: input.value })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toPersonIdentifier(row));
    } catch (error) {
      return err(toDomainError(error, `Could not add "${input.type}" identifier.`) as DomainError);
    }
  }

  async listIdentifiers(tenantId: TenantId, personId: PersonId): Promise<PersonIdentifier[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(personIdentifierTable)
        .where(and(eq(personIdentifierTable.tenantId, tenantId), eq(personIdentifierTable.personId, personId))),
    );
    return rows.map(toPersonIdentifier);
  }
}
