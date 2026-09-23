import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // `const { chapters: _chapters, ...meta } = book` 是「去掉某个字段」的惯用写法，不算没用上。
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".wrangler/**",
    "dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "types/generated-worker.d.ts",
  ]),
]);

export default eslintConfig;
