import { describe, expect, it, vi } from "vitest";

import { contentRect, denormalize, isCursorMessage, normalize, throttle } from "./cursor.js";

const RECT = { left: 100, top: 50, width: 400, height: 200 };

describe("normalize", () => {
  it("maps the rect corners to 0..1", () => {
    expect(normalize(100, 50, RECT)).toEqual({ x: 0, y: 0 });
    expect(normalize(500, 250, RECT)).toEqual({ x: 1, y: 1 });
    expect(normalize(300, 150, RECT)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("clamps points outside the rect instead of escaping 0..1", () => {
    expect(normalize(-999, -999, RECT)).toEqual({ x: 0, y: 0 });
    expect(normalize(9999, 9999, RECT)).toEqual({ x: 1, y: 1 });
  });

  it("returns the origin for a zero-sized rect rather than NaN", () => {
    const p = normalize(10, 10, { left: 0, top: 0, width: 0, height: 0 });
    expect(p).toEqual({ x: 0, y: 0 });
    expect(Number.isNaN(p.x)).toBe(false);
  });
});

describe("contentRect", () => {
  // A 16:9 box. The bars, and therefore the whole bug, appear only when the
  // stream's ratio differs from it.
  const BOX = { left: 0, top: 0, width: 640, height: 360 };

  it("is the element box when the ratios already agree", () => {
    expect(contentRect(BOX, 1920, 1080)).toEqual(BOX);
  });

  it("pillarboxes a 4:3 stream — bars left and right", () => {
    // 480-wide content centred in 640: 80px of bar on each side.
    expect(contentRect(BOX, 640, 480)).toEqual({
      left: 80,
      top: 0,
      width: 480,
      height: 360,
    });
  });

  it("letterboxes an ultrawide stream — bars top and bottom", () => {
    // 21:9 into 16:9: full width, 640/(21/9) ≈ 274.3 tall, centred vertically.
    const r = contentRect(BOX, 2560, 1080);
    expect(r.left).toBe(0);
    expect(r.width).toBe(640);
    expect(r.height).toBeCloseTo(270, 5);
    expect(r.top).toBeCloseTo(45, 5);
  });

  it("keeps the box offset rather than assuming an origin at 0,0", () => {
    const offset = { left: 100, top: 50, width: 640, height: 360 };
    expect(contentRect(offset, 640, 480)).toEqual({
      left: 180,
      top: 50,
      width: 480,
      height: 360,
    });
  });

  it("falls back to the element box before any frame has decoded", () => {
    // videoWidth/videoHeight are 0 until metadata arrives.
    expect(contentRect(BOX, 0, 0)).toEqual(BOX);
    expect(contentRect(BOX, 640, 0)).toEqual(BOX);
    expect(contentRect(BOX, NaN, NaN)).toEqual(BOX);
  });

  it("falls back for a zero-sized element box instead of dividing by zero", () => {
    const empty = { left: 0, top: 0, width: 0, height: 0 };
    expect(contentRect(empty, 640, 480)).toEqual(empty);
  });

  it("round-trips a point through normalize and denormalize", () => {
    // The centre of a pillarboxed 4:3 stream must survive the round trip, and
    // must NOT be the centre of the element box's left edge.
    const content = contentRect(BOX, 640, 480);
    const p = normalize(320, 180, content);
    expect(p).toEqual({ x: 0.5, y: 0.5 });
    expect(denormalize(p, content)).toEqual({ x: 320, y: 180 });
  });

  it("maps the content edge to 0, where the element edge would over-report", () => {
    const content = contentRect(BOX, 640, 480);
    // x=80 is the left edge of the painted video.
    expect(normalize(80, 0, content).x).toBe(0);
    // Against the raw element box the same point reads as 0.125 — the bug.
    expect(normalize(80, 0, BOX).x).toBeCloseTo(0.125, 5);
  });
});

describe("denormalize", () => {
  it("is the inverse of normalize", () => {
    for (const [cx, cy] of [
      [100, 50],
      [300, 150],
      [500, 250],
      [237, 91],
    ]) {
      const round = denormalize(normalize(cx!, cy!, RECT), RECT);
      expect(round.x).toBeCloseTo(cx!, 6);
      expect(round.y).toBeCloseTo(cy!, 6);
    }
  });

  it("scales correctly into a differently sized rect", () => {
    // The whole reason coordinates are normalised: sender and receiver differ.
    const viewer = { left: 0, top: 0, width: 1920, height: 1080 };
    const p = normalize(300, 150, RECT); // centre
    expect(denormalize(p, viewer)).toEqual({ x: 960, y: 540 });
  });
});

describe("isCursorMessage", () => {
  it("accepts a well-formed message", () => {
    expect(isCursorMessage({ type: "cursor", x: 0.5, y: 0.5 })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "cursor"],
    ["wrong type field", { type: "click", x: 0, y: 0 }],
    ["missing y", { type: "cursor", x: 0 }],
    ["string coords", { type: "cursor", x: "0.5", y: "0.5" }],
    ["NaN", { type: "cursor", x: NaN, y: 0 }],
    ["Infinity", { type: "cursor", x: Infinity, y: 0 }],
  ])("rejects %s", (_label, value) => {
    expect(isCursorMessage(value)).toBe(false);
  });
});

describe("throttle", () => {
  it("passes the first call through immediately", () => {
    const fn = vi.fn();
    const t = throttle(fn, 100, () => 1000);
    t(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("suppresses calls inside the window", () => {
    vi.useFakeTimers();
    let now = 1000;
    const fn = vi.fn();
    const t = throttle(fn, 100, () => now);
    t("a");
    t("b");
    t("c");
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("delivers the trailing call so the cursor never freezes short", () => {
    vi.useFakeTimers();
    let now = 1000;
    const fn = vi.fn();
    const t = throttle(fn, 100, () => now);
    t("first");
    t("middle");
    t("last");
    now += 100;
    vi.advanceTimersByTime(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("last");
    vi.useRealTimers();
  });

  it("flush() delivers a pending call synchronously", () => {
    vi.useFakeTimers();
    const now = 1000;
    const fn = vi.fn();
    const t = throttle(fn, 100, () => now);
    t("a");
    t("b");
    t.flush();
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
    vi.useRealTimers();
  });

  it("cancel() drops the pending call", () => {
    vi.useFakeTimers();
    const now = 1000;
    const fn = vi.fn();
    const t = throttle(fn, 100, () => now);
    t("a");
    t("b");
    t.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("allows a new call once the window has elapsed", () => {
    let now = 1000;
    const fn = vi.fn();
    const t = throttle(fn, 100, () => now);
    t("a");
    now += 150;
    t("b");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
