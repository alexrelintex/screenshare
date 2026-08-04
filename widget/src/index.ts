/**
 * Entry point. Registers <screen-share> and nothing else.
 *
 * The bundle is an IIFE: it defines no window globals, adds no polyfills, and
 * touches no host-page state beyond the custom element registry. Loading it
 * twice is a no-op rather than a `NotSupportedError`.
 */

import { ScreenShareElement } from "./element.js";

export const TAG = "screen-share";

export function register(tag: string = TAG): void {
  if (typeof customElements === "undefined") return;
  if (customElements.get(tag)) return;
  customElements.define(tag, ScreenShareElement);
}

register();

export { ScreenShareElement };
export * from "./cursor.js";
export * from "./protocol.js";
export { DEFAULT_ICE, PeerSession } from "./peer.js";
export type { ConnState, PeerOptions, Role } from "./peer.js";
