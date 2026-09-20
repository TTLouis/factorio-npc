import antfu from '@antfu/eslint-config'

export default antfu(
  {
    // CI lint is a correctness/maintainability gate. Repository-wide formatting
    // remains an explicit fix/formatter concern so historical layout does not
    // hide substantive errors behind thousands of cosmetic diagnostics.
    stylistic: false,
    yaml: false,
    markdown: false,
    rules: {
      // The codebase legitimately mixes Lua-facing snake_case, TypeScript
      // camelCase/CONSTANT_CASE, and external Factorio keys with hyphens.
      'ts/naming-convention': 'off',

      // These are preference/ordering rules, not correctness invariants.
      'perfectionist/sort-imports': 'off',
      'perfectionist/sort-named-imports': 'off',
      'import/consistent-type-specifier-style': 'off',
      'ts/consistent-type-definitions': 'off',
      'test/prefer-lowercase-title': 'off',
      'regexp/prefer-w': 'off',
      'regexp/prefer-d': 'off',
      'regexp/use-ignore-case': 'off',
      'unicorn/escape-case': 'off',
      'unicorn/prefer-includes': 'off',
    },
  },
  {
    files: [
      'deploy/**/*.mjs',
      'tools/**/*.mjs',
    ],
    rules: {
      // These files are direct Node.js runtimes/CLIs, not browser-bundled code.
      'node/prefer-global/process': 'off',
      'node/prefer-global/buffer': 'off',
      'no-console': 'off',
    },
  },
  {
    files: [
      'deploy/**/*.test.mjs',
      'tools/**/*.test.mjs',
    ],
    rules: {
      // Production deployment tests are intentionally executed with
      // `node --test`, not Vitest.
      'test/no-import-node-test': 'off',
    },
  },
  {
    files: [
      'deploy/**/*.mjs',
      'packages/agent/src/llm/operations.ts',
    ],
    rules: {
      // These regexes intentionally reject ASCII control characters at input
      // boundaries; the control ranges are the behavior being validated.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: {
      // Vitest mock factories must be declared before loading the module under
      // test, and several regression tests intentionally assert literal source
      // strings containing ${...}. Setter-only helpers are test fixtures.
      'import/first': 'off',
      'no-template-curly-in-string': 'off',
      'accessor-pairs': 'off',
    },
  },
  {
    files: [
      'packages/autorio/**/*.ts',
      'packages/tstl-plugin-reload-factorio-mod/example/*.ts',
    ],
    rules: {
      // TSTL/Lua-safe finite-number guards use `value === value` as a NaN
      // check without depending on JavaScript-only Number helpers.
      'no-self-compare': 'off',
      'unused-imports/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^unused_',
          destructuredArrayIgnorePattern: '^unused_',
        },
      ],
    },
  },
  {
    ignores: ['models/*', '**/.pixi'],
  },
)
