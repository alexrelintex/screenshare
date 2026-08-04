"""End-to-end tests of the WebSocket relay via Starlette's TestClient."""

import json

import pytest
from fastapi.testclient import TestClient

from signaling.main import app, registry


@pytest.fixture(autouse=True)
def _clean_registry():
    """Rooms are module-level state; reset between tests."""
    for room in list(registry.room_ids()):
        for peer in registry.peers(room):
            registry.leave(room, peer)
    yield


def test_health():
    with TestClient(app) as c:
        r = c.get("/healthz")
        assert r.status_code == 200
        assert r.json()["status"] == "ok"


def test_first_peer_welcomed_with_empty_room():
    with TestClient(app) as c, c.websocket_connect("/ws/r1") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "welcome"
        assert msg["peers"] == []


def test_second_peer_sees_first_and_first_is_notified():
    with TestClient(app) as c, c.websocket_connect("/ws/r2") as a:
        wa = a.receive_json()
        with c.websocket_connect("/ws/r2") as b:
            wb = b.receive_json()
            assert wb["type"] == "welcome"
            assert wb["peers"] == [wa["peerId"]]

            joined = a.receive_json()
            assert joined == {"type": "peer-joined", "peerId": wb["peerId"]}


def test_offer_is_relayed_verbatim_with_sender_attached():
    with TestClient(app) as c, c.websocket_connect("/ws/r3") as a:
        wa = a.receive_json()
        with c.websocket_connect("/ws/r3") as b:
            b.receive_json()
            a.receive_json()  # peer-joined

            a.send_text(json.dumps({"type": "offer", "sdp": "v=0\r\nfake"}))
            got = b.receive_json()
            assert got["type"] == "offer"
            assert got["sdp"] == "v=0\r\nfake", "SDP must not be rewritten"
            assert got["from"] == wa["peerId"]


def test_sender_does_not_receive_its_own_relay():
    with TestClient(app) as c, c.websocket_connect("/ws/r4") as a:
        a.receive_json()
        with c.websocket_connect("/ws/r4") as b:
            b.receive_json()
            a.receive_json()

            a.send_text(json.dumps({"type": "ice", "candidate": "x"}))
            assert b.receive_json()["type"] == "ice"
            # If the server echoed, the next thing A reads would be its own ice.
            a.send_text(json.dumps({"type": "ice", "candidate": "y"}))
            assert b.receive_json()["candidate"] == "y"


def test_third_peer_gets_room_full_and_is_closed():
    with TestClient(app) as c, c.websocket_connect("/ws/r5") as a:
        a.receive_json()
        with c.websocket_connect("/ws/r5") as b:
            b.receive_json()
            a.receive_json()
            with c.websocket_connect("/ws/r5") as third:
                assert third.receive_json() == {"type": "error", "code": "room-full"}


def test_peer_left_is_announced():
    with TestClient(app) as c, c.websocket_connect("/ws/r6") as a:
        a.receive_json()
        with c.websocket_connect("/ws/r6") as b:
            wb = b.receive_json()
            a.receive_json()
        left = a.receive_json()
        assert left == {"type": "peer-left", "peerId": wb["peerId"]}


def test_unsupported_type_is_rejected_not_relayed():
    with TestClient(app) as c, c.websocket_connect("/ws/r7") as a:
        a.receive_json()
        with c.websocket_connect("/ws/r7") as b:
            b.receive_json()
            a.receive_json()

            a.send_text(json.dumps({"type": "chat", "body": "hello"}))
            assert a.receive_json() == {"type": "error", "code": "unsupported-type"}

            # Prove B got nothing by sending a real relay and seeing it first.
            a.send_text(json.dumps({"type": "ice", "candidate": "z"}))
            nxt = b.receive_json()
            assert nxt["type"] == "ice", f"chat leaked to peer: {nxt}"


def test_malformed_json_is_rejected():
    with TestClient(app) as c, c.websocket_connect("/ws/r8") as a:
        a.receive_json()
        a.send_text("{not json")
        assert a.receive_json() == {"type": "error", "code": "bad-json"}


def test_oversized_frame_is_rejected():
    with TestClient(app) as c, c.websocket_connect("/ws/r9") as a:
        a.receive_json()
        a.send_text(json.dumps({"type": "offer", "sdp": "x" * 70_000}))
        assert a.receive_json() == {"type": "error", "code": "frame-too-large"}


def test_room_is_reclaimed_after_both_leave():
    with TestClient(app) as c:
        with c.websocket_connect("/ws/r10") as a:
            a.receive_json()
        assert "r10" not in registry.room_ids()
