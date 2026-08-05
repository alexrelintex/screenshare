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

const url = (r: string, mode: "host" | "viewer", fake = true, captureSize?: string) =>
  `/demo/index.html?room=${r}&mode=${mode}${fake ? "&fakeCapture=1" : ""}` +
  (captureSize ? `&captureSize=${captureSize}` : "");

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

test("a non-16:9 stream drives the stage and the cursor maps to the picture", async ({
  browser,
}) => {
  const r = room();
  const ctx = await browser.newContext();
  const host = await ctx.newPage();
  const viewer = await ctx.newPage();

  // 4:3 into a stage that starts at 16:9. Before the stage adopted the stream's
  // ratio this left pillarbox bars, and cursor coordinates were measured
  // against the element box including those bars.
  await host.goto(url(r, "host", true, "640x480"));
  await waitForWidget(host);
  await viewer.goto(url(r, "viewer", true, "640x480"));
  await waitForWidget(viewer);

  await host.locator("screen-share").evaluate((el) => {
    el.shadowRoot!.querySelector<HTMLButtonElement>("button.share")!.click();
  });

  await expect
    .poll(
      async () =>
        viewer.evaluate(() => {
          const v = document
            .querySelector("screen-share")!
            .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
          return { w: v.videoWidth, h: v.videoHeight };
        }),
      { timeout: 30_000, message: "viewer never received the 4:3 track" },
    )
    .toMatchObject({ w: 640, h: 480 });

  // The stage must have taken the stream's shape, leaving no bars for the
  // pointer to land in.
  const geom = await viewer.evaluate(() => {
    const root = document.querySelector("screen-share")!.shadowRoot!;
    const v = root.querySelector<HTMLVideoElement>("video")!;
    const box = v.getBoundingClientRect();
    return { boxW: box.width, boxH: box.height, w: v.videoWidth, h: v.videoHeight };
  });
  expect(geom.boxW / geom.boxH).toBeCloseTo(geom.w / geom.h, 1);

  // Point at the exact centre of the painted video; the host must receive
  // ~0.5,0.5 regardless of the aspect mismatch.
  const box = await viewer.evaluate(() => {
    const v = document
      .querySelector("screen-share")!
      .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
    const b = v.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await viewer.bringToFront();
  for (let i = 0; i < 4; i++) {
    await viewer.mouse.move(box.x + box.w / 2, box.y + box.h / 2);
    await viewer.waitForTimeout(80);
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

  const last = await host.evaluate(() => {
    const c = (window as unknown as { __ss: { cursors: { x: number; y: number }[] } }).__ss
      .cursors;
    return c[c.length - 1] ?? null;
  });
  expect(last, "host recorded no cursor to check").not.toBeNull();
  expect(last!.x).toBeCloseTo(0.5, 1);
  expect(last!.y).toBeCloseTo(0.5, 1);

  await ctx.close();
});

test("a touch tap moves the remote pointer, which then fades on its own", async ({ browser }) => {
  const r = room();
  // A phone-shaped viewport with a real touchscreen: pointermove never fires
  // without a finger down, so a tap is the only way a cursor gets sent.
  const ctx = await browser.newContext({ hasTouch: true, viewport: { width: 390, height: 844 } });
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

  const box = await viewer.evaluate(() => {
    const v = document
      .querySelector("screen-share")!
      .shadowRoot!.querySelector<HTMLVideoElement>("video")!;
    const b = v.getBoundingClientRect();
    return { x: b.left, y: b.top, w: b.width, h: b.height };
  });
  await viewer.bringToFront();
  await viewer.touchscreen.tap(box.x + box.w / 2, box.y + box.h / 2);

  await expect
    .poll(
      () =>
        host.evaluate(
          () => (window as unknown as { __ss: { cursors: unknown[] } }).__ss.cursors.length,
        ),
      { timeout: 20_000, message: "a tap sent no cursor message" },
    )
    .toBeGreaterThan(0);

  // The dot is up now...
  await expect
    .poll(
      () =>
        host.evaluate(() =>
          document
            .querySelector("screen-share")!
            .shadowRoot!.querySelector(".pointer")!
            .classList.contains("on"),
        ),
      { timeout: 5_000, message: "the remote pointer never appeared" },
    )
    .toBe(true);

  // ...and must retire itself. A finger sends no pointerleave, so without the
  // idle timeout it would hang at the tap position for the whole session.
  await expect
    .poll(
      () =>
        host.evaluate(() =>
          document
            .querySelector("screen-share")!
            .shadowRoot!.querySelector(".pointer")!
            .classList.contains("on"),
        ),
      { timeout: 10_000, message: "the remote pointer never faded after the touch ended" },
    )
    .toBe(false);

  await ctx.close();
});

test("a device without screen capture explains itself instead of offering a dead button", async ({
  browser,
}) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  // Stand in for a phone: same absent API, without needing a phone. Note this
  // exercises the gate, not getDisplayMedia itself — nothing headless can.
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", {
      value: undefined,
      configurable: true,
    });
  });
  // fake=false so the captureSource seam is left unset and the gate applies.
  await page.goto(url(room(), "host", false));
  await waitForWidget(page);

  const ui = await page.evaluate(() => {
    const root = document.querySelector("screen-share")!.shadowRoot!;
    return {
      disabled: root.querySelector<HTMLButtonElement>("button.share")!.disabled,
      message: root.querySelector(".empty")!.textContent ?? "",
    };
  });
  expect(ui.disabled, "share button should be disabled where capture is impossible").toBe(true);
  expect(ui.message).toContain("cannot share a screen");

  const errors = await page.evaluate(
    () =>
      (
        window as unknown as {
          __ss: { events: { name: string; detail: { error?: string } }[] };
        }
      ).__ss.events.filter((e) => e.name === "ss-error").map((e) => e.detail?.error),
  );
  expect(errors).toContain("capture-unsupported");

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
