# screen-share

An embeddable, dependency-free custom element for **1:1 WebRTC screen sharing with a remote
cursor**. Drop one `<script>` tag on a page, add `<screen-share>`, done. **20.4 KB minified.**

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
| `fullscreen` | no | present / absent | Viewer only. **Arms** fullscreen — the widget enters on the first tap or keypress, because no browser permits it without a user gesture. A `Full screen` button is always present in viewer mode regardless. |
| `max-bitrate` | no | bits per second | Outbound encoder ceiling. Defaults to `1500000` (~11 MB/min) with a 15 fps cap, tuned for legible text on a metered link. Raise it on a LAN. Invalid or `0` falls back to the default. |

Attributes may be set before *or after* insertion — the element reconnects when they change,
debounced to one restart per microtask.

## Events

All bubble and cross the shadow boundary (`composed: true`).

| Event | `detail` | Fires when |
|---|---|---|
| `ss-state` | `{ state, detail }` | Connection state changes |
| `ss-stream` | `{ stream }` | A remote MediaStream arrives |
| `ss-cursor` | `{ x, y }` | Remote pointer moved (0..1 normalised) |
| `ss-tap` | `{ x, y }` | Viewer tapped or clicked a specific spot — "look here", distinct from the continuous pointer. The host draws a ripple there. |
| `ss-sharing` | — | Local capture started |
| `ss-stopped` | — | Sharing stopped |
| `ss-error` | `{ error }` | Something failed. `"capture-unsupported"` on a device with no screen-capture API — phones and tablets — where host mode cannot work and the share button is disabled. |

States: `idle` → `waiting-for-peer` → `negotiating` → `connected`, plus `disconnected`,
`failed`, `closed`.

## Remote cursor

The viewer's pointer is shown over the host's own preview. Coordinates travel **normalised to
0..1**, not pixels — the viewer's `<video>` is almost never the same size as the shared screen,
so pixels would land in the wrong place. Messages are throttled to 30 Hz with a guaranteed
trailing send, so the pointer never freezes slightly short of where it stopped.

A tap or click — pointer down and up within 12 px and 700 ms — additionally sends a discrete
`tap`, and the host draws a ripple there. It renders at the tap's own coordinates rather than
wherever the dot currently sits: the data channel is unordered, so a tap can arrive after the
moves that followed it. A drag sends only cursor updates, never a tap.

This is a *pointer*, not remote control. Nothing is injected into the host's input stream — the
ripple is drawn inside the widget and the host's operating system never hears about it.

---

## Run it locally

One command. No Docker, no ports to pick, no directory to be in — the script finds the repo
root itself, installs anything missing on first run, chooses free ports, and opens both tabs.

```bash
./run-local.sh                 # start — fresh room id each run
./run-local.sh --room standup  # ...or a named room
./run-local.sh status          # the two URLs
./run-local.sh stop            # stop
```

Each run generates a new room id. Rooms hold exactly two peers, so a fixed id
would mean your second run collides with your first and the third tab is
rejected with `room-full`. Opening the demo page with no `room` parameter also
mints one and writes it into the address bar, so the URL is shareable as-is.

Then: click **Share screen** in the host tab, pick a window, and move your mouse over the video
in the viewer tab — a blue dot tracks it on the host.

**macOS:** the first share prompts for Screen Recording permission. If the picker appears but
the video stays black, grant it under **System Settings → Privacy & Security → Screen & System
Audio Recording**, then fully quit and reopen the browser — the permission is only picked up on
restart.

If 8000 or 5173 are busy the script shifts up (8001, 5174, …) and prints what it used, so a
collision is a warning rather than a failure.

<details>
<summary>Manual equivalent, if you prefer make targets</summary>

```bash
make setup        # uv venv + npm install
make ports        # what is holding 8000 / 5173
make up-native    # start both as host processes
make smoke
make down-native
```

Host ports come from `.env` (`SIGNALING_PORT`, `STATIC_PORT`) — read by both make and compose.
</details>

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
