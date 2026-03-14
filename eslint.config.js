import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import security from "eslint-plugin-security";

export default [
  security.configs.recommended,
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
      security,
    },
    rules: {
      // TypeScript strict rules
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],

      // Security
      "no-console": "error",
      "no-eval": "error",
      "security/detect-object-injection": "off", // Too noisy with Maps
      "security/detect-non-literal-fs-filename": "off", // We sanitize paths

      // General
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "prefer-template": "error",
    },
  },
  {
    ignores: ["dist/", "node_modules/", "scripts/", "eslint.config.js"],
  },
];
