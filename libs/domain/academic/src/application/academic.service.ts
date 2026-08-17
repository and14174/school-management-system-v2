import { Inject, Injectable } from '@nestjs/common';
import type { AcademicYearId, DateOnly, DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  AcademicContract,
  AssignSubstituteInput,
  AssignTeacherInput,
  CreateBellScheduleInput,
  CreateCourseInput,
  CreateDepartmentInput,
  CreateGradeLevelInput,
  CreateGradingPeriodInput,
  CreatePeriodInput,
  CreateRoomInput,
  CreateSectionInput,
  CreateSubjectInput,
  CreateTermInput,
  DateRange,
  EndEnrollmentInput,
  EndTeacherAssignmentInput,
  EnrolStudentInput,
  ListBellSchedulesInput,
  ListSectionsInput,
  SetSectionMeetingInput,
  TransferStudentInput,
  TransferStudentResult,
  UpdateBellScheduleInput,
  UpdateCourseInput,
  UpdateDepartmentInput,
  UpdateGradeLevelInput,
  UpdatePeriodInput,
  UpdateRoomInput,
  UpdateSectionInput,
  UpdateSubjectInput,
  UpdateTermInput,
} from '../contract.js';
import type {
  BellSchedule,
  Course,
  Department,
  GradeLevel,
  GradingPeriod,
  Period,
  Room,
  ScheduleConflict,
  Section,
  SectionEnrollment,
  SectionMeeting,
  SectionStudent,
  SectionTeacher,
  Subject,
  Substitution,
  TeacherWorkload,
  Term,
  TimetableEntry,
} from '../domain/types.js';
import { BellScheduleService } from './bell-schedule.service.js';
import { CourseService } from './course.service.js';
import { currentTenantContext } from './current-context.js';
import { DepartmentService } from './department.service.js';
import { GradeLevelService } from './grade-level.service.js';
import { RoomService } from './room.service.js';
import { SectionEnrollmentService } from './section-enrollment.service.js';
import { SectionMeetingService } from './section-meeting.service.js';
import { SectionService } from './section.service.js';
import { SectionTeacherService } from './section-teacher.service.js';
import { SubjectService } from './subject.service.js';
import { TermService } from './term.service.js';

/**
 * Implements `AcademicContract`. Thin composition layer over the individual
 * services - exactly the shape `PeopleService` composes `PersonService`/
 * `RoleService`/... in `@sms/people`. Every method resolves the ambient
 * tenant via `currentTenantContext()`; the services underneath all take
 * `tenantId` explicitly so they also work from `seed.ts` and from tests with
 * no ambient context at all.
 */
@Injectable()
export class AcademicService implements AcademicContract {
  constructor(
    @Inject(GradeLevelService) private readonly gradeLevels: GradeLevelService,
    @Inject(DepartmentService) private readonly departments: DepartmentService,
    @Inject(SubjectService) private readonly subjects: SubjectService,
    @Inject(CourseService) private readonly courses: CourseService,
    @Inject(RoomService) private readonly rooms: RoomService,
    @Inject(TermService) private readonly terms: TermService,
    @Inject(SectionService) private readonly sections: SectionService,
    @Inject(SectionTeacherService) private readonly sectionTeachers: SectionTeacherService,
    @Inject(SectionEnrollmentService) private readonly sectionEnrollments: SectionEnrollmentService,
    @Inject(BellScheduleService) private readonly bellSchedules: BellScheduleService,
    @Inject(SectionMeetingService) private readonly sectionMeetings: SectionMeetingService,
  ) {}

  createGradeLevel(input: CreateGradeLevelInput): Promise<Result<GradeLevel, DomainError>> {
    return this.gradeLevels.create(currentTenantContext().tenantId, input);
  }
  listGradeLevels(): Promise<GradeLevel[]> {
    return this.gradeLevels.list(currentTenantContext().tenantId);
  }
  updateGradeLevel(id: string, input: UpdateGradeLevelInput): Promise<Result<GradeLevel, DomainError>> {
    return this.gradeLevels.update(currentTenantContext().tenantId, id, input);
  }

