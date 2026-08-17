import { Module } from '@nestjs/common';
import { AccessModule } from '@sms/access';
import { AuditModule } from '@sms/audit';
import { OutboxModule } from '@sms/outbox';
import { GRADEBOOK_CONTRACT } from '../contract.js';
import { AssignmentService } from '../application/assignment.service.js';
import { CalculationRuleSetService } from '../application/calculation-rule-set.service.js';
import { CategoryService } from '../application/category.service.js';
import { CorrectionService } from '../application/correction.service.js';
import { GradeScaleService } from '../application/grade-scale.service.js';
import { GradebookService } from '../application/gradebook.service.js';
import { GradingPeriodLockService } from '../application/grading-period-lock.service.js';
import { OutcomeService } from '../application/outcome.service.js';
import { ScoreService } from '../application/score.service.js';
import { GradebookController } from './gradebook.controller.js';

/**
 * Exports `GRADEBOOK_CONTRACT` (not the concrete `GradebookService`) -
 * matching `@sms/attendance`'s `AttendanceModule` shape. Imports
 * `AccessModule`: `GradebookController` gates every route with
 * `@RequirePermission` and additionally calls `ACCESS_CONTRACT.
 * resolveScopeConstraints` directly. Imports `OutboxModule`: `ScoreService.
 * enterScores`/`AssignmentService.publishAssignment` publish
 * `gradebook.score_entered`/`gradebook.grade_posted` through `OUTBOX_CONTRACT`
 * in the same transaction as the write. Imports `AuditModule` for parity
 * with `@sms/attendance`/`@sms/enrollment` even though nothing here calls
 * `AUDIT_CONTRACT` directly - every table's history is captured
 * automatically by the `audit.attach_history` DB trigger.
 */
@Module({
  imports: [AccessModule, AuditModule, OutboxModule],
  controllers: [GradebookController],
  providers: [
    GradeScaleService,
    CalculationRuleSetService,
    CategoryService,
    AssignmentService,
    ScoreService,
    CorrectionService,
    GradingPeriodLockService,
    OutcomeService,
    GradebookService,
    { provide: GRADEBOOK_CONTRACT, useExisting: GradebookService },
  ],
  exports: [GRADEBOOK_CONTRACT],
})
export class GradebookModule {}
