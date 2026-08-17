import type { AcademicYearId, CampusId, TenantId } from '@sms/kernel';
import type { DateOnly } from '@sms/kernel';

export type TenantStatus = 'active' | 'trial' | 'suspended';
export type CampusStatus = 'active' | 'inactive';
export type AcademicYearStatus = 'planning' | 'open' | 'locked' | 'archived';

/** Mirrors `tenancy.tenant`. `tenantId` always equals `id` - see the migration comment. */
export interface Tenant {
  readonly id: TenantId;
  readonly tenantId: TenantId;
  readonly slug: string;
  readonly name: string;
  readonly legalName: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly status: TenantStatus;
  readonly branding: Record<string, unknown>;
  readonly featureFlags: Record<string, unknown>;
  readonly terminology: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `tenancy.campus`. */
export interface Campus {
  readonly id: CampusId;
  readonly tenantId: TenantId;
  readonly code: string;
  readonly name: string;
  readonly address: Record<string, unknown>;
  readonly timezone: string;
  readonly locale: string;
  readonly isDefault: boolean;
  readonly status: CampusStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Mirrors `tenancy.academic_year`. */
export interface AcademicYear {
  readonly id: AcademicYearId;
  readonly tenantId: TenantId;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly status: AcademicYearStatus;
  readonly isCurrent: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
