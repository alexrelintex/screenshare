/**
 * <screen-share> custom element.
 *
 * Shadow DOM is not decoration here: this widget is dropped into pages whose
 * CSS we have never seen. An open shadow root means the host page's `* { box-
 * sizing }`, `img { width: 100% }`, and Bootstrap resets cannot reach inside,
 * and our styles cannot leak out. The element registers exactly one global —
 * the custom element name — and no window properties.
 */

import type { NormalizedPoint, Rect } from "./cursor.js";
import { contentRect, denormalize, normalize, throttle } from "./cursor.js";
import type { ConnState, Role } from "./peer.js";
import { PeerSession } from "./peer.js";

const CURSOR_HZ = 30;

/**
 * How long the remote pointer stays visible after the last cursor message.
 *
 * A mouse announces its departure with `pointerleave`; a finger does not. With
 * no timeout the host keeps staring at a dot frozen wherever the viewer last
 * touched, for as long as the session lasts.
 */
const POINTER_IDLE_MS = 2000;

/**
 * What separates a tap from a drag.
 *
 * A finger never lands and lifts on exactly one pixel, so some slop is required
 * or nothing on a touchscreen ever counts as a tap. The time limit keeps a slow
 * reposition — finger down, think, lift — from firing a "look here" nobody
 * meant.
 */
const TAP_SLOP_PX = 12;
const TAP_MAX_MS = 700;

/** Lifetime of the ripple the host draws at a tap. Matches the CSS animation. */
const RIPPLE_MS = 620;

const STYLES = `
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
    /* A container query, not a media query. Media queries inside a shadow root
       still measure the viewport, and this widget is routinely 320px wide on a
       1400px desktop — the viewport tells us nothing about the space we have. */
    container-type: inline-size;
  }
  .stage { position: relative; aspect-ratio: 16 / 9; background: #0d0d10; }
  video { width: 100%; height: 100%; object-fit: contain; display: block; background: #0d0d10; }
  /* Viewer only: a drag across the video is a pointing gesture, not a scroll.
     Without this the browser claims the gesture, fires pointercancel, and the
     remote cursor stops dead halfway through the swipe. */
  .viewer video { touch-action: none; }
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
    /* .wrap clips overflow, so without wrapping the state label is cut off
       rather than moved — on a narrow phone the connection state, the one
       thing you need when it will not connect, silently disappears. */
    flex-wrap: wrap;
  }
  button {
    font: inherit; font-size: 14px; font-weight: 500;
    padding: 7px 14px; border-radius: 7px; border: 0;
    background: var(--ss-accent); color: #fff; cursor: pointer;
  }
  button:hover:not(:disabled) { filter: brightness(1.1); }
  button:disabled { opacity: .45; cursor: not-allowed; }
  button.stop { background: #3a3a44; }
  .state {
    font-size: 13px; color: #9b9ba6; margin-left: auto;
    display: flex; gap: 7px; align-items: center;
    /* A flex item will not shrink below its content without this, which is how
       "failed — <a long ICE message>" pushes the buttons off the edge. */
    min-width: 0;
  }
  .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b6b77; flex: none; }
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
  /* A tap is a moment, not a state: it expands and clears itself. Positioned
     with left/top so the animation owns transform outright. */
  .ripple {
    position: absolute; width: 26px; height: 26px; margin: -13px 0 0 -13px;
    border-radius: 50%; pointer-events: none;
    border: 2px solid var(--ss-accent);
    background: rgba(79,140,255,.18);
    animation: ss-ripple 620ms cubic-bezier(.22,.61,.36,1) forwards;
  }
  @keyframes ss-ripple {
    from { transform: scale(.4); opacity: 1; }
    to   { transform: scale(2.6); opacity: 0; }
  }
  /* Still announce the location, just without the expansion. */
  @media (prefers-reduced-motion: reduce) {
    .ripple { animation: ss-ripple-hold 620ms steps(1, end) forwards; }
    @keyframes ss-ripple-hold {
      from { transform: scale(1.4); opacity: 1; }
      to   { transform: scale(1.4); opacity: 0; }
    }
  }

  /* Touch input, whatever the screen size: ~31px of button is well under the
     ~44px a finger needs to hit reliably. Keyed on the input device, not the
     width, because a large tablet has the same problem. */
  @media (pointer: coarse) {
    button { padding: 12px 18px; min-height: 44px; }
  }

  /* Narrow *widget*, not narrow screen. At this size the state label no longer
     fits beside the buttons, so give it its own row instead of an ellipsis. */
  @container (max-width: 380px) {
    .bar { gap: 8px; padding: 8px 10px; }
    button { flex: 1 1 auto; }
    .state { margin-left: 0; flex-basis: 100%; order: -1; }
  }
`;

