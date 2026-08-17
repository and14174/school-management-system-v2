import type { AcademicYearId, CampusId, DateOnly, TenantId } from '@sms/kernel';
import type { AcademicYear, AcademicYearStatus, Campus, CampusStatus, Tenant, TenantStatus } from '../domain/types.js';
import type { academicYearTable, campusTable, tenantTable } from './schema.js';

type TenantRow = typeof tenantTable.$inferSelect;
type CampusRow = typeof campusTable.$inferSelect;
type AcademicYearRow = typeof academicYearTable.$inferSelect;

export function toTenant(row: TenantRow): Tenant {
  return {
    id: row.id as TenantId,
    tenantId: row.tenantId as TenantId,
    slug: row.slug,
    name: row.name,
    legalName: row.legalName,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency,
    status: row.status as TenantStatus,
    branding: row.branding as Record<string, unknown>,
    featureFlags: row.featureFlags as Record<string, unknown>,
    terminology: row.terminology as Record<string, unknown>,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCampus(row: CampusRow): Campus {
  return {
    id: row.id as CampusId,
    tenantId: row.tenantId as TenantId,
    code: row.code,
    name: row.name,
    address: row.address as Record<string, unknown>,
    timezone: row.timezone,
    locale: row.locale,
    isDefault: row.isDefault,
    status: row.status as CampusStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toAcademicYear(row: AcademicYearRow): AcademicYear {
  return {
    id: row.id as AcademicYearId,
    tenantId: row.tenantId as TenantId,
    name: row.name,
    startsOn: row.startsOn as DateOnly,
    endsOn: row.endsOn as DateOnly,
    status: row.status as AcademicYearStatus,
    isCurrent: row.isCurrent,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
