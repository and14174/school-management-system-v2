// `contract.ts` is the only public surface of this module - everything a
// consumer needs (the `AuditContract` interface, its input/output types,
// and the `AUDIT_CONTRACT` DI token) lives there. `AuditModule` is exported
// alongside it because a NestJS module has to be importable somewhere to be
// wired into an app at all - it carries no implementation detail itself
// (`AuditService`, `infrastructure/schema.ts` and `domain/` stay internal).
export * from './contract.js';
export { AuditModule } from './audit.module.js';
