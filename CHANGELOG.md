# Changelog

## 1.0.0

First production release. The widget is a drop-in `<screen-share>` custom
element at **17.4 KB minified**, backed by a signaling service that provisions
sessions over HTTP and relays the WebRTC handshake over a WebSocket. Media is
peer-to-peer throughout; the server never sees a frame.

### The widget

- **Remote cursor.** The viewer's pointer appears over the host's own preview,
  normalised 0..1 and throttled to 30 Hz with a guaranteed trailing send.
  Coordinates map to the *painted* video, not the element box, so the dot stays
  under the pointer at any aspect ratio.
- **Tap to point.** A tap or click — down and up within 12 px and 700 ms — sends
  a discrete "look here" and draws a ripple on the host at those coordinates.
  A drag sends only cursor updates.
- **Works on a phone.** Touch drives the cursor, the stage takes the stream's
  own aspect ratio rather than a fixed 16:9 letterbox, controls stay legible and
  reachable on a narrow screen, and `?fullscreen=1` arms fullscreen for the
  first tap. On a device with no screen-capture API the host button explains
  itself instead of throwing.
- **One link, either role.** A link with no `mode` picks the role the device can
  perform: a laptop hosts, a phone views.
- **Encoder ceilings** of 1.5 Mbps and 15 fps, tuned so screen text stays legible
  on a metered connection. Override with `max-bitrate`.
- **Isolation.** An open shadow root keeps a host page's CSS out and the
  widget's styles in. One global, no `window` properties, and loading the bundle
  twice is a no-op.

### The service

- `POST /rooms` mints a session and returns links plus paste-ready embed
  snippets for both roles. Room ids are `secrets.token_urlsafe` (~72 bits) —
  with no auth on a room, the id is the only secret protecting it.
- `GET /rooms/{id}` reports occupancy, for a "waiting for customer…" indicator.
- `GET /healthz` for liveness. `WS /ws/{id}` relays `offer`, `answer` and `ice`
  and nothing else, so a room cannot be used as a general message bus.

### Documented limits

No TURN (STUN only, so symmetric NAT will fail to connect), no authentication,
and a single in-memory process, so rooms do not survive a restart or scale past
one replica. Real `getDisplayMedia` is covered by manual testing only — a
headless browser has no desktop to capture. See
[Limits](README.md#limits--read-before-deploying) and [docs/API.md](docs/API.md).

### Testing

38 Python tests, 49 TypeScript unit tests, and 13 end-to-end tests driving two
real Chromium pages through a live peer connection. `make ci` is the gate.

### Changed in this release

- The page shows the video, `Share screen` / `Stop`, and the connection state —
  nothing else. The headings, role links, copy button, hostile CSS fixture, the
  `window.__ss` debug log and the synthetic-capture hook all moved behind
  `?dev=1`, so a production session carries none of them.
- The stylesheet is minified into the bundle, which had been shipping every
  indent and comment to every embedding page (3 KB of the 20 KB total).
- Dependencies install from committed lockfiles (`uv sync`, `npm ci`).
