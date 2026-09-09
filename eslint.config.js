// Deliberately minimal. tsc (`noUnusedLocals`/`noUnusedParameters` in
// tsconfig.json) already carries the unused-bindings checks, so this file
// stays scoped to typescript-eslint's `recommended` set and nothing more.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/'],
  },
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'examples/**/*.ts', 'vitest.config.ts'],
    extends: [...tseslint.configs.recommended],
    rules: {
      // tsc owns unused-binding checks now (noUnusedLocals/noUnusedParameters
      // in tsconfig.json); off rather than reconfigured, since the default
      // rule has no underscore-ignore pattern of its own and two tools
      // disagreeing on that convention (src/adapters/node.ts:293) is a known
      // nuisance.
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
);
