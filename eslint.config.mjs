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
      // LexVoice has Chinese copy and product/API names whose casing is intentional.
      "obsidianmd/ui/sentence-case": "off",
    },
  },
]);
