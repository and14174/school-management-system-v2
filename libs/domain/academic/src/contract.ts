import type { AcademicYearId, CampusId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  BellSchedule,
  Course,
  DayOfWeek,
  Department,
  GradeLevel,
  GradingPeriod,
  Period,
  Room,
  ScheduleConflict,
  Section,
  SectionEnrollment,
  SectionEnrollmentStatus,
  SectionMeeting,
  SectionStudent,
  SectionTeacher,
  SectionTeacherRole,
  Subject,
  Substitution,
  TeacherWorkload,
  Term,
  TimeOfDay,
  TimetableEntry,
} from './domain/types.js';

export * from './domain/types.js';

export interface CreateGradeLevelInput {
  readonly code: string;
  readonly name: string;
  readonly sequence?: number;
}
export type UpdateGradeLevelInput = Partial<CreateGradeLevelInput>;

export interface CreateDepartmentInput {
  readonly code: string;
  readonly name: string;
}
export type UpdateDepartmentInput = Partial<CreateDepartmentInput>;

export interface CreateSubjectInput {
  readonly departmentId: string;
  readonly code: string;
  readonly name: string;
}
export type UpdateSubjectInput = Partial<CreateSubjectInput>;

export interface CreateCourseInput {
  readonly subjectId: string;
  readonly gradeLevelId: string;
  readonly code: string;
  readonly name: string;
  readonly credits?: number | null;
}
export type UpdateCourseInput = Partial<CreateCourseInput>;

export interface CreateRoomInput {
  readonly campusId: CampusId;
  readonly code: string;
  readonly name: string;
  readonly capacity?: number | null;
}
export type UpdateRoomInput = Partial<CreateRoomInput>;

export interface CreateTermInput {
  readonly academicYearId: AcademicYearId;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly sequence?: number;
}
export type UpdateTermInput = Partial<Omit<CreateTermInput, 'academicYearId'>>;

export interface CreateGradingPeriodInput {
  readonly termId: string;
  readonly name: string;
  readonly startsOn: DateOnly;
  readonly endsOn: DateOnly;
  readonly sequence?: number;
}

export interface CreateSectionInput {
  readonly courseId: string;
  readonly termId: string;
  readonly campusId: CampusId;
  readonly roomId?: string | null;
  readonly code: string;
  readonly name: string;
  readonly capacity?: number | null;
}
export type UpdateSectionInput = Partial<Omit<CreateSectionInput, 'termId'>>;

export interface ListSectionsInput {
  readonly termId?: string;
  readonly courseId?: string;
  readonly campusId?: CampusId;
}

export interface AssignTeacherInput {
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly role?: SectionTeacherRole;
  readonly validFrom?: DateOnly;
  readonly validTo?: DateOnly | null;
}

export interface EndTeacherAssignmentInput {
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly role?: SectionTeacherRole;
  readonly asOf?: DateOnly;
}

export interface EnrolStudentInput {
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly validFrom?: DateOnly;
}

export interface EndEnrollmentInput {
  readonly sectionId: string;
  readonly personId: PersonId;
  readonly asOf?: DateOnly;
  readonly status?: SectionEnrollmentStatus;
}

export interface TransferStudentInput {
  readonly personId: PersonId;
  readonly fromSectionId: string;
  readonly toSectionId: string;
  /** The day the student starts in `toSectionId`; `fromSectionId`'s enrollment ends the day before. Defaults to today. */
  readonly effectiveFrom?: DateOnly;
}

export interface TransferStudentResult {
  readonly endedEnrollment: SectionEnrollment;
  readonly newEnrollment: SectionEnrollment;
}

// =============================================================================
// Scheduling / timetabling - see the `0610` migration header.
// =============================================================================

export interface CreateBellScheduleInput {
  readonly campusId: CampusId;
  readonly academicYearId: AcademicYearId;
  readonly name: string;
  readonly isDefault?: boolean;
}
export type UpdateBellScheduleInput = Partial<Pick<CreateBellScheduleInput, 'name' | 'isDefault'>>;

export interface ListBellSchedulesInput {
  readonly campusId?: CampusId;
  readonly academicYearId?: AcademicYearId;
}

