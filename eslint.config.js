import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import query from "@tanstack/eslint-plugin-query";

/**
 * Lint rules aimed at mistakes this codebase has actually made. Nothing here is
 * about style: no formatting rules, no naming rules, no import ordering. If a rule
 * cannot point at a bug, it does not belong.
 *
 * The ones that earn their place are the React Compiler rules in
 * eslint-plugin-react-hooks. A render that reads the clock is impure, and an
 * impure render is what put the drives and charges lists into an endless refetch
 * loop — `Date.now()` during render produced a fresh react-query key every frame.
 * That is `react-hooks/purity`.
 *
 * Worth knowing about its reach: the rule is intra-procedural. It sees
 * `Date.now()` written in a component body, but not the same call two frames down
 * inside a helper in another module, which is where the loop actually lived. Lint
 * narrows this class of bug; the guard is the stability spec in
 * `app/lib/filters.test.ts`.
 */
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      ".wrangler/**",
      ".cloudflare/**",
      ".claude/**",
      "e2e/.artifacts/**",
      "e2e/.state*/**",
      // Generated: half a megabyte of Cloudflare bindings.
      "worker-configuration.d.ts",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommended,

  {
    rules: {
      // TypeScript already resolves every identifier, and it knows the per-project
      // lib and globals better than a flat list here can.
      "no-undef": "off",
      // Unused arguments are often deliberate in handlers and adapters; unused
      // variables and imports are dead code. A leading underscore opts out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { args: "none", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `any` is load-bearing where a Cloudflare or library type is wider than
      // ours. Worth a look, not worth failing on.
      "@typescript-eslint/no-explicit-any": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  // The SPA. React Compiler rules, plus the react-query lint that checks a query
  // key covers everything its query function reads.
  {
    files: ["app/**/*.{ts,tsx}"],
    // `configs.flat` holds the flat-config entries; `configs["recommended-latest"]`
    // at the top level is still the legacy eslintrc shape.
    extends: [reactHooks.configs.flat["recommended-latest"], query.configs["flat/recommended"]],
    languageOptions: { globals: globals.browser },
  },

  // The service worker. Not part of the SPA's module graph — it is emitted
  // separately by the build — and it runs against `ServiceWorkerGlobalScope`,
  // not `window`.
  {
    files: ["app/sw.js"],
    languageOptions: { globals: globals.serviceworker },
  },

  // The Worker, the shared DTOs, and the Node-side tooling.
  {
    files: ["src/**/*.ts", "shared/**/*.ts"],
    languageOptions: { globals: { ...globals.worker, ...globals.node } },
  },
  {
    files: ["scripts/**/*.{ts,mjs}", "e2e/**/*.{ts,mjs}", "*.config.{ts,js,mjs}", "vitest.config.ts", "vite.config.ts"],
    languageOptions: { globals: globals.node },
  },
);
