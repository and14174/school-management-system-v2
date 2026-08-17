import { z } from 'zod';
import type { DocumentTemplate } from '@sms/documents';
import { REPORT_CARD_TEMPLATE_KEY } from '@sms/records';

/**
 * The real `report_card` `DocumentTemplate` - registered here (not inside
 * `@sms/records`, `type:domain`) because `@sms/documents` (`type:platform`)
 * may never depend on a domain module, and `apps/api` is the one layer
 * allowed to depend on both. See `@sms/documents`' `domain/types.ts` for the
 * inversion this follows, and `sample-certificate.template.ts` for the
 * template shape this copies: pure `render()`, no I/O, no ambient context,
 * self-contained print CSS with no external fetches.
 *
 * `dataSchema` mirrors `@sms/records`' `ReportCardSnapshot` - the EXACT
 * shape `RecordsContract.previewReportCard`/`issueReportCards` compute and
 * freeze (see the `1200` migration header: an issued report card is a
 * snapshot, not a live view). This template only ever renders what it is
 * handed; it never re-queries a grade.
 */
const reportCardCourseRowSchema = z.object({
  sectionId: z.string(),
  courseId: z.string(),
  courseCode: z.string(),
  courseName: z.string(),
  credits: z.number().nullable(),
  percentage: z.number().nullable(),
  letter: z.string().nullable(),
  gpaPoints: z.number().nullable(),
  gradeScaleVersionId: z.string().nullable(),
});

const reportCardAttendanceSummarySchema = z.object({
  totalCount: z.number(),
  presentCount: z.number(),
  presentRate: z.number(),
});

const reportCardDataSchema = z.object({
  personId: z.string(),
  studentName: z.string(),
  gradingPeriodId: z.string(),
  gradingPeriodName: z.string(),
  termId: z.string(),
  termName: z.string(),
  academicYearId: z.string().nullable(),
  academicYearName: z.string().nullable(),
  courses: z.array(reportCardCourseRowSchema),
  gpa: z.number().nullable(),
  attendanceSummary: reportCardAttendanceSummarySchema.nullable(),
  comments: z.string().nullable(),
  generatedAt: z.string(),
});

type ReportCardData = z.infer<typeof reportCardDataSchema>;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatNumber(value: number | null, decimals = 1): string {
  return value === null ? '—' : value.toFixed(decimals);
}

function renderCourseRow(course: ReportCardData['courses'][number]): string {
  return `
    <tr>
      <td class="course-code">${escapeHtml(course.courseCode)}</td>
      <td class="course-name">${escapeHtml(course.courseName)}</td>
      <td class="numeric">${course.credits === null ? '—' : course.credits}</td>
      <td class="numeric">${course.percentage === null ? '—' : `${formatNumber(course.percentage)}%`}</td>
      <td class="letter">${course.letter === null ? '—' : escapeHtml(course.letter)}</td>
      <td class="numeric">${formatNumber(course.gpaPoints, 2)}</td>
    </tr>
  `;
}

export const reportCardTemplate: DocumentTemplate<ReportCardData> = {
  key: REPORT_CARD_TEMPLATE_KEY,
  name: 'Report Card',
  dataSchema: reportCardDataSchema,

  async render(data) {
    const attendanceRows = data.attendanceSummary
      ? `
        <table class="attendance">
          <tr><th>Sessions recorded</th><td>${data.attendanceSummary.totalCount}</td></tr>
          <tr><th>Sessions present</th><td>${data.attendanceSummary.presentCount}</td></tr>
          <tr><th>Present rate</th><td>${formatNumber(data.attendanceSummary.presentRate)}%</td></tr>
        </table>
      `
      : `<p class="muted">No attendance data available for this period.</p>`;

    const html = `
      <div class="report-card">
        <header class="header">
          <div class="school-identity">
            <p class="school-name">School Management System</p>
            <p class="document-title">Report Card</p>
          </div>
          <div class="period-identity">
            <p><strong>${escapeHtml(data.gradingPeriodName)}</strong></p>
            <p>${escapeHtml(data.termName)}${data.academicYearName ? ` · ${escapeHtml(data.academicYearName)}` : ''}</p>
          </div>
        </header>

        <section class="student-identity">
          <p class="student-name">${escapeHtml(data.studentName)}</p>
          <p class="generated-at">Generated ${escapeHtml(new Date(data.generatedAt).toISOString().slice(0, 10))}</p>
        </section>

        <section class="courses">
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Course</th>
                <th class="numeric">Credits</th>
                <th class="numeric">Percentage</th>
                <th>Grade</th>
                <th class="numeric">GPA Pts</th>
              </tr>
            </thead>
            <tbody>
              ${data.courses.length > 0 ? data.courses.map(renderCourseRow).join('') : '<tr><td colspan="6" class="muted">No graded courses this period.</td></tr>'}
            </tbody>
          </table>
        </section>

        <section class="summary">
          <table class="summary-table">
            <tr><th>Term GPA</th><td>${formatNumber(data.gpa, 2)}</td></tr>
          </table>
        </section>

        <section class="attendance-section">
          <h2>Attendance</h2>
          ${attendanceRows}
        </section>

        <section class="comments">
          <h2>Comments</h2>
          <div class="comments-box">${data.comments ? escapeHtml(data.comments) : ''}</div>
        </section>

        <footer class="signature">
          <div class="signature-line"><span>Teacher signature</span></div>
          <div class="signature-line"><span>Parent/Guardian signature</span></div>
        </footer>
      </div>
    `;

    // Self-contained print CSS, no external fetches - see the module header
    // on `sample-certificate.template.ts`.
    const css = `
      @page { size: A4 portrait; margin: 18mm; }
      body { font-family: 'Segoe UI', Arial, sans-serif; color: #1f2933; font-size: 12px; }
      .report-card { max-width: 100%; }
      .header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 3px solid #1f2933; padding-bottom: 8px; margin-bottom: 12px; }
      .school-name { font-size: 11px; text-transform: uppercase; letter-spacing: 0.12em; color: #52606d; margin: 0; }
      .document-title { font-size: 22px; font-weight: 700; margin: 2px 0 0; }
      .period-identity { text-align: right; }
      .period-identity p { margin: 0; }
      .student-identity { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 14px; }
      .student-name { font-size: 16px; font-weight: 600; margin: 0; }
      .generated-at { color: #7b8794; font-size: 10px; margin: 0; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 14px; }
      thead th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: #52606d; border-bottom: 2px solid #cbd2d9; padding: 6px 8px; }
      tbody td, .summary-table td, .attendance td { padding: 6px 8px; border-bottom: 1px solid #e4e7eb; }
      .summary-table th, .attendance th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e4e7eb; width: 40%; }
      .numeric { text-align: right; }
      .letter { font-weight: 700; }
      .muted { color: #9aa5b1; font-style: italic; }
      .comments-box { min-height: 60px; border: 1px solid #cbd2d9; border-radius: 4px; padding: 8px; }
      .signature { display: flex; justify-content: space-between; margin-top: 32px; }
      .signature-line { width: 45%; border-top: 1px solid #1f2933; padding-top: 4px; font-size: 10px; color: #52606d; text-align: center; }
      h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #52606d; margin: 16px 0 6px; }
    `;

    return { html, css };
  },
};
