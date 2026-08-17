import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { NotFoundError, newId, todayDateOnly, type DomainError, type PersonId, type Result, type TenantId, err, ok } from '@sms/kernel';
import { withTenantTx } from '@sms/db';
import type { AppAbility } from '@sms/access';
import type { CreateAlertInput } from '../contract.js';
import type { PersonAlert } from '../domain/types.js';
import { toPersonAlert } from '../infrastructure/mappers.js';
import { personAlertTable } from '../infrastructure/schema.js';
import { scopedContext } from './scoped-context.js';
import { toDomainError } from './sql-errors.js';

/**
 * Medical and safeguarding alerts are read through `@sms/access`'s separate
 * `people.student:read_medical` / `people.student:read_safeguarding`
 * permissions - never bundled with an ordinary profile read (see the `0500`
 * migration header and `@sms/access`'s field registry). Because a
 * `person_alert` row's sensitivity is determined by its OWN `category`
 * column rather than by which fixed field holds it, the enforcement point is
 * row-level filtering in `listAlerts` below, not `@sms/access`'s field
 * masking (which strips a fixed field name from every row uniformly - the
 * right tool when the field name itself is always sensitive, the wrong one
 * when sensitivity varies row-by-row). The Person profile detail response
 * (`PersonController`) separately surfaces two derived, field-masked
 * flags (`hasMedicalAlerts`/`hasSafeguardingAlerts`) for the `@sms/access`
 * field-registry demonstration the brief asks for - see that controller's
 * own comment.
 */
@Injectable()
export class AlertService {
  async createAlert(tenantId: TenantId, input: CreateAlertInput): Promise<Result<PersonAlert, DomainError>> {
    const ctx = scopedContext(tenantId);
    const id = newId();
    const validFrom = input.validFrom ?? todayDateOnly();
    try {
      const rows = await withTenantTx(ctx, (db) =>
        db
          .insert(personAlertTable)
          .values({
            id,
            tenantId,
            personId: input.personId,
            category: input.category,
            severity: input.severity,
            summary: input.summary,
            detail: input.detail ?? null,
            validFrom,
            validTo: input.validTo ?? null,
          })
          .returning(),
      );
      const row = rows[0];
      if (!row) {
        return err(new NotFoundError('Insert returned no row.'));
      }
      return ok(toPersonAlert(row));
    } catch (error) {
      return err(toDomainError(error, `Could not create "${input.category}" alert.`) as DomainError);
    }
  }

  /**
   * `ability: null` means a trusted, non-request caller (seed script,
   * system job) - every alert is returned unfiltered, exactly like
   * `FieldMaskingInterceptor` passes a response through unmasked when there
   * is no ambient user to check (see its own comment). A real request
   * always supplies the caller's compiled ability.
   */
  async listAlerts(tenantId: TenantId, personId: PersonId, ability: AppAbility | null): Promise<PersonAlert[]> {
    const ctx = scopedContext(tenantId);
    const rows = await withTenantTx(ctx, (db) =>
      db
        .select()
        .from(personAlertTable)
        .where(and(eq(personAlertTable.tenantId, tenantId), eq(personAlertTable.personId, personId)))
        .orderBy(personAlertTable.validFrom),
    );

    const alerts = rows.map(toPersonAlert);
    if (!ability) {
      return alerts;
    }

    return alerts.filter((alert) => {
      if (alert.category === 'medical') {
        return ability.can('read_medical', 'people.student');
      }
      if (alert.category === 'safeguarding') {
        return ability.can('read_safeguarding', 'people.student');
      }
      // 'access'/'other': no extra row-level check - reaching this method at
      // all already required 'people.person:read' at the controller
      // (@RequirePermission gates the endpoint before this ever runs), so a
      // second identical check here would only ever redundantly re-confirm
      // it, or - for a non-request caller with no ambient ability context to
      // build a REAL one from - incorrectly hide alerts a genuinely
      // permitted caller should see. Only medical/safeguarding get their own
      // separate permission, per the 0500 migration header.
      return true;
    });
  }
}