  createDepartment(input: CreateDepartmentInput): Promise<Result<Department, DomainError>> {
    return this.departments.create(currentTenantContext().tenantId, input);
  }
  listDepartments(): Promise<Department[]> {
    return this.departments.list(currentTenantContext().tenantId);
  }
  updateDepartment(id: string, input: UpdateDepartmentInput): Promise<Result<Department, DomainError>> {
    return this.departments.update(currentTenantContext().tenantId, id, input);
  }

  createSubject(input: CreateSubjectInput): Promise<Result<Subject, DomainError>> {
    return this.subjects.create(currentTenantContext().tenantId, input);
  }
  listSubjects(): Promise<Subject[]> {
    return this.subjects.list(currentTenantContext().tenantId);
  }
  updateSubject(id: string, input: UpdateSubjectInput): Promise<Result<Subject, DomainError>> {
    return this.subjects.update(currentTenantContext().tenantId, id, input);
  }

  createCourse(input: CreateCourseInput): Promise<Result<Course, DomainError>> {
    return this.courses.create(currentTenantContext().tenantId, input);
  }
  listCourses(): Promise<Course[]> {
    return this.courses.list(currentTenantContext().tenantId);
  }
  updateCourse(id: string, input: UpdateCourseInput): Promise<Result<Course, DomainError>> {
    return this.courses.update(currentTenantContext().tenantId, id, input);
  }

  createRoom(input: CreateRoomInput): Promise<Result<Room, DomainError>> {
    return this.rooms.create(currentTenantContext().tenantId, input);
  }
  listRooms(): Promise<Room[]> {
    return this.rooms.list(currentTenantContext().tenantId);
  }
  updateRoom(id: string, input: UpdateRoomInput): Promise<Result<Room, DomainError>> {
    return this.rooms.update(currentTenantContext().tenantId, id, input);
  }

  createTerm(input: CreateTermInput): Promise<Result<Term, DomainError>> {
    return this.terms.createTerm(currentTenantContext().tenantId, input);
  }
  listTerms(academicYearId?: AcademicYearId): Promise<Term[]> {
    return this.terms.listTerms(currentTenantContext().tenantId, academicYearId);
  }
  updateTerm(id: string, input: UpdateTermInput): Promise<Result<Term, DomainError>> {
    return this.terms.updateTerm(currentTenantContext().tenantId, id, input);
  }

  createGradingPeriod(input: CreateGradingPeriodInput): Promise<Result<GradingPeriod, DomainError>> {
    return this.terms.createGradingPeriod(currentTenantContext().tenantId, input);
  }
  listGradingPeriods(termId: string): Promise<GradingPeriod[]> {
    return this.terms.listGradingPeriods(currentTenantContext().tenantId, termId);
  }

  createSection(input: CreateSectionInput): Promise<Result<Section, DomainError>> {
    return this.sections.create(currentTenantContext().tenantId, input);
  }
  getSection(id: string): Promise<Result<Section, NotFoundError>> {
    return this.sections.get(currentTenantContext().tenantId, id);
  }
  listSections(filter?: ListSectionsInput): Promise<Section[]> {
    return this.sections.list(currentTenantContext().tenantId, filter);
  }
  updateSection(id: string, input: UpdateSectionInput): Promise<Result<Section, DomainError>> {
    return this.sections.update(currentTenantContext().tenantId, id, input);
  }

  assignTeacher(input: AssignTeacherInput): Promise<Result<SectionTeacher, DomainError>> {
    return this.sectionTeachers.assignTeacher(currentTenantContext().tenantId, input);
  }
  endTeacherAssignment(input: EndTeacherAssignmentInput): Promise<Result<void, DomainError>> {
    return this.sectionTeachers.endTeacherAssignment(currentTenantContext().tenantId, input);
  }
  listSectionsForTeacher(personId: PersonId, asOf?: DateOnly): Promise<Section[]> {
    return this.sectionTeachers.listSectionsForTeacher(currentTenantContext().tenantId, personId, asOf);
  }
  listTeachersForSection(sectionId: string, asOf?: DateOnly): Promise<SectionTeacher[]> {
    return this.sectionTeachers.listTeachersForSection(currentTenantContext().tenantId, sectionId, asOf);
  }

