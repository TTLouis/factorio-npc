import antfu from '@antfu/eslint-config'

export default antfu(
  {
    // Keep CI focused on correctness and maintainability. This repository has a
    // long pre-existing formatting baseline, so formatting belongs in explicit
    // formatter/fix passes rather than blocking correctness gates.
    stylistic: false,
    yaml: false,
    markdown: false,
    rules: {
      // Factorio prototype names, Lua-facing payloads, and existing TypeScript
      // APIs legitimately mix snake_case, camelCase, CONSTANT_CASE, and
      // hyphenated external keys. A blanket naming rule creates false positives
      // without protecting runtime contracts.
      'ts/naming-convention': 'off',
    },
  },
  {
    files: [
      'packages/autorio/**/*.ts',
      'packages/tstl-plugin-reload-factorio-mod/example/*.ts',
    ],
    rules: {
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
