import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import nx from '@nx/eslint-plugin';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.nx/**',
      '**/*.config.mjs',
      '**/*.config.js',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { '@nx': nx },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],

      // ---------------------------------------------------------------
      // Module boundaries. This is what keeps the monolith modular.
      //
      //   app       -> anything
      //   domain    -> platform, shared, other domain (package root only)
      //   platform  -> platform, shared           (NEVER domain)
      //   shared    -> shared only
      //
      // Because every lib is its own pnpm package, imports can only reach
      // a package's entrypoint - deep imports past a module's contract are
      // impossible by construction.
      // ---------------------------------------------------------------
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: [],
          depConstraints: [
            {
              sourceTag: 'type:app',
              onlyDependOnLibsWithTags: ['type:platform', 'type:domain', 'type:shared'],
            },
            {
              sourceTag: 'type:domain',
              onlyDependOnLibsWithTags: ['type:platform', 'type:domain', 'type:shared'],
            },
            {
              sourceTag: 'type:platform',
              onlyDependOnLibsWithTags: ['type:platform', 'type:shared'],
            },
            {
              sourceTag: 'type:shared',
              onlyDependOnLibsWithTags: ['type:shared'],
            },
          ],
        },
      ],
    },
  },

  // Raw database access is only legal inside the shared db library. Everywhere
  // else must go through withTenantTx(), or RLS context can be bypassed.
  {
    files: ['libs/platform/**/*.ts', 'libs/domain/**/*.ts', 'apps/**/*.ts'],
    ignores: ['libs/shared/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'postgres',
              message:
                'Do not create a database client directly. Import withTenantTx from @sms/db so the RLS session context is always set.',
            },
          ],
        },
      ],
    },
  },
);
