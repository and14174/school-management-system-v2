import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  NotFoundError,
  ValidationError,
  newId,
  type DomainError,
  type Result,
  type TenantId,
  err,
  ok,
} from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { CreateFieldDefinitionInput, UpdateFieldDefinitionInput } from '../contract.js';
import type { FieldDefinition } from '../domain/types.js';
import { CUSTOM_FIELD_DATA_TYPES } from '../domain/types.js';
import { toFieldDefinition } from '../infrastructure/mappers.js';
import { fieldDefinitionTable } from '../infrastructure/schema.js';
import { compileEntitySchema } from './schema-compiler.js';
import { scopedContext } from './scoped-context.js';
import { SchemaCache } from './schema-cache.js';
import { toDomainError } from './sql-errors.js';

/**
 * CRUD over `custom_fields.field_definition` plus schema
 * compilation/validation - the concrete implementation behind
 * `CustomFieldsContract` (see `custom-fields.service.ts`, the thin adapter
 * that binds this to the DI token). Kept as one service (rather than split
 * like `@sms/access`'s `AbilityService`/`RoleService`) because there is only
 * one real concern here: keep the compiled schema in lock-step with the
 * definitions it was built from.
 */
@Injectable()
export class FieldDefinitionService {
  constructor(@Inject(SchemaCache) private readonly schemaCache: SchemaCache) {}

  async listDefinitions(tenantId: TenantId, entityType: string): Promise<FieldDefinition[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(fieldDefinitionTable)
        .where(and(eq(fieldDefinitionTable.tenantId, tenantId), eq(fieldDefinitionTable.entityType, entityType)))
        .orderBy(fieldDefinitionTable.displayOrder),
    );
    return rows.map(toFieldDefinition);
  }

  async getDefinition(tenantId: TenantId, id: string): Promise<Result<FieldDefinition, NotFoundError>> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(fieldDefinitionTable)
        .where(and(eq(fieldDefinitionTable.tenantId, tenantId), eq(fieldDefinitionTable.id, id)))
        .limit(1),
    );
    const row = rows[0];
    return row ? ok(toFieldDefinition(row)) : err(new NotFoundError(`Field definition ${id} not found.`));
  }

  async createDefinition(tenantId: TenantId, input: CreateFieldDefinitionInput): Promise<Result<FieldDefinition, DomainError>> {
    if (!CUSTOM_FIELD_DATA_TYPES.includes(input.dataType)) {
      return err(new ValidationError(`Unknown data type "${input.dataType}".`));
    }
    if ((input.dataType === 'select' || input.dataType === 'multiselect') && (input.options ?? []).length === 0) {
      return err(new ValidationError(`A "${input.dataType}" field requires at least one option.`));
    }

    const ctx = scopedContext(tenantId);
    const id = newId();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(fieldDefinitionTable)
          .values({
            id,
            tenantId,
            entityType: input.entityType,
            key: input.key,
            label: input.label,
            dataType: input.dataType,
            options: input.options ?? [],
            required: input.required ?? false,
            reportable: input.reportable ?? true,
            displayOrder: input.displayOrder ?? 0,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new ValidationError('Insert returned no row.'));
      }
      this.schemaCache.invalidate(tenantId, input.entityType);
      return ok(toFieldDefinition(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create field definition "${input.key}".`) as DomainError);
    }
  }

  async updateDefinition(
    tenantId: TenantId,
    id: string,
    input: UpdateFieldDefinitionInput,
  ): Promise<Result<FieldDefinition, DomainError>> {
    const ctx = scopedContext(tenantId);

    const existingResult = await this.getDefinition(tenantId, id);
    if (!existingResult.ok) {
      return existingResult;
    }
    const existing = existingResult.value;

    if (
      (existing.dataType === 'select' || existing.dataType === 'multiselect') &&
      input.options !== undefined &&
      input.options.length === 0
    ) {
      return err(new ValidationError(`A "${existing.dataType}" field requires at least one option.`));
    }

    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .update(fieldDefinitionTable)
          .set({
            ...(input.label !== undefined ? { label: input.label } : {}),
            ...(input.options !== undefined ? { options: input.options } : {}),
            ...(input.required !== undefined ? { required: input.required } : {}),
            ...(input.reportable !== undefined ? { reportable: input.reportable } : {}),
            ...(input.displayOrder !== undefined ? { displayOrder: input.displayOrder } : {}),
          })
          .where(and(eq(fieldDefinitionTable.tenantId, tenantId), eq(fieldDefinitionTable.id, id)))
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError(`Field definition ${id} not found.`));
      }
      this.schemaCache.invalidate(tenantId, existing.entityType);
      return ok(toFieldDefinition(row));
    } catch (error) {
      return err(toDomainError(error, `Could not update field definition ${id}.`) as DomainError);
    }
  }

  async deleteDefinition(tenantId: TenantId, id: string): Promise<Result<void, DomainError>> {
    const ctx = scopedContext(tenantId);

    const existingResult = await this.getDefinition(tenantId, id);
    if (!existingResult.ok) {
      return existingResult;
    }
    const existing = existingResult.value;

    await withTenantTx(ctx, (db) =>
      db.delete(fieldDefinitionTable).where(and(eq(fieldDefinitionTable.tenantId, tenantId), eq(fieldDefinitionTable.id, id))),
    );
    this.schemaCache.invalidate(tenantId, existing.entityType);
    return ok(undefined);
  }

  /** Compiles (and caches) the Zod schema for `entityType`'s current definitions - see `SchemaCache`'s own comment. */
  async compileSchema(tenantId: TenantId, entityType: string) {
    const cached = this.schemaCache.get(tenantId, entityType);
    if (cached) {
      return cached;
    }
    const definitions = await this.listDefinitions(tenantId, entityType);
    const schema = compileEntitySchema(definitions);
    this.schemaCache.set(tenantId, entityType, schema);
    return schema;
  }

  async validate(tenantId: TenantId, entityType: string, values: unknown): Promise<Result<Record<string, unknown>, ValidationError>> {
    const schema = await this.compileSchema(tenantId, entityType);
    const parsed = schema.safeParse(values ?? {});
    if (!parsed.success) {
      return err(new ValidationError(`Invalid custom field values for "${entityType}".`, parsed.error.issues));
    }
    return ok(parsed.data as Record<string, unknown>);
  }
}
