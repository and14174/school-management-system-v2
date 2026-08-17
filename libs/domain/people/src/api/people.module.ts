import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { CustomFieldsModule } from '@sms/custom-fields';
import { PEOPLE_CONTRACT } from '../contract.js';
import { AlertService } from '../application/alert.service.js';
import { ContactPointService } from '../application/contact-point.service.js';
import { DuplicateService } from '../application/duplicate.service.js';
import { HouseholdService } from '../application/household.service.js';
import { IdentifierService } from '../application/identifier.service.js';
import { MergeService } from '../application/merge.service.js';
import { PeopleService } from '../application/people.service.js';
import { PersonService } from '../application/person.service.js';
import { RelationshipService } from '../application/relationship.service.js';
import { RoleService } from '../application/role.service.js';
import { PeopleController } from './people.controller.js';

/**
 * Exports `PEOPLE_CONTRACT` (not the concrete `PeopleService`) - matching
 * `@sms/access`'s `AccessModule` shape. Imports `CustomFieldsModule`:
 * `PersonService` validates a person's `custom_fields` through
 * `CUSTOM_FIELDS_CONTRACT` on create/update. Imports `AccessModule`:
 * `PeopleService.listAlerts` compiles the caller's ability via
 * `ACCESS_CONTRACT` to row-filter medical/safeguarding alerts, and
 * `PeopleController`'s routes are gated with `@RequirePermission`/
 * `@MaskFields`, whose enforcement (`PermissionGuard`/
 * `FieldMaskingInterceptor`) is registered globally in `apps/api`'s
 * `AppModule` but still needs `ACCESS_CONTRACT` visible in the DI graph
 * this module's controller lives in.
 */
@Module({
  imports: [CustomFieldsModule, AccessModule],
  controllers: [PeopleController],
  providers: [
    PersonService,
    RoleService,
    HouseholdService,
    RelationshipService,
    IdentifierService,
    AlertService,
    ContactPointService,
    DuplicateService,
    MergeService,
    PeopleService,
    { provide: PEOPLE_CONTRACT, useExisting: PeopleService },
  ],
  exports: [PEOPLE_CONTRACT],
})
export class PeopleModule {}
