# Screenshare Demo

## Running the Application

```bash
docker compose up -d --wait
```

Both services will start:
- **Signaling Server** (Python/FastAPI): Port 8000
- **Widget Server** (Node.js): Port 5173

## Accessing the Demo from Inside Docker

The demo is fully functional within the Docker network. To test it:

```bash
# Access demo page
docker compose exec static node -e "fetch('http://localhost:5173/demo/?room=demo&mode=host').then(r => r.text()).then(console.log)"

# Or use curl from within the network
docker run --rm --network screenshare_default alpine/curl curl http://screenshare-static-1:5173/demo/?room=demo&mode=host
```

## Demo URLs

Once in a browser connected to the containers:

- **Host (sharing)**: `http://screenshare-static-1:5173/demo/?room=demo&mode=host`
- **Viewer**: `http://screenshare-static-1:5173/demo/?room=demo&mode=viewer`

The `signaling` query parameter defaults to `http://{hostname}:8000` where hostname is the machine's address.

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
