// @ts-check
// Adder pipeline scaffold — slim, TYPE-AWARE ESLint layer (pipeline gate 6b).
//
// Biome (gate 5) already handles formatting + syntactic/AST lint + import
// organization. This config exists ONLY for the rules Biome cannot do yet:
// the typescript-eslint TYPE-CHECKED rules that need the TS type-checker
// (no-floating-promises, no-misused-promises, await-thenable, no-unsafe-*,
// restrict-template-expressions, etc.). It uses the `*Only` preset so it does
// NOT re-enable the stylistic/syntactic rules Biome owns — no double-reporting.
//
// Adopt-and-ratchet: the scaffold starts at `recommendedTypeCheckedOnly`. Once
// a repo is clean, upgrade to `strictTypeCheckedOnly` for maximum coverage.
//
// Requires devDeps: eslint, typescript-eslint (and a tsconfig.json — the type
// checker reads it via projectService). The gate runs `eslint` over src/.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'build/**',
      'coverage/**',
      'node_modules/**',
      '.adder-pipeline/**',
      'scripts/**',
      // Tests are excluded from tsconfig.json (`exclude: ["src/__tests__"]`),
      // so the type-checked rules' projectService can't resolve them. Matches
      // the prior eslint.config.js which also ignored src/__tests__.
      'src/__tests__/**',
      '*.config.*',
      'stryker.conf.*',
      'biome.json',
      'eslint.config.*',
    ],
  },
  // Type-checked rules ONLY (the type-aware half of typescript-eslint).
  // Swap to `strictTypeCheckedOnly` to ratchet up once the repo is clean.
  ...tseslint.configs.recommendedTypeCheckedOnly,
  {
    languageOptions: {
      parserOptions: {
        // projectService auto-discovers the nearest tsconfig.json — no need to
        // hardcode a path. Requires typescript-eslint v8+.
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
