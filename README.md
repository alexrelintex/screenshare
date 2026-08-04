# screen-share

An embeddable, dependency-free custom element for **1:1 WebRTC screen sharing with a remote
cursor**. Drop one `<script>` tag on a page, add `<screen-share>`, done. **11.5 KB minified.**

Media is peer-to-peer — the server relays signaling only and never sees a video frame.

```html
<script src="https://your-host/screenshare.js"></script>

<!-- the person sharing -->
<screen-share room="standup" signaling="https://sig.example.com" mode="host"></screen-share>

<!-- the person watching -->
<screen-share room="standup" signaling="https://sig.example.com" mode="viewer"></screen-share>
```

---

## Why a custom element

The widget is dropped into pages whose CSS nobody controls. It renders inside an **open shadow
root**, so a host page's `* { box-sizing: content-box }`, `video { width: 40px }`, or Bootstrap
reset cannot reach in, and its own styles cannot leak out. It registers exactly one global — the
element name — and sets no `window` properties. Loading the bundle twice is a no-op.

The demo page deliberately applies hostile CSS (`video { width: 40px !important }`, hotpink 28px
buttons) and an automated test asserts none of it penetrates.

## Attributes

| Attribute | Required | Values | Notes |
|---|---|---|---|
| `room` | yes | any string | Peers sharing a room id connect. Percent-encoded before use. |
| `signaling` | yes | URL | `http(s)://` is upgraded to `ws(s)://` automatically. |
| `mode` | no | `host` \| `viewer` | Defaults to `host`. |

Attributes may be set before *or after* insertion — the element reconnects when they change,
debounced to one restart per microtask.

## Events

All bubble and cross the shadow boundary (`composed: true`).

| Event | `detail` | Fires when |
|---|---|---|
| `ss-state` | `{ state, detail }` | Connection state changes |
| `ss-stream` | `{ stream }` | A remote MediaStream arrives |
| `ss-cursor` | `{ x, y }` | Remote pointer moved (0..1 normalised) |
| `ss-sharing` | — | Local capture started |
| `ss-stopped` | — | Sharing stopped |
| `ss-error` | `{ error }` | Something failed |

States: `idle` → `waiting-for-peer` → `negotiating` → `connected`, plus `disconnected`,
`failed`, `closed`.

## Remote cursor

The viewer's pointer is shown over the host's own preview. Coordinates travel **normalised to
0..1**, not pixels — the viewer's `<video>` is almost never the same size as the shared screen,
so pixels would land in the wrong place. Messages are throttled to 30 Hz with a guaranteed
trailing send, so the pointer never freezes slightly short of where it stopped.

This is a *pointer*, not remote control. Nothing is injected into the host's input stream.

---

## Run it locally

```bash
make setup        # uv venv + npm install
make ci           # lint + unit tests + bundle (identical to CI)
make up-native    # signaling :8000, demo :5173 — no Docker needed
make smoke
```

Then open two tabs:

- host: <http://127.0.0.1:5173/demo/index.html?room=demo&mode=host>
- viewer: <http://127.0.0.1:5173/demo/index.html?room=demo&mode=viewer>

Click **Share screen** in the host tab, pick a window, then move your mouse over the video in the
viewer tab and watch the dot track it on the host.

### Docker

```bash
make build && make up && make smoke
make down
```

Both services publish to the host rather than talking to each other over the compose network —
the *browser* is the client for both, and a browser cannot resolve a compose service name.

## Testing

| Layer | Command | Covers |
|---|---|---|
| Unit (Python) | `make test` | Room capacity, relay whitelist, malformed frames, oversized frames, room reclamation |
| Unit (TS) | `make test` | Coordinate normalisation and round-trip, throttle timing, protocol parsing, URL building |
| End-to-end | `make e2e` | Two real Chromium pages, real signaling, real SDP/ICE, real MediaStream, cursor over the data channel |

The E2E suite substitutes a canvas-backed `MediaStream` for `getDisplayMedia` through the
element's `captureSource` seam, because a headless browser has no desktop to capture. Everything
downstream of that one call is real. `getDisplayMedia` itself is the only part not covered by
automation — verify it by hand with the two tabs above.

---

## Limits — read before deploying

- **No TURN.** STUN only, via a public Google server. STUN discovers your public address; it
  cannot relay. Peers behind symmetric NAT or strict corporate firewalls **will fail to
  connect**. Supply your own TURN server (coturn) and pass `iceServers` for real-world use.
- **No authentication.** Anyone who knows a room id can join it. Room ids are the only secret.
  Put an auth layer in front of the signaling endpoint before exposing it.
- **Single process.** Rooms live in memory. Two replicas will not see each other's rooms;
  Redis pub/sub is the path to horizontal scale.
- **`getDisplayMedia` requires a secure context** — HTTPS, or `localhost`. It will not work over
  plain HTTP on a LAN address.
- **CORS is wide open** (`allow_origins=["*"]`) because the widget is embedded on third-party
  pages by design. Narrow it to your known embedders in production.
- **1:1 only.** A third peer is rejected with `room-full`. Many-viewer broadcast needs an SFU.

## Embedding in a sandboxed iframe

`getDisplayMedia` is gated by the `display-capture` Permissions Policy. Inside an iframe it
throws `NotAllowedError` unless the **parent** page grants it:

```html
<iframe src="…" allow="display-capture"></iframe>
```

If you do not control the parent frame, you cannot grant this to yourself. That constraint
governs whether the widget can be embedded in any third-party host application.

## License

MIT — see [LICENSE](LICENSE).
