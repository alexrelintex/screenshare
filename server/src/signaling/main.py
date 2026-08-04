"""WebSocket signaling for 1:1 WebRTC screen sharing.

The server relays three message types between the two peers in a room —
`offer`, `answer`, `ice` — and announces join/leave. Media never touches it:
once the peer connection is established, video and cursor data flow directly
between browsers. That is the entire point of the P2P topology.

Scope limits, stated rather than implied:
  * One process, in-memory rooms. No horizontal scale without shared state.
  * No authentication. Anyone who knows a room id can join it. See README.
  * No TURN. Peers behind symmetric NAT will fail to connect; STUN only.
"""

from __future__ import annotations

import contextlib
import json
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from .rooms import RoomFull, RoomRegistry

# Only these are forwarded. Anything else is rejected rather than relayed,
# so the room cannot be used as a general-purpose message bus.
RELAY_TYPES = frozenset({"offer", "answer", "ice"})

MAX_FRAME_BYTES = 64 * 1024  # SDP is a few KB; this is generous and bounds abuse.

app = FastAPI(title="screenshare-signaling", version="0.1.0")

# The widget is embedded on third-party pages by design, so the signaling
# endpoint must be reachable cross-origin. Narrow this in your deployment.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET"],
    allow_headers=["*"],
)

registry = RoomRegistry()
_sockets: dict[str, WebSocket] = {}


@app.get("/healthz")
def healthz() -> dict[str, Any]:
    return {"status": "ok", "rooms": len(registry)}


async def _send(peer_id: str, payload: dict[str, Any]) -> None:
    sock = _sockets.get(peer_id)
    if sock is None:
        return
    # Peer may vanish mid-send; the disconnect handler does the cleanup.
    with contextlib.suppress(RuntimeError, WebSocketDisconnect):
        await sock.send_text(json.dumps(payload))


@app.websocket("/ws/{room_id}")
async def signaling(websocket: WebSocket, room_id: str) -> None:
    await websocket.accept()
    peer_id = uuid.uuid4().hex

    try:
        others = registry.join(room_id, peer_id)
    except RoomFull:
        await websocket.send_text(json.dumps({"type": "error", "code": "room-full"}))
        await websocket.close(code=1008)
        return

    _sockets[peer_id] = websocket
    await _send(peer_id, {"type": "welcome", "peerId": peer_id, "peers": others})
    for other in others:
        await _send(other, {"type": "peer-joined", "peerId": peer_id})

    try:
        while True:
            raw = await websocket.receive_text()
            if len(raw) > MAX_FRAME_BYTES:
                await _send(peer_id, {"type": "error", "code": "frame-too-large"})
                continue
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                await _send(peer_id, {"type": "error", "code": "bad-json"})
                continue
            if not isinstance(msg, dict) or msg.get("type") not in RELAY_TYPES:
                await _send(peer_id, {"type": "error", "code": "unsupported-type"})
                continue

            msg["from"] = peer_id
            for other in registry.peers(room_id):
                if other != peer_id:
                    await _send(other, msg)
    except WebSocketDisconnect:
        pass
    finally:
        _sockets.pop(peer_id, None)
        for other in registry.leave(room_id, peer_id):
            await _send(other, {"type": "peer-left", "peerId": peer_id})
