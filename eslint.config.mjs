import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "main.js",
      "node_modules/**",
      "coverage/**",
      "release/**",
      "dist/**",
    ],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // QnALog has Chinese copy and product/API names whose casing is intentional.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
  {
    files: [
      "src/notes/note-transcript-ledger.ts", "src/audio/recording-service.ts",
      "src/notes/role-mapping.ts", "src/notes/repolish-flow.ts", "src/notes/clean-script-flow.ts",
    ],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.strict-core.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
