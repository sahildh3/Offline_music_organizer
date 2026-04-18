import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        ...globals.browser,
        lucide: "readonly",
        ZIP_UTILS: "readonly",
        state: "readonly",
        elements: "readonly"
      },
    },
    rules: {
      "no-unused-vars": "warn",
      "no-undef": "error",
      "no-constant-condition": "off"
    },
  },
];