export interface CreatePeriodInput {
  readonly bellScheduleId: string;
  readonly name: string;
  readonly sequence?: number;
  readonly startsAt: TimeOfDay;
  readonly endsAt: TimeOfDay;
  readonly isInstructional?: boolean;
}
export type UpdatePeriodInput = Partial<Omit<CreatePeriodInput, 'bellScheduleId'>>;

export interface SetSectionMeetingInput {
  readonly periodId: string;
  readonly dayOfWeek: DayOfWeek;
  readonly roomId?: string | null;
  /** Defaults to today. */
  readonly validFrom?: DateOnly;
  readonly validTo?: DateOnly | null;
}

export interface DateRange {
  readonly from: DateOnly;
  readonly to: DateOnly;
}

export interface AssignSubstituteInput {
  readonly sectionMeetingId: string;
  readonly date: DateOnly;
  readonly substitutePersonId: PersonId;
  readonly reason?: string | null;
}

/**
 * The public port this module exposes to the rest of the system
 * (`apps/api`'s `AcademicController`s) - matching `@sms/people`'s
 * `PeopleContract` pattern: every other module should depend on this
 * interface, not on the concrete `AcademicService` behind it.
 *
 * Every method resolves the ambient ordinary tenant context
 * (`currentTenantContext()`) - `AcademicService` (the implementation behind
 * this interface) is the REST-facing facade; the individual services it
 * composes take `tenantId` explicitly so they also work from `seed.ts` and
 * from tests with no ambient context at all.
 */
export interface AcademicContract {
  createGradeLevel(input: CreateGradeLevelInput): Promise<Result<GradeLevel, DomainError>>;
  listGradeLevels(): Promise<GradeLevel[]>;
  updateGradeLevel(id: string, input: UpdateGradeLevelInput): Promise<Result<GradeLevel, DomainError>>;

  createDepartment(input: CreateDepartmentInput): Promise<Result<Department, DomainError>>;
  listDepartments(): Promise<Department[]>;
  updateDepartment(id: string, input: UpdateDepartmentInput): Promise<Result<Department, DomainError>>;

  createSubject(input: CreateSubjectInput): Promise<Result<Subject, DomainError>>;
  listSubjects(): Promise<Subject[]>;
  updateSubject(id: string, input: UpdateSubjectInput): Promise<Result<Subject, DomainError>>;

  createCourse(input: CreateCourseInput): Promise<Result<Course, DomainError>>;
  listCourses(): Promise<Course[]>;
  updateCourse(id: string, input: UpdateCourseInput): Promise<Result<Course, DomainError>>;

  createRoom(input: CreateRoomInput): Promise<Result<Room, DomainError>>;
  listRooms(): Promise<Room[]>;
  updateRoom(id: string, input: UpdateRoomInput): Promise<Result<Room, DomainError>>;

  createTerm(input: CreateTermInput): Promise<Result<Term, DomainError>>;
  listTerms(academicYearId?: AcademicYearId): Promise<Term[]>;
  updateTerm(id: string, input: UpdateTermInput): Promise<Result<Term, DomainError>>;

  createGradingPeriod(input: CreateGradingPeriodInput): Promise<Result<GradingPeriod, DomainError>>;
  listGradingPeriods(termId: string): Promise<GradingPeriod[]>;

  createSection(input: CreateSectionInput): Promise<Result<Section, DomainError>>;
  getSection(id: string): Promise<Result<Section, NotFoundError>>;
  listSections(filter?: ListSectionsInput): Promise<Section[]>;
  updateSection(id: string, input: UpdateSectionInput): Promise<Result<Section, DomainError>>;

  assignTeacher(input: AssignTeacherInput): Promise<Result<SectionTeacher, DomainError>>;
  endTeacherAssignment(input: EndTeacherAssignmentInput): Promise<Result<void, DomainError>>;
  /** Sections `personId` currently teaches (or as of `asOf`), via `academic.section_teacher`. */
  listSectionsForTeacher(personId: PersonId, asOf?: DateOnly): Promise<Section[]>;
  listTeachersForSection(sectionId: string, asOf?: DateOnly): Promise<SectionTeacher[]>;

