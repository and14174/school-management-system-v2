import { Module } from '@nestjs/common';
import { AuditService } from './application/audit.service.js';
import { AUDIT_CONTRACT } from './contract.js';

/**
 * Wires `AuditService` behind the `AUDIT_CONTRACT` token. Consumers inject
 * `AuditContract` (the interface) via `@Inject(AUDIT_CONTRACT)`, never
 * `AuditService` directly - see `apps/api/src/health` for why explicit
 * `@Inject()` tokens are used throughout this codebase instead of
 * implicit type-based DI (tsx/esbuild's decorator-metadata emission does
 * not reliably resolve it).
 */
@Module({
  providers: [{ provide: AUDIT_CONTRACT, useClass: AuditService }],
  exports: [AUDIT_CONTRACT],
})
export class AuditModule {}
