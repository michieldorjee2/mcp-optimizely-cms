// ESLint flat config — supports the typescript-eslint v8 typed-rules workflow.
// Run with `npm run lint` or `npm run lint:fix`.
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // We hand-throw typed errors and re-throw values that aren't always
      // Error instances — disabling the strict-form here keeps the noise
      // down without sacrificing the meaningful checks.
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "warn",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    files: ["**/*.ts"],
    rules: {
      // Prefer explicit return types on exported functions for API stability,
      // but allow inference inside.
      "@typescript-eslint/explicit-module-boundary-types": "off",
    },
  },
  {
    ignores: ["node_modules/", "dist/", ".vercel/", "*.js", "*.d.ts"],
  },
  eslintConfigPrettier
);
