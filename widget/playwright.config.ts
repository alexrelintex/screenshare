import { defineConfig } from "@playwright/test";

// Ports come from the environment, same convention as .env / the Makefile.
// Hardcoding them meant any other process holding 8000 — another project's API
// is enough — made the whole suite unrunnable locally with no way round it.
const SIGNALING_PORT = process.env.SIGNALING_PORT ?? "8000";
const STATIC_PORT = process.env.STATIC_PORT ?? "5173";
const SIGNALING = `http://127.0.0.1:${SIGNALING_PORT}`;
const STATIC = `http://127.0.0.1:${STATIC_PORT}`;

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
        `../server/.venv/bin/uvicorn signaling.main:app --host 127.0.0.1 --port ${SIGNALING_PORT} ` +
        "--app-dir ../server/src --log-level warning",
      url: `${SIGNALING}/healthz`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: "node serve.mjs",
      // serve.mjs reads PORT; without this it binds the default while
      // Playwright waits on STATIC_PORT and the suite times out on startup.
      env: { PORT: STATIC_PORT },
      url: `${STATIC}/demo/index.html`,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
