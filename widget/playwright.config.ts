import { defineConfig } from "@playwright/test";

const SIGNALING = "http://127.0.0.1:8000";
const STATIC = "http://127.0.0.1:5173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false, // rooms are shared state; keep the specs serial
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: STATIC,
    // WebRTC needs a real browser; headless Chromium does WebRTC fine.
    launchOptions: {
      // Escape hatch for environments that pre-install Chromium at a fixed path
      // (CI images, sandboxes) instead of letting Playwright download a build
      // matching its own version. Unset locally -> normal Playwright behaviour.
      ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
        ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
        : {}),
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        // Two pages means one is always backgrounded. Without these, Chromium
        // throttles its timers and media pipeline and the test measures the
        // throttling, not the widget.
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
      ],
    },
  },
  webServer: [
    {
      command:
        "../server/.venv/bin/uvicorn signaling.main:app --host 127.0.0.1 --port 8000 " +
        "--app-dir ../server/src --log-level warning",
      url: `${SIGNALING}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "node serve.mjs",
      url: `${STATIC}/demo/index.html`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
