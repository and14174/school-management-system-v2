import type { Tx } from '@sms/db';
import type { Result } from '@sms/kernel';
import type { ColumnMapping, ImportFieldSpec, RowError } from '../domain/types.js';

/**
 * The inversion point that lets this module (`type:platform`) know how to
 * import into `people.person` (`type:domain`, `@sms/people`) WITHOUT ever
 * depending on it - `@nx/enforce-module-boundaries` forbids that direction
 * outright, and for good reason: platform modules are meant to be usable by
 * every domain module, not coupled to one of them.
 *
 * Exactly the pattern `@sms/access` uses for `SECTION_SCOPE_RESOLVER` (see
 * `libs/platform/access/src/application/section-scope-resolver.ts`): this
 * module defines the PORT (`ImportTarget<TRow>`) and a token
 * (`IMPORT_TARGET_REGISTRY`) that resolves to a zero-widening default
 * (`DEFAULT_IMPORT_TARGET_REGISTRY`, below) when nothing overrides it;
 * `apps/api` is the one layer allowed to depend on both `type:platform` and
 * `type:domain`, so it is the one place a concrete target (e.g. a
 * `people.person` target built against `@sms/people`'s `PeopleContract`) is
 * ever registered - see `apps/api/src/import-export/people-import-target.ts`.
 * This module itself never implements a real target; its own test suite uses
 * a fake one against a scratch table (see `import-export.spec.ts`).
 *
 * Unlike `SECTION_SCOPE_RESOLVER` (one resolver, one method), an import
 * pipeline needs to serve several entity types at once (`people.person`
 * today, more later), so the token here resolves to a small REGISTRY object
 * rather than a single target directly - `ImportTargetRegistry.get` is what
 * `ImportExportService`/`PipelineService` call to find the target for a
 * job's `entityType`.
 */
export interface ImportTargetRegistry {
  /** Every registered target's public summary - for `listTargets()` (the mapping UI). */
  list(): ReadonlyArray<Pick<ImportTarget<unknown>, 'entityType' | 'fields'>>;

  /** The target for `entityType`, or `undefined` if nothing has registered one. */
  get(entityType: string): ImportTarget<unknown> | undefined;
}

export const IMPORT_TARGET_REGISTRY = Symbol('IMPORT_TARGET_REGISTRY');

/**
 * The safe default: preserves fail-closed behaviour when nothing implements
 * the port (no target module wired up yet, or a test that constructs the
 * pipeline services directly) - a MISSING registry must never make an
 * entity type appear importable when nothing can actually write it, so this
 * resolves to "no targets" rather than throwing.
 */
export const DEFAULT_IMPORT_TARGET_REGISTRY: ImportTargetRegistry = {
  list: () => [],
  get: () => undefined,
};

/**
 * A tenant-scoped, bulk-operation-scoped database handle - exactly the `Tx`
 * `@sms/audit`'s `AuditContract.withBulkOperation` hands its callback,
 * re-exported under this name so a target implementation never has to
 * import `@sms/audit` (a *different* platform module) just to spell the type
 * of the handle `create`/`update` are given.
 */
export type ImportTx = Tx;

/**
 * One entity type an import can target (`people.person`, eventually
 * `academic.section_roster`, ...). Implemented outside this module (see the
 * file comment above) and supplied through `IMPORT_TARGET_REGISTRY`.
 *
 * `parseRow` is the ONE function `dryRun` and `commit` both call to go from a
 * raw CSV row to a validated, target-shaped row - see `PipelineService`. It
 * is async because real validation is (e.g. checking a value against
 * `@sms/custom-fields`'s compiled schema, itself a database read), and
 * because that is what lets dry run and commit be provably the same code
 * path rather than two hand-synchronised copies of it.
 *
 * `findExisting`/`create`/`update` are deliberately separate from
 * `parseRow`: `findExisting` is a read (dry run calls it too, to predict
 * create-vs-update counts, WITHOUT a `tx` - see `PipelineService.dryRun`),
 * while `create`/`update` are writes that MUST happen using the `tx` commit
 * passes them.
 *
 * That `tx` requirement is not cosmetic. `AuditContract.withBulkOperation`
 * stamps `bulk_operation_id` via `SET LOCAL` on ONE specific Postgres
 * transaction - the exact one it hands its callback (see that contract's own
 * doc comment: "every row fn writes using the transaction handle it is
 * given is stamped"). `@sms/db`'s `withTenantTx` always opens a brand-new
 * transaction (typically a different pooled connection), so a target that
 * calls back into a higher-level contract method that itself calls
 * `withTenantTx` (e.g. `PeopleContract.createPerson`) would write OUTSIDE
 * the bulk operation - silently unstamped, and therefore not part of what
 * `revert()` can undo. A target's `create`/`update` must therefore write
 * directly against `tx` (raw SQL against its own table is the same "escape
 * hatch" precedent `@sms/academic`'s `SectionScopeResolverService` already
 * uses for a platform/domain inversion), not delegate to a contract method
 * that opens its own transaction.
 */
export interface ImportTarget<TRow> {
  /** e.g. `'people.person'` - matches `import_export.import_job.entity_type`. */
  readonly entityType: string;

  /** For the mapping UI: which fields this target accepts, and whether each is required. */
  readonly fields: ImportFieldSpec[];

  /** Raw CSV row (header -> value) + the job's column mapping -> a validated, target-shaped row, or the errors that made it invalid. Never writes. */
  parseRow(raw: Record<string, string>, mapping: ColumnMapping): Promise<Result<TRow, RowError[]>>;

  /**
   * Idempotency / update-vs-insert: does a row matching `row` already exist?
   * Called by both `dryRun` (no `tx` - reads via the target's own ambient-
   * context transaction) and `commit` (with the bulk operation's `tx`, so a
   * row created earlier in the SAME commit is visible to a later duplicate
   * row in the same file).
   */
  findExisting(row: TRow, tx?: ImportTx): Promise<{ id: string } | null>;

  /** Writes MUST use `tx` - see this interface's own doc comment. */
  create(row: TRow, tx: ImportTx): Promise<{ id: string }>;

  /** Writes MUST use `tx` - see this interface's own doc comment. */
  update(id: string, row: TRow, tx: ImportTx): Promise<void>;

  /** Optional: enables `exportCsv` for this target. Yields plain records keyed by each field's `key`. */
  list?(filter: Record<string, unknown>): AsyncIterable<Record<string, unknown>>;
}
