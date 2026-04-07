import js from "@eslint/js";
import globals from "globals";
import importPlugin from "eslint-plugin-import";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";

const sourceFiles = ["src/**/*.{ts,tsx}"];
const testFiles = ["test/**/*.{ts,tsx}"];

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: [...sourceFiles, ...testFiles],
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        sourceType: "module",
      },
    },
    plugins: {
      import: importPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
    },
    settings: {
      react: {
        version: "detect",
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "warn",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "eqeqeq": ["error", "always"],
      "import/order": [
        "warn",
        {
          alphabetize: {
            order: "asc",
            caseInsensitive: true,
          },
          "newlines-between": "always",
          groups: [["builtin", "external"], "internal", ["parent", "sibling", "index"]],
        },
      ],
      "no-console": "warn",
      "no-duplicate-imports": "error",
      "react/react-in-jsx-scope": "off",
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    files: testFiles,
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["src/cli/**/*.{ts,tsx}"],
    rules: {
      "no-console": "off",
    },
  },
  {
    files: ["bin/**/*.js"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-console": "off",
    },
  },
);
