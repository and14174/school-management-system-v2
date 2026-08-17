import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { DomainError, NotFoundError, Result, TenantId, ValidationError } from '@sms/kernel';
import type { CreateFieldDefinitionInput, CustomFieldsContract, UpdateFieldDefinitionInput } from '../contract.js';
import type { FieldDefinition } from '../domain/types.js';
import { FieldDefinitionService } from './field-definition.service.js';

/**
 * Implements `CustomFieldsContract` as a thin pass-through to
 * `FieldDefinitionService` - kept as a separate class (rather than binding
 * `FieldDefinitionService` to the DI token directly) purely so the DI token
 * (`CUSTOM_FIELDS_CONTRACT`) is bound to something that visibly implements
 * the interface, exactly like `@sms/access`'s `AccessService` composes
 * `AbilityService`/`RoleService`/`ImpersonationService` behind
 * `ACCESS_CONTRACT`.
 */
@Injectable()
export class CustomFieldsService implements CustomFieldsContract {
  constructor(@Inject(FieldDefinitionService) private readonly definitions: FieldDefinitionService) {}

  listDefinitions(tenantId: TenantId, entityType: string): Promise<FieldDefinition[]> {
    return this.definitions.listDefinitions(tenantId, entityType);
  }

  getDefinition(tenantId: TenantId, id: string): Promise<Result<FieldDefinition, NotFoundError>> {
    return this.definitions.getDefinition(tenantId, id);
  }

  createDefinition(tenantId: TenantId, input: CreateFieldDefinitionInput): Promise<Result<FieldDefinition, DomainError>> {
    return this.definitions.createDefinition(tenantId, input);
  }

  updateDefinition(
    tenantId: TenantId,
    id: string,
    input: UpdateFieldDefinitionInput,
  ): Promise<Result<FieldDefinition, DomainError>> {
    return this.definitions.updateDefinition(tenantId, id, input);
  }

  deleteDefinition(tenantId: TenantId, id: string): Promise<Result<void, DomainError>> {
    return this.definitions.deleteDefinition(tenantId, id);
  }

  compileSchema(tenantId: TenantId, entityType: string): Promise<z.ZodTypeAny> {
    return this.definitions.compileSchema(tenantId, entityType);
  }

  validate(tenantId: TenantId, entityType: string, values: unknown): Promise<Result<Record<string, unknown>, ValidationError>> {
    return this.definitions.validate(tenantId, entityType, values);
  }
}
