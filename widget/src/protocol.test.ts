import { describe, expect, it } from "vitest";

import { parseServerMessage, signalingUrl } from "./protocol.js";

describe("parseServerMessage", () => {
  it("parses a welcome frame", () => {
    const m = parseServerMessage(JSON.stringify({ type: "welcome", peerId: "a", peers: [] }));
    expect(m).toMatchObject({ type: "welcome", peerId: "a", peers: [] });
  });

  it("parses offer / answer / ice", () => {
    expect(parseServerMessage('{"type":"offer","sdp":"v=0"}')).toMatchObject({ type: "offer" });
    expect(parseServerMessage('{"type":"answer","sdp":"v=0"}')).toMatchObject({ type: "answer" });
    expect(parseServerMessage('{"type":"ice","candidate":null}')).toMatchObject({ type: "ice" });
  });

  it.each([
    ["malformed json", "{not json"],
    ["a bare array", "[1,2,3]"],
    ["null", "null"],
    ["a string literal", '"hello"'],
    ["no type field", '{"peerId":"a"}'],
    ["welcome without peers", '{"type":"welcome","peerId":"a"}'],
    ["welcome with non-string peerId", '{"type":"welcome","peerId":1,"peers":[]}'],
    ["offer without sdp", '{"type":"offer"}'],
    ["peer-joined without peerId", '{"type":"peer-joined"}'],
    ["error without code", '{"type":"error"}'],
  ])("returns null for %s", (_label, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });

  it("returns null for an unknown type rather than throwing", () => {
    // Forward compatibility: a newer server must not break an older widget.
    expect(() => parseServerMessage('{"type":"chat","body":"hi"}')).not.toThrow();
    expect(parseServerMessage('{"type":"chat","body":"hi"}')).toBeNull();
  });

  it("keeps the ice candidate payload intact", () => {
    const cand = { candidate: "candidate:1 1 UDP", sdpMid: "0", sdpMLineIndex: 0 };
    const m = parseServerMessage(JSON.stringify({ type: "ice", candidate: cand }));
    expect(m).toMatchObject({ type: "ice", candidate: cand });
  });
});

describe("signalingUrl", () => {
  it("upgrades http to ws and https to wss", () => {
    expect(signalingUrl("http://localhost:8000", "r")).toBe("ws://localhost:8000/ws/r");
    expect(signalingUrl("https://example.com", "r")).toBe("wss://example.com/ws/r");
  });

  it("passes ws/wss through untouched", () => {
    expect(signalingUrl("wss://example.com", "r")).toBe("wss://example.com/ws/r");
  });

  it("strips trailing slashes so the path never doubles up", () => {
    expect(signalingUrl("http://x:8000///", "r")).toBe("ws://x:8000/ws/r");
  });

  it("percent-encodes the room so it cannot inject path segments", () => {
    expect(signalingUrl("http://x", "a/../b")).toBe("ws://x/ws/a%2F..%2Fb");
    expect(signalingUrl("http://x", "a b&c")).toBe("ws://x/ws/a%20b%26c");
  });

  it("rejects an empty room", () => {
    expect(() => signalingUrl("http://x", "")).toThrow(/room is required/);
  });
});
