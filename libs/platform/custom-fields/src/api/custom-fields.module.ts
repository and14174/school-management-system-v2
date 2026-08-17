import { Module } from '@nestjs/common';
import { CUSTOM_FIELDS_CONTRACT } from '../contract.js';
import { CustomFieldsService } from '../application/custom-fields.service.js';
import { FieldDefinitionService } from '../application/field-definition.service.js';
import { SchemaCache } from '../application/schema-cache.js';

/**
 * Exports `CUSTOM_FIELDS_CONTRACT` (not the concrete `CustomFieldsService`) -
 * matching `@sms/access`'s/`@sms/tenancy`'s `*Module` shape. No controller:
 * this module is deliberately small and consumed today only through the
 * contract (by `@sms/people`'s `PersonService` on create/update) - a REST
 * admin surface for tenants to manage their own field catalogue is future
 * work, not something anything currently reads.
 */
@Module({
  providers: [
    SchemaCache,
    FieldDefinitionService,
    CustomFieldsService,
    { provide: CUSTOM_FIELDS_CONTRACT, useExisting: CustomFieldsService },
  ],
  exports: [CUSTOM_FIELDS_CONTRACT],
})
export class CustomFieldsModule {}
