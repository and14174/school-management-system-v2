/**
 * `@casl/ability@7.0.1` ships its type declarations only via the `exports`
 * map (`exports["."].types`), with no top-level `types`/`typings` field in
 * its `package.json`. `apps/api/tsconfig.json` deliberately pins
 * `moduleResolution: "node"` (classic/"node10") - see that file's own
 * comment for why (decorator + CJS-emit reasons unrelated to this package) -
 * and classic resolution never reads the `exports` map at all, so it cannot
 * find `@casl/ability`'s types via the bare `@casl/ability` specifier,
 * even though `@sms/access` (which uses `moduleResolution: "Bundler"`,
 * inherited from `tsconfig.base.json`) resolves them without issue.
 *
 * This re-exports from the exact physical path classic resolution CAN find
 * (an explicit subpath is walked directly on disk, bypassing `exports`
 * entirely - only the bare package-root specifier needs `exports` support).
 * Only `apps/api`'s compilation needs this; `@sms/access`'s own `tsc` run is
 * unaffected and does not load this file (it is not under its `include`).
 */
declare module '@casl/ability' {
  export * from '@casl/ability/dist/types/index';
}
