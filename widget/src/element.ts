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

export class ScreenShareElement extends HTMLElement {
  static observedAttributes = ["room", "signaling", "mode"];

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
    this.shareBtn.textContent = host ? "Share screen" : "Waiting for host";
    this.shareBtn.disabled = !host;
    this.emptyMsg.textContent = host
      ? "Click “Share screen” to start."
      : "Waiting for the host to share…";

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
      // A touch reports nothing until it lands, so without this a tap moves
      // the remote pointer only if the finger then drags.
      this.video.addEventListener("pointerdown", send);
      this.video.addEventListener("pointerleave", () => this.sendCursor.flush());
      // `pointerup` and `pointercancel` are the touch equivalents of leaving:
      // the finger is gone. Cancel in particular fires when the browser decides
      // the gesture was a scroll after all — without flushing here the final
      // position is simply dropped.
      this.video.addEventListener("pointerup", () => this.sendCursor.flush());
      this.video.addEventListener("pointercancel", () => this.sendCursor.flush());
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

      // The browser's own "Stop sharing" affordance ends the track directly.
      stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stopShare());

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
