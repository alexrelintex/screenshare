/**
 * WebRTC session: signaling socket + peer connection + cursor data channel.
 *
 * Role is decided by configuration, not arrival order. The host holds the media
 * and therefore always creates the offer — offering from the side without
 * tracks would force an immediate renegotiation for no reason.
 */

import type { NormalizedPoint } from "./cursor.js";
import { isCursorMessage } from "./cursor.js";
import type { ServerMessage } from "./protocol.js";
import { parseServerMessage, signalingUrl } from "./protocol.js";

export type Role = "host" | "viewer";

export type ConnState =
  | "idle"
  | "waiting-for-peer"
  | "negotiating"
  | "connected"
  | "disconnected"
  | "failed"
  | "closed";

export interface PeerOptions {
  signaling: string;
  room: string;
  role: Role;
  iceServers?: RTCIceServer[];
  onState?: (state: ConnState, detail?: string) => void;
  onRemoteStream?: (stream: MediaStream) => void;
  onRemoteCursor?: (point: NormalizedPoint) => void;
  onError?: (error: Error) => void;
}

/**
 * Public STUN only. STUN discovers your public address; it cannot relay. Peers
 * behind symmetric NAT or restrictive corporate firewalls will fail to connect
 * without a TURN server, which you must supply yourself — see README.
 */
export const DEFAULT_ICE: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

const CURSOR_CHANNEL = "cursor";

export class PeerSession {
  private ws: WebSocket | null = null;
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private stream: MediaStream | null = null;
  private peerPresent = false;
  private remoteDescriptionSet = false;
  /** ICE can arrive before the remote description exists; buffer or it is lost. */
  private pendingCandidates: RTCIceCandidateInit[] = [];
  private state: ConnState = "idle";
  private closed = false;

  constructor(private readonly opts: PeerOptions) {}

  get connectionState(): ConnState {
    return this.state;
  }

  private setState(next: ConnState, detail?: string): void {
    if (this.state === next) return;
    this.state = next;
    this.opts.onState?.(next, detail);
  }

  private fail(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.opts.onError?.(err);
    this.setState("failed", err.message);
  }

  /** Open the signaling socket. Resolves once the server sends `welcome`. */
  async connect(): Promise<void> {
    const url = signalingUrl(this.opts.signaling, this.opts.room);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.onopen = () => this.setState("waiting-for-peer");
      ws.onerror = () => {
        if (!settled) {
          settled = true;
          reject(new Error(`signaling connection failed: ${url}`));
        }
      };
      ws.onclose = () => {
        if (!this.closed) this.setState("disconnected", "signaling closed");
      };
      ws.onmessage = (ev: MessageEvent<string>) => {
        const msg = parseServerMessage(ev.data);
        if (!msg) return; // forward-compatible: ignore unknown frames
        if (msg.type === "welcome" && !settled) {
          settled = true;
          this.peerPresent = msg.peers.length > 0;
          resolve();
        }
        void this.handle(msg);
      };
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private ensurePeerConnection(): RTCPeerConnection {
    if (this.pc) return this.pc;

    const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
    this.pc = pc;

    pc.onicecandidate = (ev) => {
      // A null candidate signals end-of-gathering; relaying it is harmless and
      // lets the remote end finish faster.
      this.send({ type: "ice", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };

    pc.ontrack = (ev) => {
      const [remote] = ev.streams;
      if (remote) this.opts.onRemoteStream?.(remote);
    };

    pc.onconnectionstatechange = () => {
      switch (pc.connectionState) {
        case "connected":
          this.setState("connected");
          break;
        case "failed":
          this.setState("failed", "ice failed — a TURN server is likely required");
          break;
        case "disconnected":
          this.setState("disconnected");
          break;
      }
    };

    if (this.opts.role === "host") {
      this.attachChannel(pc.createDataChannel(CURSOR_CHANNEL, { ordered: false }));
    } else {
      pc.ondatachannel = (ev) => {
        if (ev.channel.label === CURSOR_CHANNEL) this.attachChannel(ev.channel);
      };
    }

    return pc;
  }

  private attachChannel(channel: RTCDataChannel): void {
    this.channel = channel;
    channel.onmessage = (ev: MessageEvent<string>) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (isCursorMessage(parsed)) {
        this.opts.onRemoteCursor?.({ x: parsed.x, y: parsed.y });
      }
    };
  }

  /** Host only: attach the captured stream and offer if a viewer is waiting. */
  async share(stream: MediaStream): Promise<void> {
    if (this.opts.role !== "host") throw new Error("only the host can share");
    this.stream = stream;
    const pc = this.ensurePeerConnection();
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
    }
    if (this.peerPresent) await this.offer();
  }

  private async offer(): Promise<void> {
    const pc = this.ensurePeerConnection();
    this.setState("negotiating");
    try {
      const desc = await pc.createOffer();
      await pc.setLocalDescription(desc);
      this.send({ type: "offer", sdp: desc.sdp ?? "" });
    } catch (err) {
      this.fail(err);
    }
  }

  private async handle(msg: ServerMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "peer-joined":
          this.peerPresent = true;
          if (this.opts.role === "host" && this.stream) await this.offer();
          break;

        case "peer-left":
          this.peerPresent = false;
          this.remoteDescriptionSet = false;
          this.pendingCandidates = [];
          this.setState("waiting-for-peer", "peer left");
          break;

        case "offer": {
          if (this.opts.role !== "viewer") return;
          const pc = this.ensurePeerConnection();
          this.setState("negotiating");
          await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
          this.remoteDescriptionSet = true;
          await this.drainCandidates();
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          this.send({ type: "answer", sdp: answer.sdp ?? "" });
          break;
        }

        case "answer": {
          if (this.opts.role !== "host" || !this.pc) return;
          await this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          this.remoteDescriptionSet = true;
          await this.drainCandidates();
          break;
        }

        case "ice": {
          if (!msg.candidate) return;
          if (!this.pc || !this.remoteDescriptionSet) {
            this.pendingCandidates.push(msg.candidate);
            return;
          }
          await this.pc.addIceCandidate(msg.candidate);
          break;
        }

        case "error":
          this.fail(new Error(`signaling error: ${msg.code}`));
          break;
      }
    } catch (err) {
      this.fail(err);
    }
  }

  private async drainCandidates(): Promise<void> {
    if (!this.pc) return;
    const queued = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of queued) {
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // A stale candidate from a previous negotiation is not fatal.
      }
    }
  }

  /** Viewer only: report pointer position over the shared video. */
  sendCursor(point: NormalizedPoint): void {
    if (this.channel?.readyState !== "open") return;
    this.channel.send(JSON.stringify({ type: "cursor", x: point.x, y: point.y }));
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.stream?.getTracks().forEach((t) => t.stop());
    this.pc?.close();
    this.ws?.close();
    this.channel = null;
    this.stream = null;
    this.pc = null;
    this.ws = null;
    this.setState("closed");
  }
}
