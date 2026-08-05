"use strict";
(() => {
  // src/cursor.ts
  var clamp01 = (n) => n < 0 ? 0 : n > 1 ? 1 : n;
  function normalize(clientX, clientY, rect) {
    if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
    return {
      x: clamp01((clientX - rect.left) / rect.width),
      y: clamp01((clientY - rect.top) / rect.height)
    };
  }
  function denormalize(p, rect) {
    return {
      x: rect.left + clamp01(p.x) * rect.width,
      y: rect.top + clamp01(p.y) * rect.height
    };
  }
  function isCursorMessage(value) {
    if (typeof value !== "object" || value === null) return false;
    const v = value;
    return v.type === "cursor" && typeof v.x === "number" && typeof v.y === "number" && Number.isFinite(v.x) && Number.isFinite(v.y);
  }
  function throttle(fn, ms, now = () => Date.now()) {
    let last = -Infinity;
    let timer = null;
    let pending = null;
    const invoke = (args) => {
      last = now();
      fn(...args);
    };
    const wrapped = (...args) => {
      const elapsed = now() - last;
      if (elapsed >= ms) {
        invoke(args);
        return;
      }
      pending = args;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          if (pending) {
            const p = pending;
            pending = null;
            invoke(p);
          }
        }, ms - elapsed);
      }
    };
    wrapped.flush = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        const p = pending;
        pending = null;
        invoke(p);
      }
    };
    wrapped.cancel = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    };
    return wrapped;
  }

  // src/protocol.ts
  var KNOWN_TYPES = /* @__PURE__ */ new Set([
    "welcome",
    "peer-joined",
    "peer-left",
    "offer",
    "answer",
    "ice",
    "error"
  ]);
  function parseServerMessage(raw) {
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const type = value.type;
    if (typeof type !== "string" || !KNOWN_TYPES.has(type)) return null;
    const v = value;
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
    return value;
  }
  function signalingUrl(base, room) {
    if (!room) throw new Error("room is required");
    const trimmed = base.replace(/\/+$/, "");
    const scheme = trimmed.replace(/^http(s?):/, "ws$1:");
    return `${scheme}/ws/${encodeURIComponent(room)}`;
  }

  // src/peer.ts
  var DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
  var CURSOR_CHANNEL = "cursor";
  var PeerSession = class {
    constructor(opts) {
      this.opts = opts;
    }
    ws = null;
    pc = null;
    channel = null;
    stream = null;
    peerPresent = false;
    remoteDescriptionSet = false;
    /** ICE can arrive before the remote description exists; buffer or it is lost. */
    pendingCandidates = [];
    state = "idle";
    closed = false;
    get connectionState() {
      return this.state;
    }
    setState(next, detail) {
      if (this.state === next) return;
      this.state = next;
      this.opts.onState?.(next, detail);
    }
    fail(error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.opts.onError?.(err);
      this.setState("failed", err.message);
    }
    /** Open the signaling socket. Resolves once the server sends `welcome`. */
    async connect() {
      const url = signalingUrl(this.opts.signaling, this.opts.room);
      await new Promise((resolve, reject) => {
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
        ws.onmessage = (ev) => {
          const msg = parseServerMessage(ev.data);
          if (!msg) return;
          if (msg.type === "welcome" && !settled) {
            settled = true;
            this.peerPresent = msg.peers.length > 0;
            resolve();
          }
          void this.handle(msg);
        };
      });
    }
    send(payload) {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      }
    }
    ensurePeerConnection() {
      if (this.pc) return this.pc;
      const pc = new RTCPeerConnection({ iceServers: this.opts.iceServers ?? DEFAULT_ICE });
      this.pc = pc;
      pc.onicecandidate = (ev) => {
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
            this.setState("failed", "ice failed \u2014 a TURN server is likely required");
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
    attachChannel(channel) {
      this.channel = channel;
      channel.onmessage = (ev) => {
        let parsed;
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
    async share(stream) {
      if (this.opts.role !== "host") throw new Error("only the host can share");
      this.stream = stream;
      const pc = this.ensurePeerConnection();
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
      if (this.peerPresent) await this.offer();
    }
    async offer() {
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
    async handle(msg) {
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
    async drainCandidates() {
      if (!this.pc) return;
      const queued = this.pendingCandidates;
      this.pendingCandidates = [];
      for (const candidate of queued) {
        try {
          await this.pc.addIceCandidate(candidate);
        } catch {
        }
      }
    }
    /** Viewer only: report pointer position over the shared video. */
    sendCursor(point) {
      if (this.channel?.readyState !== "open") return;
      this.channel.send(JSON.stringify({ type: "cursor", x: point.x, y: point.y }));
    }
    close() {
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
  };

  // src/element.ts
  var CURSOR_HZ = 30;
  var STYLES = `
  :host {
    all: initial;
    display: block;
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    color: #e8e8ea;
    --ss-bg: #16161a;
    --ss-accent: #4f8cff;
  }
  .wrap {
    position: relative;
    background: var(--ss-bg);
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid #2a2a31;
  }
  .stage { position: relative; aspect-ratio: 16 / 9; background: #0d0d10; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; background: #0d0d10; }
  .empty {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    color: #7a7a85; font-size: 14px; text-align: center; padding: 16px;
    /* This overlay covers the whole stage. Without pointer-events:none it eats
       every pointermove and the remote cursor silently never sends. */
    pointer-events: none;
  }
  /* Once cleared it should not occupy the stage at all. */
  .empty:empty { display: none; }
  .bar {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-top: 1px solid #2a2a31;
  }
  button {
    font: inherit; font-size: 14px; font-weight: 500;
    padding: 7px 14px; border-radius: 7px; border: 0;
    background: var(--ss-accent); color: #fff; cursor: pointer;
  }
  button:hover:not(:disabled) { filter: brightness(1.1); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.stop { background: #3a3a44; }
  .state { font-size: 13px; color: #9b9ba6; margin-left: auto; display: flex; gap: 7px; align-items: center; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b77; }
  .dot[data-s="connected"] { background: #35c07a; }
  .dot[data-s="negotiating"], .dot[data-s="waiting-for-peer"] { background: #e0a83a; }
  .dot[data-s="failed"] { background: #e0574a; }
  .pointer {
    position: absolute; width: 16px; height: 16px; margin: -8px 0 0 -8px;
    border-radius: 50%; pointer-events: none; opacity: 0;
    background: rgba(79,140,255,.45); border: 2px solid var(--ss-accent);
    transition: opacity .2s;
  }
  .pointer.on { opacity: 1; }
`;
  var ScreenShareElement = class extends HTMLElement {
    static observedAttributes = ["room", "signaling", "mode"];
    /**
     * Test / integration seam. Defaults to getDisplayMedia. Overriding it lets
     * automated tests drive the whole pipeline with a synthetic MediaStream,
     * because a headless browser has no desktop to capture.
     */
    captureSource;
    session = null;
    root;
    video;
    pointer;
    shareBtn;
    stopBtn;
    stateText;
    stateDot;
    emptyMsg;
    sendCursor = throttle((_p) => {
    }, 1e3 / CURSOR_HZ);
    get room() {
      return this.getAttribute("room") ?? "";
    }
    get signaling() {
      return this.getAttribute("signaling") ?? "";
    }
    get mode() {
      return this.getAttribute("mode") === "viewer" ? "viewer" : "host";
    }
    restartQueued = false;
    connectedCallback() {
      if (!this.root) this.root = this.attachShadow({ mode: "open" });
      this.build();
      void this.begin();
    }
    disconnectedCallback() {
      this.teardown();
    }
    /**
     * Attributes commonly arrive AFTER the element is in the DOM — a host page
     * that does `el.setAttribute("room", …)` post-insert, or a framework that
     * patches props on the next tick. Without this the element would sit in a
     * permanent "room and signaling are required" failure. Restart is debounced
     * to a microtask so setting three attributes in a row reconnects once.
     */
    attributeChangedCallback(_name, oldValue, newValue) {
      if (oldValue === newValue || !this.isConnected) return;
      if (this.restartQueued) return;
      this.restartQueued = true;
      queueMicrotask(() => {
        this.restartQueued = false;
        if (!this.isConnected) return;
        this.teardown();
        this.build();
        void this.begin();
      });
    }
    teardown() {
      this.sendCursor.cancel();
      this.session?.close();
      this.session = null;
    }
    /** (Re)populate the shadow root. Safe to call repeatedly. */
    build() {
      this.root.replaceChildren();
      const style = document.createElement("style");
      style.textContent = STYLES;
      const wrap = document.createElement("div");
      wrap.className = "wrap";
      wrap.innerHTML = `
      <div class="stage">
        <video part="video" autoplay playsinline muted></video>
        <div class="empty"></div>
        <div class="pointer"></div>
      </div>
      <div class="bar">
        <button class="share"></button>
        <button class="stop" disabled>Stop</button>
        <span class="state"><span class="dot"></span><span class="label">idle</span></span>
      </div>`;
      this.root.append(style, wrap);
      this.video = wrap.querySelector("video");
      this.pointer = wrap.querySelector(".pointer");
      this.shareBtn = wrap.querySelector("button.share");
      this.stopBtn = wrap.querySelector("button.stop");
      this.stateText = wrap.querySelector(".label");
      this.stateDot = wrap.querySelector(".dot");
      this.emptyMsg = wrap.querySelector(".empty");
      const host = this.mode === "host";
      this.shareBtn.textContent = host ? "Share screen" : "Waiting for host";
      this.shareBtn.disabled = !host;
      this.emptyMsg.textContent = host ? "Click \u201CShare screen\u201D to start." : "Waiting for the host to share\u2026";
      this.shareBtn.addEventListener("click", () => void this.startShare());
      this.stopBtn.addEventListener("click", () => this.stopShare());
      if (this.mode === "viewer") {
        this.sendCursor = throttle(
          (p) => this.session?.sendCursor(p),
          1e3 / CURSOR_HZ
        );
        this.video.addEventListener("pointermove", (ev) => {
          this.sendCursor(normalize(ev.clientX, ev.clientY, this.videoRect()));
        });
        this.video.addEventListener("pointerleave", () => this.sendCursor.flush());
      }
    }
    /** Bounding box of the video element, in its own coordinate space. */
    videoRect() {
      const r = this.video.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }
    setState(state, detail) {
      this.stateText.textContent = detail ? `${state} \u2014 ${detail}` : state;
      this.stateDot.dataset.s = state;
      this.dispatchEvent(
        new CustomEvent("ss-state", { detail: { state, detail }, bubbles: true, composed: true })
      );
    }
    async begin() {
      if (!this.room || !this.signaling) {
        this.setState("idle", "waiting for room / signaling attributes");
        return;
      }
      this.session = new PeerSession({
        signaling: this.signaling,
        room: this.room,
        role: this.mode,
        onState: (s, d) => this.setState(s, d),
        onRemoteStream: (stream) => {
          this.video.srcObject = stream;
          this.emptyMsg.textContent = "";
          void this.video.play().catch(() => {
          });
          this.dispatchEvent(
            new CustomEvent("ss-stream", { detail: { stream }, bubbles: true, composed: true })
          );
        },
        onRemoteCursor: (p) => this.showPointer(p),
        onError: (err) => {
          this.dispatchEvent(
            new CustomEvent("ss-error", { detail: { error: err }, bubbles: true, composed: true })
          );
        }
      });
      try {
        await this.session.connect();
      } catch (err) {
        this.setState("failed", err instanceof Error ? err.message : String(err));
      }
    }
    showPointer(p) {
      const r = this.video.getBoundingClientRect();
      const box = this.getBoundingClientRect();
      const pt = denormalize(p, {
        left: r.left - box.left,
        top: r.top - box.top,
        width: r.width,
        height: r.height
      });
      this.pointer.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
      this.pointer.classList.add("on");
      this.dispatchEvent(
        new CustomEvent("ss-cursor", { detail: p, bubbles: true, composed: true })
      );
    }
    async startShare() {
      if (!this.session) return;
      try {
        const capture = this.captureSource ?? (() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }));
        const stream = await capture();
        stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stopShare());
        this.video.srcObject = stream;
        this.emptyMsg.textContent = "";
        void this.video.play().catch(() => {
        });
        await this.session.share(stream);
        this.shareBtn.disabled = true;
        this.stopBtn.disabled = false;
        this.dispatchEvent(new CustomEvent("ss-sharing", { bubbles: true, composed: true }));
      } catch (err) {
        const name = err.name;
        if (name === "NotAllowedError" || name === "AbortError") return;
        this.setState("failed", err instanceof Error ? err.message : String(err));
      }
    }
    stopShare() {
      const src = this.video.srcObject;
      if (src instanceof MediaStream) src.getTracks().forEach((t) => t.stop());
      this.video.srcObject = null;
      this.emptyMsg.textContent = "Sharing stopped.";
      this.pointer.classList.remove("on");
      this.shareBtn.disabled = this.mode !== "host";
      this.stopBtn.disabled = true;
      this.dispatchEvent(new CustomEvent("ss-stopped", { bubbles: true, composed: true }));
    }
  };

  // src/index.ts
  var TAG = "screen-share";
  function register(tag = TAG) {
    if (typeof customElements === "undefined") return;
    if (customElements.get(tag)) return;
    customElements.define(tag, ScreenShareElement);
  }
  register();
})();
