/**
 * Remote cursor maths.
 *
 * Coordinates travel normalised to 0..1 rather than as pixels. The viewer's
 * <video> element is almost never the same size as the shared screen, so pixel
 * coordinates would land in the wrong place. Normalising at the sender and
 * scaling at the receiver makes the pointer correct at any window size.
 */

export interface NormalizedPoint {
  x: number;
  y: number;
}

export interface CursorMessage extends NormalizedPoint {
  type: "cursor";
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Convert a viewport point into 0..1 coordinates within `rect`.
 * Points outside the rect clamp to the edge rather than escaping the range.
 * A zero-sized rect yields {0,0} instead of NaN.
 */
export function normalize(clientX: number, clientY: number, rect: Rect): NormalizedPoint {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01((clientX - rect.left) / rect.width),
    y: clamp01((clientY - rect.top) / rect.height),
  };
}

/** Inverse of normalize: 0..1 back into pixels within `rect`. */
export function denormalize(p: NormalizedPoint, rect: Rect): { x: number; y: number } {
  return {
    x: rect.left + clamp01(p.x) * rect.width,
    y: rect.top + clamp01(p.y) * rect.height,
  };
}

/** True if `value` is a well-formed cursor message from the data channel. */
export function isCursorMessage(value: unknown): value is CursorMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.type === "cursor" &&
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    Number.isFinite(v.x) &&
    Number.isFinite(v.y)
  );
}

/**
 * Rate-limit `fn` to at most once per `ms`, always delivering the final call.
 *
 * Pointer events fire far faster than anyone can perceive; without this a
 * single mouse sweep floods the data channel with hundreds of messages. The
 * trailing call matters — dropping it leaves the remote cursor frozen slightly
 * short of where the pointer actually stopped.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
  now: () => number = () => Date.now(),
): ((...args: A) => void) & { flush: () => void; cancel: () => void } {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const invoke = (args: A): void => {
    last = now();
    fn(...args);
  };

  const wrapped = (...args: A): void => {
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

  wrapped.flush = (): void => {
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

  wrapped.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending = null;
  };

  return wrapped;
}
