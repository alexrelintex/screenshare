/**
 * Wire protocol between widget and signaling server.
 *
 * Everything here is pure — no DOM, no WebSocket, no WebRTC — so it is unit
 * testable without a browser. Anything that touches a browser API lives in
 * peer.ts or element.ts.
 */

export interface WelcomeMessage {
  type: "welcome";
  peerId: string;
  peers: string[];
}

export interface PeerJoinedMessage {
  type: "peer-joined";
  peerId: string;
}

export interface PeerLeftMessage {
  type: "peer-left";
  peerId: string;
}

export interface OfferMessage {
  type: "offer";
  sdp: string;
  from?: string;
}

export interface AnswerMessage {
  type: "answer";
  sdp: string;
  from?: string;
}

export interface IceMessage {
  type: "ice";
  candidate: RTCIceCandidateInit | null;
  from?: string;
}

export interface ErrorMessage {
  type: "error";
  code: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PeerJoinedMessage
  | PeerLeftMessage
  | OfferMessage
  | AnswerMessage
  | IceMessage
  | ErrorMessage;

const KNOWN_TYPES = new Set([
  "welcome",
  "peer-joined",
  "peer-left",
  "offer",
  "answer",
  "ice",
  "error",
]);

/**
 * Parse a raw frame from the server.
 *
 * Returns null rather than throwing for anything unrecognised: a signaling
 * server that gains a new message type must not break older embedded widgets,
 * and a malformed frame must not take down a page it is embedded in.
 */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const type = (value as { type?: unknown }).type;
  if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;

  // Shape checks only for fields we actually dereference.
  const v = value as Record<string, unknown>;
  switch (type) {
    case "welcome":
      if (typeof v.peerId !== "string" || !Array.isArray(v.peers)) return null;
      break;
    case "peer-joined":
    case "peer-left":
      if (typeof v.peerId !== "string") return null;
      break;
    case "offer":
    case "answer":
      if (typeof v.sdp !== "string") return null;
      break;
    case "ice":
      if (!("candidate" in v)) return null;
      break;
    case "error":
      if (typeof v.code !== "string") return null;
      break;
  }
  return value as ServerMessage;
}

/** Build the signaling URL for a room, upgrading http(s) to ws(s). */
export function signalingUrl(base: string, room: string): string {
  if (!room) throw new Error("room is required");
  const trimmed = base.replace(/\/+$/, "");
  const scheme = trimmed.replace(/^http(s?):/, "ws$1:");
  return `${scheme}/ws/${encodeURIComponent(room)}`;
}