  enrolStudent(input: EnrolStudentInput): Promise<Result<SectionEnrollment, DomainError>> {
    return this.sectionEnrollments.enrolStudent(currentTenantContext().tenantId, input);
  }
  transferStudent(input: TransferStudentInput): Promise<Result<TransferStudentResult, DomainError>> {
    return this.sectionEnrollments.transferStudent(currentTenantContext().tenantId, input);
  }
  endEnrollment(input: EndEnrollmentInput): Promise<Result<void, DomainError>> {
    return this.sectionEnrollments.endEnrollment(currentTenantContext().tenantId, input);
  }
  listStudentsInSection(sectionId: string, asOf?: DateOnly): Promise<SectionStudent[]> {
    return this.sectionEnrollments.listStudentsInSection(currentTenantContext().tenantId, sectionId, asOf);
  }

  createBellSchedule(input: CreateBellScheduleInput): Promise<Result<BellSchedule, DomainError>> {
    return this.bellSchedules.createBellSchedule(currentTenantContext().tenantId, input);
  }
  listBellSchedules(filter?: ListBellSchedulesInput): Promise<BellSchedule[]> {
    return this.bellSchedules.listBellSchedules(currentTenantContext().tenantId, filter);
  }
  updateBellSchedule(id: string, input: UpdateBellScheduleInput): Promise<Result<BellSchedule, DomainError>> {
    return this.bellSchedules.updateBellSchedule(currentTenantContext().tenantId, id, input);
  }

  createPeriod(input: CreatePeriodInput): Promise<Result<Period, DomainError>> {
    return this.bellSchedules.createPeriod(currentTenantContext().tenantId, input);
  }
  listPeriods(bellScheduleId: string): Promise<Period[]> {
    return this.bellSchedules.listPeriods(currentTenantContext().tenantId, bellScheduleId);
  }
  updatePeriod(id: string, input: UpdatePeriodInput): Promise<Result<Period, DomainError>> {
    return this.bellSchedules.updatePeriod(currentTenantContext().tenantId, id, input);
  }

  setSectionMeetings(sectionId: string, meetings: SetSectionMeetingInput[]): Promise<Result<SectionMeeting[], DomainError>> {
    return this.sectionMeetings.setSectionMeetings(currentTenantContext().tenantId, sectionId, meetings);
  }
  listMeetingsForSection(sectionId: string, asOf?: DateOnly): Promise<SectionMeeting[]> {
    return this.sectionMeetings.listMeetingsForSection(currentTenantContext().tenantId, sectionId, asOf);
  }

  getTimetableForTeacher(personId: PersonId, range: DateRange): Promise<TimetableEntry[]> {
    return this.sectionMeetings.getTimetableForTeacher(currentTenantContext().tenantId, personId, range);
  }
  getTimetableForStudent(personId: PersonId, range: DateRange): Promise<TimetableEntry[]> {
    return this.sectionMeetings.getTimetableForStudent(currentTenantContext().tenantId, personId, range);
  }
  getRoomTimetable(roomId: string, range: DateRange): Promise<TimetableEntry[]> {
    return this.sectionMeetings.getRoomTimetable(currentTenantContext().tenantId, roomId, range);
  }

  assignSubstitute(input: AssignSubstituteInput): Promise<Result<Substitution, DomainError>> {
    return this.sectionMeetings.assignSubstitute(currentTenantContext().tenantId, input);
  }

  getTeacherWorkload(academicYearId: AcademicYearId): Promise<TeacherWorkload[]> {
    return this.sectionMeetings.getTeacherWorkload(currentTenantContext().tenantId, academicYearId);
  }

  detectConflicts(academicYearId: AcademicYearId): Promise<ScheduleConflict[]> {
    return this.sectionMeetings.detectConflicts(currentTenantContext().tenantId, academicYearId);
  }
}
