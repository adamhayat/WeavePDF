import { defineConfig } from "vitest/config";

// Unit tests only — pure logic that must NOT require launching the packaged
// app (the Playwright E2E suite in tests/e2e/ stays separate, run via `npm
// test`). Node environment: these tests exercise pdf-lib / pdf.js geometry and
// pure array helpers, no DOM. Run with `npm run test:unit`.
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    environment: "node",
  },
});
