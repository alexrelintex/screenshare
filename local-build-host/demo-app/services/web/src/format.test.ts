import { describe, expect, it } from "vitest";
import { formatTotal } from "./format.js";

describe("formatTotal", () => {
  it("formats", () => {
    expect(formatTotal(6.5, 3)).toBe("3 value(s) sum to 6.5");
  });
  it("rejects NaN", () => {
    expect(() => formatTotal(NaN, 1)).toThrow(TypeError);
  });
});
