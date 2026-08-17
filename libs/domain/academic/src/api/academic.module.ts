import { Global, Module } from '@nestjs/common';
import { AccessModule, SECTION_SCOPE_RESOLVER } from '@sms/access';
import { ACADEMIC_CONTRACT } from '../contract.js';
import { AcademicService } from '../application/academic.service.js';
import { BellScheduleService } from '../application/bell-schedule.service.js';
import { CourseService } from '../application/course.service.js';
import { DepartmentService } from '../application/department.service.js';
import { GradeLevelService } from '../application/grade-level.service.js';
import { RoomService } from '../application/room.service.js';
import { SectionEnrollmentService } from '../application/section-enrollment.service.js';
import { SectionMeetingService } from '../application/section-meeting.service.js';
import { SectionScopeResolverService } from '../application/section-scope-resolver.service.js';
import { SectionService } from '../application/section.service.js';
import { SectionTeacherService } from '../application/section-teacher.service.js';
import { SubjectService } from '../application/subject.service.js';
import { TermService } from '../application/term.service.js';
import { CatalogController } from './catalog.controller.js';
import { SchedulingController } from './scheduling.controller.js';
import { SectionsController } from './sections.controller.js';
import { TermsController } from './terms.controller.js';

/**
 * `@Global()`: this is what actually lets `apps/api` override `@sms/access`'s
 * `SECTION_SCOPE_RESOLVER` default. `AbilityService` lives inside
 * `AccessModule`'s own DI container and Nest resolves a class's dependencies
 * from providers visible to the module that DECLARES the class - not from
 * whatever `apps/api`'s `AppModule` happens to also provide. `@sms/access`
 * deliberately does not register this token itself (see
 * `application/section-scope-resolver.ts`'s own comment), so a `@Global()`
 * module's exports are the one mechanism that reaches into `AccessModule`'s
 * container without `AccessModule` ever importing `AcademicModule` (which
 * `@nx/enforce-module-boundaries` forbids outright: `type:platform` may
 * never depend on `type:domain`). `apps/api`'s `AppModule` still has to
 * import this module once for Nest to instantiate it - `@Global()` only
 * changes provider VISIBILITY, not whether the module is part of the graph
 * at all.
 *
 * Imports `AccessModule` for `RequirePermission`/`ACCESS_CONTRACT`, used by
 * every controller here (and directly by `SectionsController` to resolve
 * scope constraints - see that file's own comment).
 */
@Global()
@Module({
  imports: [AccessModule],
  controllers: [CatalogController, TermsController, SectionsController, SchedulingController],
  providers: [
    GradeLevelService,
    DepartmentService,
    SubjectService,
    CourseService,
    RoomService,
    TermService,
    SectionService,
    SectionTeacherService,
    SectionEnrollmentService,
    BellScheduleService,
    SectionMeetingService,
    SectionScopeResolverService,
    AcademicService,
    { provide: ACADEMIC_CONTRACT, useExisting: AcademicService },
    { provide: SECTION_SCOPE_RESOLVER, useExisting: SectionScopeResolverService },
  ],
  exports: [ACADEMIC_CONTRACT, SECTION_SCOPE_RESOLVER],
})
export class AcademicModule {}
