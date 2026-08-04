import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's default glob also matches *.spec.ts, which would sweep up the
    // Playwright suite in e2e/ and fail on its @playwright/test imports.
    // Unit tests are src/**/*.test.ts; browser tests belong to Playwright.
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