export class ScreenShareElement extends HTMLElement {
  static observedAttributes = ["room", "signaling", "mode", "max-bitrate"];

  /**
   * Test / integration seam. Defaults to getDisplayMedia. Overriding it lets
   * automated tests drive the whole pipeline with a synthetic MediaStream,
   * because a headless browser has no desktop to capture.
   */
  captureSource?: () => Promise<MediaStream>;

  private session: PeerSession | null = null;
  private root!: ShadowRoot;
  private video!: HTMLVideoElement;
  private pointer!: HTMLDivElement;
  private shareBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private stateText!: HTMLSpanElement;
  private stateDot!: HTMLSpanElement;
  private emptyMsg!: HTMLDivElement;
  private sendCursor = throttle((_p: NormalizedPoint) => {}, 1000 / CURSOR_HZ);
  private stage!: HTMLDivElement;
  private pointerIdle: ReturnType<typeof setTimeout> | null = null;

  get room(): string {
    return this.getAttribute("room") ?? "";
  }
  get signaling(): string {
    return this.getAttribute("signaling") ?? "";
  }
  /**
   * Outbound encoder ceiling in bits per second. Absent, zero or unparseable
   * means the default — an embedder on a LAN can raise it, and `0` should not
   * be read as "cap at nothing", which would silence the stream entirely.
   */
  get maxBitrate(): number | undefined {
    const raw = Number(this.getAttribute("max-bitrate"));
    return Number.isFinite(raw) && raw > 0 ? raw : undefined;
  }

  get mode(): Role {
    return this.getAttribute("mode") === "viewer" ? "viewer" : "host";
  }

  private restartQueued = false;

  connectedCallback(): void {
    if (!this.root) this.root = this.attachShadow({ mode: "open" });
    this.build();
    void this.begin();
  }

  disconnectedCallback(): void {
    this.teardown();
  }

