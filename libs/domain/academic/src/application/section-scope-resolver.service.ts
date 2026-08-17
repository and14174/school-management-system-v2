import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { todayDateOnly, type DateOnly, type TenantId, type UserId } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { SectionScopeResolver } from '@sms/access';
import { scopedContext } from './scoped-context.js';

/**
 * This module's implementation of `@sms/access`'s `SectionScopeResolver`
 * port (`application/section-scope-resolver.ts` there) - the inversion that
 * lets a `section`-scoped permission grant resolve WITHOUT `@sms/access`
 * (`type:platform`) ever importing `@sms/academic` (`type:domain`). Bound to
 * the `SECTION_SCOPE_RESOLVER` token as a `@Global()` provider in
 * `AcademicModule` - see that file's own comment for why it must be
 * `@Global()` for `AbilityService` (living in a different module) to see it.
 *
 * `userId -> personId` goes through `identity.membership` by raw SQL (same
 * precedent as `AbilityService.allCampusIds`/`resolvePersonId`: this package
 * can reach `@sms/identity`'s public contract but not its internal schema
 * module, and a raw cross-schema read is the established escape hatch - see
 * also `SectionEnrollmentService.listStudentsInSection`'s own comment).
 * `personId -> section ids` then goes through this module's OWN
 * `academic.section_teacher` table directly (no cross-module reach needed
 * for that half).
 */
@Injectable()
export class SectionScopeResolverService implements SectionScopeResolver {
  async resolveTeachingSectionIds(userId: UserId, tenantId: TenantId, asOf?: DateOnly): Promise<string[]> {
    const resolveDate = asOf ?? todayDateOnly();
    const ctx = scopedContext(tenantId);

    const rows = await withTenantTx(ctx, (db) =>
      db.execute<{ section_id: string }>(sql`
        select distinct st.section_id
        from academic.section_teacher st
        join identity.membership m on m.person_id = st.person_id and m.tenant_id = st.tenant_id
        where st.tenant_id = ${tenantId}
          and m.user_id = ${userId}
          and st.valid_from <= ${resolveDate}
          and (st.valid_to is null or st.valid_to >= ${resolveDate})
      `),
    );

    return (rows as unknown as Array<{ section_id: string }>).map((row) => row.section_id);
  }
}
