// The public surface other modules should depend on: the port
// (`GradebookContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { GradebookModule } from './api/gradebook.module.js';

// Exported so `apps/api` (and this module's own tests) can reuse the
// evaluator without duplicating it.
export { evaluateStudentGrade, resolveLetter, type AssignmentScoreInput, type CategoryScoreInput, type EvaluationResult } from './application/evaluator.js';
