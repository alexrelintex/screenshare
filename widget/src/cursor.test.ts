import { describe, expect, it, vi } from "vitest";

import { denormalize, isCursorMessage, normalize, throttle } from "./cursor.js";

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
