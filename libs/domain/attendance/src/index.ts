// The public surface other modules should depend on: the port
// (`AttendanceContract`), its DI token, and the domain types it deals in.
export * from './contract.js';

// `apps/api` additionally needs an actual NestJS module class to wire up.
export { AttendanceModule } from './api/attendance.module.js';

// Exported so `apps/api` (and this module's own tests) can reason about the
// free-edit lock window without duplicating the constant.
export { ATTENDANCE_LOCK_WINDOW_HOURS } from './application/attendance-record.service.js';