  /**
   * Attributes commonly arrive AFTER the element is in the DOM — a host page
   * that does `el.setAttribute("room", …)` post-insert, or a framework that
   * patches props on the next tick. Without this the element would sit in a
   * permanent "room and signaling are required" failure. Restart is debounced
   * to a microtask so setting three attributes in a row reconnects once.
   */
  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null): void {
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

  private teardown(): void {
    this.sendCursor.cancel();
    this.clearPointerIdle();
    this.session?.close();
    this.session = null;
  }

  /**
   * Whether this device can produce a stream to share.
   *
   * Feature detection, never user-agent sniffing: the seam counts too, so an
   * automated run that supplies `captureSource` is never gated out. A page that
   * assigns the seam *after* insertion should set an attribute as well, which
   * re-runs build() through attributeChangedCallback.
   */
  private captureSupported(): boolean {
    return (
      typeof this.captureSource === "function" ||
      typeof navigator.mediaDevices?.getDisplayMedia === "function"
    );
  }

  /** (Re)populate the shadow root. Safe to call repeatedly. */
  private build(): void {
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

    // Viewer only: the video is a pointing surface, so the browser must stop
    // treating a drag across it as a page scroll. Host pages embedding a host-
    // mode widget keep normal scrolling.
    if (this.mode === "viewer") wrap.classList.add("viewer");

    this.root.append(style, wrap);
    this.stage = wrap.querySelector(".stage")!;
    this.video = wrap.querySelector("video")!;
    this.pointer = wrap.querySelector(".pointer")!;
    this.shareBtn = wrap.querySelector("button.share")!;
    this.stopBtn = wrap.querySelector("button.stop")!;
    this.stateText = wrap.querySelector(".label")!;
    this.stateDot = wrap.querySelector(".dot")!;
    this.emptyMsg = wrap.querySelector(".empty")!;

    const host = this.mode === "host";
    // Screen capture is a desktop capability. iOS has no API for it at all and
    // Android browsers do not expose one either, so on a phone the host button
    // is a button that throws. Say so instead, and point at the role that does
    // work on this device.
    const canCapture = this.captureSupported();
    this.shareBtn.textContent = host ? "Share screen" : "Waiting for host";
    this.shareBtn.disabled = !host || !canCapture;
    this.emptyMsg.textContent = host
      ? canCapture
        ? "Click “Share screen” to start."
        : "This browser cannot share a screen — phones and tablets have no screen-capture API. Open this room as a viewer instead."
      : "Waiting for the host to share…";
    if (host && !canCapture) {
      this.dispatchEvent(
        new CustomEvent("ss-error", {
          detail: { error: "capture-unsupported" },
          bubbles: true,
          composed: true,
        }),
      );
    }

    this.shareBtn.addEventListener("click", () => void this.startShare());
    this.stopBtn.addEventListener("click", () => this.stopShare());

    // The stream dictates the stage's shape, so react whenever its dimensions
    // land or change (a host switching monitors mid-session fires `resize`).
    this.video.addEventListener("loadedmetadata", () => this.syncAspect());
    this.video.addEventListener("resize", () => this.syncAspect());

    if (this.mode === "viewer") {
      // Viewer reports its pointer; the host sees it over their own preview.
      this.sendCursor = throttle(
        (p: NormalizedPoint) => this.session?.sendCursor(p),
        1000 / CURSOR_HZ,
      );
      const send = (ev: PointerEvent): void => {
        this.sendCursor(normalize(ev.clientX, ev.clientY, this.videoRect()));
      };
      this.video.addEventListener("pointermove", send);

      // Where and when the pointer landed, to tell a tap from a drag on release.
      let downAt = 0;
      let downX = 0;
      let downY = 0;

      // A touch reports nothing until it lands, so without this a tap moves
      // the remote pointer only if the finger then drags.
      this.video.addEventListener("pointerdown", (ev) => {
        downAt = ev.timeStamp;
        downX = ev.clientX;
        downY = ev.clientY;
        send(ev);
      });
      this.video.addEventListener("pointerleave", () => this.sendCursor.flush());
      // `pointerup` and `pointercancel` are the touch equivalents of leaving:
      // the finger is gone. Cancel in particular fires when the browser decides
      // the gesture was a scroll after all — without flushing here the final
      // position is simply dropped.
      this.video.addEventListener("pointerup", (ev) => {
        this.sendCursor.flush();
        // Decided on release, not on press: at press time a drag and a tap are
        // indistinguishable, and a ripple for every drag is noise.
        const travelled = Math.hypot(ev.clientX - downX, ev.clientY - downY);
        if (downAt > 0 && ev.timeStamp - downAt <= TAP_MAX_MS && travelled <= TAP_SLOP_PX) {
          this.session?.sendTap(normalize(ev.clientX, ev.clientY, this.videoRect()));
        }
        downAt = 0;
      });
      this.video.addEventListener("pointercancel", () => {
        this.sendCursor.flush();
        downAt = 0;
      });
    }
  }

  /**
   * The box the video actually paints, in viewport coordinates.
   *
   * Not the element box: `object-fit: contain` letterboxes any stream whose
   * aspect ratio differs from the stage's, and cursor coordinates must be
   * relative to the picture, not to the bars beside it.
   */
  private videoRect(): Rect {
    const r = this.video.getBoundingClientRect();
    return contentRect(
      { left: r.left, top: r.top, width: r.width, height: r.height },
      this.video.videoWidth,
      this.video.videoHeight,
    );
  }

  /**
   * Match the stage to the stream's own aspect ratio once it is known.
   *
   * Two wins: the video fills the widget instead of sitting in a 16:9 letterbox
   * (which on a portrait phone leaves it a thin strip), and the bars vanish, so
   * the correction in videoRect() has nothing left to correct.
   */
  private syncAspect(): void {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (w > 0 && h > 0) this.stage.style.aspectRatio = `${w} / ${h}`;
  }

  private setState(state: ConnState, detail?: string): void {
    this.stateText.textContent = detail ? `${state} — ${detail}` : state;
    this.stateDot.dataset.s = state;
    this.dispatchEvent(
      new CustomEvent("ss-state", { detail: { state, detail }, bubbles: true, composed: true }),
    );
  }

  private async begin(): Promise<void> {
    if (!this.room || !this.signaling) {
      // Not an error yet — attributes may still be on their way in. Stay idle
      // and let attributeChangedCallback restart us when they land.
      this.setState("idle", "waiting for room / signaling attributes");
      return;
    }
    this.session = new PeerSession({
      signaling: this.signaling,
      room: this.room,
      role: this.mode,
      maxBitrate: this.maxBitrate,
      onState: (s, d) => this.setState(s, d),
      onRemoteStream: (stream) => {
        this.video.srcObject = stream;
        this.emptyMsg.textContent = "";
        void this.video.play().catch(() => {});
        this.dispatchEvent(
          new CustomEvent("ss-stream", { detail: { stream }, bubbles: true, composed: true }),
        );
      },
      onRemoteCursor: (p) => this.showPointer(p),
      onRemoteTap: (p) => this.showTap(p),
      onError: (err) => {
        this.dispatchEvent(
          new CustomEvent("ss-error", { detail: { error: err }, bubbles: true, composed: true }),
        );
      },
    });

    try {
      await this.session.connect();
    } catch (err) {
      this.setState("failed", err instanceof Error ? err.message : String(err));
    }
  }

  private showPointer(p: NormalizedPoint): void {
    const r = this.videoRect();
    const box = this.getBoundingClientRect();
    // Position relative to the widget, not the page.
    const pt = denormalize(p, {
      left: r.left - box.left,
      top: r.top - box.top,
      width: r.width,
      height: r.height,
    });
    this.pointer.style.transform = `translate(${pt.x}px, ${pt.y}px)`;
    this.pointer.classList.add("on");
    this.armPointerIdle();
    this.dispatchEvent(
      new CustomEvent("ss-cursor", { detail: p, bubbles: true, composed: true }),
    );
  }

  /**
   * Draw a ripple where the viewer tapped.
   *
   * At the tap's own coordinates, deliberately — not wherever the cursor dot
   * currently sits. The data channel is unordered, so a tap can arrive after
   * the moves that followed it, and anchoring to the dot would put the marker
   * somewhere the viewer never pointed.
   */
  private showTap(p: NormalizedPoint): void {
    const r = this.videoRect();
    const box = this.getBoundingClientRect();
    const pt = denormalize(p, {
      left: r.left - box.left,
      top: r.top - box.top,
      width: r.width,
      height: r.height,
    });

    // One element per tap: two taps in quick succession should both be visible,
    // which reusing a single node and restarting its animation cannot do.
    const ripple = document.createElement("div");
    ripple.className = "ripple";
    ripple.style.left = `${pt.x}px`;
    ripple.style.top = `${pt.y}px`;
    this.stage.append(ripple);
    const drop = (): void => ripple.remove();
    ripple.addEventListener("animationend", drop);
    // Belt and braces: if the animation never runs (a background tab throttling
    // it, say) the node would otherwise accumulate for the whole session.
    setTimeout(drop, RIPPLE_MS + 400);

    this.dispatchEvent(
      new CustomEvent("ss-tap", { detail: p, bubbles: true, composed: true }),
    );
  }

  /** Hide the remote pointer if no further cursor message arrives. */
  private armPointerIdle(): void {
    if (this.pointerIdle !== null) clearTimeout(this.pointerIdle);
    this.pointerIdle = setTimeout(() => {
      this.pointerIdle = null;
      this.pointer.classList.remove("on");
    }, POINTER_IDLE_MS);
  }

  private clearPointerIdle(): void {
    if (this.pointerIdle === null) return;
    clearTimeout(this.pointerIdle);
    this.pointerIdle = null;
  }

  private async startShare(): Promise<void> {
    if (!this.session) return;
    try {
      const capture =
        this.captureSource ??
        (() => navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }));
      const stream = await capture();

      const track = stream.getVideoTracks()[0];
      // Screen content is mostly text. Tell the encoder to hold detail rather
      // than frame rate when it has to trade one for the other.
      if (track) track.contentHint = "detail";
      // The browser's own "Stop sharing" affordance ends the track directly.
      track?.addEventListener("ended", () => this.stopShare());

      this.video.srcObject = stream;
      this.emptyMsg.textContent = "";
      void this.video.play().catch(() => {});
      await this.session.share(stream);

      this.shareBtn.disabled = true;
      this.stopBtn.disabled = false;
      this.dispatchEvent(new CustomEvent("ss-sharing", { bubbles: true, composed: true }));
    } catch (err) {
      // A user dismissing the picker throws NotAllowedError — not an error state.
      const name = (err as { name?: string }).name;
      if (name === "NotAllowedError" || name === "AbortError") return;
      this.setState("failed", err instanceof Error ? err.message : String(err));
    }
  }

  private stopShare(): void {
    const src = this.video.srcObject;
    if (src instanceof MediaStream) src.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.emptyMsg.textContent = "Sharing stopped.";
    this.clearPointerIdle();
    this.pointer.classList.remove("on");
    // Back to the placeholder shape; the next stream sets its own.
    this.stage.style.removeProperty("aspect-ratio");
    this.shareBtn.disabled = this.mode !== "host";
    this.stopBtn.disabled = true;
    this.dispatchEvent(new CustomEvent("ss-stopped", { bubbles: true, composed: true }));
  }
}
