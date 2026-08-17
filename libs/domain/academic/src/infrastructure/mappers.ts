import type { AcademicYearId, CampusId, DateOnly, PersonId, TenantId } from '@sms/kernel';
import type {
  BellSchedule,
  Course,
  DayOfWeek,
  Department,
  GradeLevel,
  GradingPeriod,
  Period,
  Room,
  Section,
  SectionEnrollment,
  SectionEnrollmentStatus,
  SectionMeeting,
  SectionTeacher,
  SectionTeacherRole,
  Subject,
  Substitution,
  Term,
  TimeOfDay,
} from '../domain/types.js';
import type {
  bellScheduleTable,
  courseTable,
  departmentTable,
  gradeLevelTable,
  gradingPeriodTable,
  periodTable,
  roomTable,
  sectionEnrollmentTable,
  sectionMeetingTable,
  sectionTable,
  sectionTeacherTable,
  subjectTable,
  substitutionTable,
  termTable,
} from './schema.js';

type TermRow = typeof termTable.$inferSelect;
type GradingPeriodRow = typeof gradingPeriodTable.$inferSelect;
type GradeLevelRow = typeof gradeLevelTable.$inferSelect;
type DepartmentRow = typeof departmentTable.$inferSelect;
type SubjectRow = typeof subjectTable.$inferSelect;
type CourseRow = typeof courseTable.$inferSelect;
type RoomRow = typeof roomTable.$inferSelect;
type SectionRow = typeof sectionTable.$inferSelect;
type SectionTeacherRow = typeof sectionTeacherTable.$inferSelect;
type SectionEnrollmentRow = typeof sectionEnrollmentTable.$inferSelect;
type BellScheduleRow = typeof bellScheduleTable.$inferSelect;
type PeriodRow = typeof periodTable.$inferSelect;
type SectionMeetingRow = typeof sectionMeetingTable.$inferSelect;
type SubstitutionRow = typeof substitutionTable.$inferSelect;

export function toTerm(row: TermRow): Term {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    academicYearId: row.academicYearId as AcademicYearId,
    name: row.name,
    startsOn: row.startsOn as DateOnly,
    endsOn: row.endsOn as DateOnly,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toGradingPeriod(row: GradingPeriodRow): GradingPeriod {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    termId: row.termId,
    name: row.name,
    startsOn: row.startsOn as DateOnly,
    endsOn: row.endsOn as DateOnly,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toGradeLevel(row: GradeLevelRow): GradeLevel {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    code: row.code,
    name: row.name,
    sequence: row.sequence,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toDepartment(row: DepartmentRow): Department {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSubject(row: SubjectRow): Subject {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    departmentId: row.departmentId,
    code: row.code,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toCourse(row: CourseRow): Course {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    subjectId: row.subjectId,
    gradeLevelId: row.gradeLevelId,
    code: row.code,
    name: row.name,
    credits: row.credits === null ? null : Number(row.credits),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toRoom(row: RoomRow): Room {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    campusId: row.campusId as CampusId,
    code: row.code,
    name: row.name,
    capacity: row.capacity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSection(row: SectionRow): Section {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    courseId: row.courseId,
    termId: row.termId,
    campusId: row.campusId as CampusId,
    roomId: row.roomId,
    code: row.code,
    name: row.name,
    capacity: row.capacity,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSectionTeacher(row: SectionTeacherRow): SectionTeacher {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    personId: row.personId as PersonId,
    role: row.role as SectionTeacherRole,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSectionEnrollment(row: SectionEnrollmentRow): SectionEnrollment {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    personId: row.personId as PersonId,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    status: row.status as SectionEnrollmentStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toBellSchedule(row: BellScheduleRow): BellSchedule {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    campusId: row.campusId as CampusId,
    academicYearId: row.academicYearId as AcademicYearId,
    name: row.name,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toPeriod(row: PeriodRow): Period {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    bellScheduleId: row.bellScheduleId,
    name: row.name,
    sequence: row.sequence,
    startsAt: row.startsAt as TimeOfDay,
    endsAt: row.endsAt as TimeOfDay,
    isInstructional: row.isInstructional,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSectionMeeting(row: SectionMeetingRow): SectionMeeting {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionId: row.sectionId,
    periodId: row.periodId,
    dayOfWeek: row.dayOfWeek as DayOfWeek,
    roomId: row.roomId,
    validFrom: row.validFrom as DateOnly,
    validTo: (row.validTo as DateOnly | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSubstitution(row: SubstitutionRow): Substitution {
  return {
    id: row.id,
    tenantId: row.tenantId as TenantId,
    sectionMeetingId: row.sectionMeetingId,
    date: row.date as DateOnly,
    absentPersonId: row.absentPersonId as PersonId,
    substitutePersonId: row.substitutePersonId as PersonId,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