  enrolStudent(input: EnrolStudentInput): Promise<Result<SectionEnrollment, DomainError>>;
  /** Ends the old enrollment and creates the new one in a single transaction - see `SectionEnrollmentService.transferStudent`. */
  transferStudent(input: TransferStudentInput): Promise<Result<TransferStudentResult, DomainError>>;
  endEnrollment(input: EndEnrollmentInput): Promise<Result<void, DomainError>>;
  /** Students currently enrolled in `sectionId` (or as of `asOf`), enriched with name fields. */
  listStudentsInSection(sectionId: string, asOf?: DateOnly): Promise<SectionStudent[]>;

  // ---------------------------------------------------------------------
  // Scheduling / timetabling - see the `0610` migration header for the
  // conflict-detection design (database exclusion constraint for rooms, a
  // trigger for teachers, effective-dated meetings).
  // ---------------------------------------------------------------------

  createBellSchedule(input: CreateBellScheduleInput): Promise<Result<BellSchedule, DomainError>>;
  listBellSchedules(filter?: ListBellSchedulesInput): Promise<BellSchedule[]>;
  updateBellSchedule(id: string, input: UpdateBellScheduleInput): Promise<Result<BellSchedule, DomainError>>;

  createPeriod(input: CreatePeriodInput): Promise<Result<Period, DomainError>>;
  listPeriods(bellScheduleId: string): Promise<Period[]>;
  updatePeriod(id: string, input: UpdatePeriodInput): Promise<Result<Period, DomainError>>;

  /**
   * Bulk-creates `sectionId`'s meetings in one transaction (all-or-nothing) -
   * the room/teacher conflict checks are database constraints/triggers, so a
   * conflicting meeting anywhere in the batch rolls the whole call back
   * rather than leaving a partially-scheduled section. Does not end-date any
   * pre-existing open meetings first (same effective-dating idiom as
   * `section_teacher`'s `assignTeacher`/`endTeacherAssignment`: ending a
   * meeting - a schedule change mid-year - is a separate, explicit act, not
   * an implicit side effect of adding new ones).
   */
  setSectionMeetings(sectionId: string, meetings: SetSectionMeetingInput[]): Promise<Result<SectionMeeting[], DomainError>>;
  /** `sectionId`'s currently-effective meetings (or as of `asOf`). */
  listMeetingsForSection(sectionId: string, asOf?: DateOnly): Promise<SectionMeeting[]>;

  /** `personId`'s teaching timetable over `range`, resolving substitutions: a date they were substituted OUT of is excluded, a date they substituted INTO (for someone else's section) is included. */
  getTimetableForTeacher(personId: PersonId, range: DateRange): Promise<TimetableEntry[]>;
  /** `personId`'s (a student's) class timetable over `range`, via their current section enrollments. */
  getTimetableForStudent(personId: PersonId, range: DateRange): Promise<TimetableEntry[]>;
  /** Every meeting scheduled in `roomId` over `range` - what a facilities view uses to check room availability. */
  getRoomTimetable(roomId: string, range: DateRange): Promise<TimetableEntry[]>;

  /** Records a substitute for one meeting occurrence. The absent teacher is resolved from the meeting's section's currently-assigned (`lead`, falling back to any) teacher as of `date` - not accepted as caller input, so it can never be misattributed. */
  assignSubstitute(input: AssignSubstituteInput): Promise<Result<Substitution, DomainError>>;

  /** Periods-per-week and section count per teacher, across every section meeting in `academicYearId` - for spotting an overloaded timetable. */
  getTeacherWorkload(academicYearId: AcademicYearId): Promise<TeacherWorkload[]>;

  /** Existing room/teacher double-bookings in `academicYearId`'s data - for an admin to find problems that predate the `0610` constraints (a bulk import, a direct SQL write). New writes cannot create these; this is a report, not a live check. */
  detectConflicts(academicYearId: AcademicYearId): Promise<ScheduleConflict[]>;
}

/**
 * DI token for `AcademicContract` - see `TENANCY_CONTRACT` in `@sms/tenancy`
 * for why a concrete Symbol token is used instead of relying on implicit
 * type-based DI.
 */
export const ACADEMIC_CONTRACT = Symbol('ACADEMIC_CONTRACT');
