# Screenshare Demo

## Running the Application

```bash
docker compose up -d --wait
```

Both services will start:
- **Signaling Server** (Python/FastAPI): Port 8000
- **Widget Server** (Node.js): Port 5173

## Demo URLs

Open these in your browser on the host machine — both ports are published, so
no container-network gymnastics are needed:

- **Host (sharing)**: `http://127.0.0.1:5173/demo/index.html?room=demo&mode=host`
- **Viewer**: `http://127.0.0.1:5173/demo/index.html?room=demo&mode=viewer`

Open the viewer in a second tab or another device on your network. The page
mints a fresh room id when `room` is omitted, so two visitors do not collide.

The `signaling` query parameter defaults to `http://127.0.0.1:8000`; pass it
explicitly if you changed `SIGNALING_PORT`.

> Earlier revisions told you to reach the demo from *inside* the Docker network.
> That was a workaround for `serve.mjs` binding loopback inside the container,
> which made the published port accept nothing. It binds `0.0.0.0` in the image
> now (`HOST` env var, still loopback outside a container).

## Features Demonstrated

1. One-to-one WebRTC peer connection
2. Screen sharing with remote cursor tracking
3. P2P media streaming (server only relays signaling)
4. Real-time cursor synchronization with 30 Hz throttling
5. Room-based connection management

## How It Works

- **Signaling**: FastAPI WebSocket relay at `/ws/{room_id}`
- **Media**: Direct peer-to-peer (P2P) — no server involvement
- **Cursor**: Transmitted over data channel, normalized 0..1
- **Connection**: STUN-only (Google public STUN server); no TURN relay

## Limitations

- No TURN support (fails behind symmetric NAT/strict firewalls)
- Single-process, in-memory rooms (no horizontal scale)
- No authentication
- Max 2 peers per room (1:1 only)
- Requires HTTPS or localhost for `getDisplayMedia` API
