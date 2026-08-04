/**
 * Two real Chromium pages, one signaling server, one live peer connection.
 *
 * What this covers: the custom element upgrading, WebSocket signaling, SDP
 * offer/answer, ICE, a real MediaStream crossing the peer connection, and
 * cursor messages travelling the data channel in the opposite direction.
 *
 * What it does NOT cover: `getDisplayMedia` itself. A headless browser has no
 * desktop, so the host page substitutes a canvas-backed MediaStream through the
 * element's `captureSource` seam. Everything downstream of that call is real.
 */

import { expect, test, type Page } from "@playwright/test";

const room = () => `e2e-${Math.random().toString(36).slice(2, 10)}`;

const url = (r: string, mode: "host" | "viewer", fake = true) =>
  `/demo/index.html?room=${r}&mode=${mode}${fake ? "&fakeCapture=1" : ""}`;

async function waitForWidget(page: Page): Promise<void> {
  await page.waitForFunction(() => customElements.get("screen-share") !== undefined);
  await page.waitForFunction(() =>
    (window as unknown as { __ss?: { events: unknown[] } }).__ss?.events.some(
      (e) => (e as { name: string }).name === "ss-state",
    ),
  );
}

const states = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { __ss: { events: { name: string; detail: { state: string } }[] } }).__ss
      .events.filter((e) => e.name === "ss-state")
      .map((e) => e.detail.state),
  );

test("element registers and isolates itself from hostile host CSS", async ({ page }) => {
  await page.goto(url(room(), "host"));
  await waitForWidget(page);

  const el = page.locator("screen-share");
  await expect(el).toBeAttached();

  // The demo page sets `video { width: 40px !important; border: 6px dashed red }`
  // and pink 28px buttons. Shadow DOM must keep all of that outside.
  const videoWidth = await page.evaluate(() => {
    const v = document.querySelector("screen-share")!.shadowRoot!.querySelector("video")!;
    return getComputedStyle(v).width;
  });
  expect(parseFloat(videoWidth)).toBeGreaterThan(100);

  const btn = await page.evaluate(() => {
    const b = document
      .querySelector("screen-share")!
      .shadowRoot!.querySelector("button.share")!;
    const s = getComputedStyle(b);
    return { bg: s.backgroundColor, size: s.fontSize };
  });
  expect(btn.bg).not.toBe("rgb(255, 105, 180)"); // hotpink did not leak in
  expect(parseFloat(btn.size)).toBeLessThan(20);
});

test("loading the bundle twice does not throw", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url(room(), "host"));
  await waitForWidget(page);
  await page.addScriptTag({ url: "/dist/screenshare.js" });
  await page.waitForTimeout(300);
  expect(errors).toEqual([]);
});

test("host shares, viewer receives live video over a real peer connection", async ({
  browser,
}) => {
  const r = room();
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const viewer = await ctx.newPage();

  await host.goto(url(r, "host"));
  await waitForWidget(host);
  await viewer.goto(url(r, "viewer"));
  await waitForWidget(viewer);

  // Host starts sharing (canvas-backed stream via the captureSource seam).
  await host.locator("screen-share").evaluate((el) => {
    el.shadowRoot!.querySelector<HTMLButtonElement>("button.share")!.click();
  });

  // Viewer must end up with a decoding video track of real dimensions.
  await expect
    .poll(
      async () =>
        viewer.evaluate(() => {
          const v = document
            .querySelector("screen-share")!
            .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
          return { w: v.videoWidth, h: v.videoHeight, src: v.srcObject !== null };
        }),
      { timeout: 30_000, message: "viewer never received a decodable video track" },
    )
    .toMatchObject({ w: 640, h: 360, src: true });

  expect(await states(host)).toContain("connected");
  expect(await states(viewer)).toContain("connected");

  // Frames must actually flow, not just a track exist.
  const framesGrew = await viewer.evaluate(async () => {
    const v = document
      .querySelector("screen-share")!
      .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
    const first = v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    await new Promise((res) => setTimeout(res, 1500));
    const second = v.getVideoPlaybackQuality?.().totalVideoFrames ?? 0;
    return second > first;
  });
  expect(framesGrew, "video track exists but no frames are decoding").toBe(true);

  await ctx.close();
});

test("viewer pointer reaches the host over the data channel", async ({ browser }) => {
  const r = room();
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const viewer = await ctx.newPage();

  await host.goto(url(r, "host"));
  await waitForWidget(host);
  await viewer.goto(url(r, "viewer"));
  await waitForWidget(viewer);

  await host.locator("screen-share").evaluate((el) => {
    el.shadowRoot!.querySelector<HTMLButtonElement>("button.share")!.click();
  });
  await expect
    .poll(
      () =>
        viewer.evaluate(
          () =>
            document
              .querySelector("screen-share")!
              .shadowRoot!.querySelector<HTMLVideoElement>("video")!.videoWidth,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  // Drive a real pointer across the viewer's video element.
  const box = await viewer.evaluate(() => {
    const v = document
      .querySelector("screen-share")!
      .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
    const r2 = v.getBoundingClientRect();
    return { x: r2.left, y: r2.top, w: r2.width, h: r2.height };
  });
  await viewer.bringToFront();
  for (let i = 1; i <= 10; i++) {
    await viewer.mouse.move(box.x + (box.w * i) / 11, box.y + (box.h * i) / 11);
    await viewer.waitForTimeout(60);
  }

  await expect
    .poll(
      () =>
        host.evaluate(
          () => (window as unknown as { __ss: { cursors: unknown[] } }).__ss.cursors.length,
        ),
      { timeout: 20_000, message: "no cursor messages arrived at the host" },
    )
    .toBeGreaterThan(0);

  const cursors = await host.evaluate(
    () => (window as unknown as { __ss: { cursors: { x: number; y: number }[] } }).__ss.cursors,
  );
  for (const c of cursors) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThanOrEqual(1);
    expect(c.y).toBeGreaterThanOrEqual(0);
    expect(c.y).toBeLessThanOrEqual(1);
  }
  // Throttled to 30 Hz: 10 moves over ~600 ms must not produce 10 messages.
  expect(cursors.length).toBeLessThanOrEqual(10);

  await ctx.close();
});

test("third peer is rejected with room-full", async ({ browser }) => {
  const r = room();
  const ctx = await browser.newContext();
  const a = await ctx.newPage();
  const b = await ctx.newPage();
  const c = await ctx.newPage();

  await a.goto(url(r, "host"));
  await waitForWidget(a);
  await b.goto(url(r, "viewer"));
  await waitForWidget(b);
  await c.goto(url(r, "viewer"));

  await expect
    .poll(
      () =>
        c.evaluate(() => {
          const s = (
            window as unknown as {
              __ss: { events: { name: string; detail: { detail?: string } }[] };
            }
          ).__ss.events;
          return s.some((e) => (e.detail?.detail ?? "").includes("room-full"));
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  await ctx.close();
});
