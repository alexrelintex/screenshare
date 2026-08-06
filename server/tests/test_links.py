"""Room ids, link assembly, and the POST /rooms endpoint."""

from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse

import pytest
from fastapi.testclient import TestClient

from signaling.links import embed_snippet, new_room_id, page_url
from signaling.main import app

APP = "https://example.github.io/screenshare"
SIG = "https://sig.example.com"


class TestRoomId:
    def test_is_url_safe_and_long_enough_to_be_unguessable(self) -> None:
        room = new_room_id()
        assert re.fullmatch(r"[A-Za-z0-9_-]{12}", room), room

    def test_ids_do_not_repeat(self) -> None:
        # The room id is the only secret protecting a room, so a collision is
        # two strangers in the same call, not merely a duplicate key.
        assert len({new_room_id() for _ in range(2000)}) == 2000


class TestPageUrl:
    def test_builds_an_openable_url(self) -> None:
        url = page_url(APP, "abc123", "viewer", SIG)
        parts = urlparse(url)
        assert parts.path == "/screenshare/demo/index.html"
        q = parse_qs(parts.query)
        assert q["room"] == ["abc123"]
        assert q["mode"] == ["viewer"]
        # Carried in the link so it survives being opened from another deploy.
        assert q["signaling"] == [SIG]

    def test_a_trailing_slash_on_the_base_does_not_double_up(self) -> None:
        assert "//demo" not in page_url(f"{APP}/", "r", "host", SIG)
        assert page_url(f"{APP}/", "r", "host", SIG) == page_url(APP, "r", "host", SIG)

    def test_signaling_is_percent_encoded(self) -> None:
        # Unencoded, the :// and any query in the signaling URL would be read as
        # part of the page's own query string.
        url = page_url(APP, "r", "host", "https://sig.example.com:8443")
        assert "https%3A%2F%2Fsig.example.com%3A8443" in url

    def test_room_ids_needing_encoding_are_encoded(self) -> None:
        url = page_url(APP, "a b&mode=host", "viewer", SIG)
        assert parse_qs(urlparse(url).query)["room"] == ["a b&mode=host"]
        assert parse_qs(urlparse(url).query)["mode"] == ["viewer"]

    def test_rejects_an_unknown_mode(self) -> None:
        with pytest.raises(ValueError, match="mode must be one of"):
            page_url(APP, "r", "spectator", SIG)


class TestEmbedSnippet:
    def test_contains_a_script_tag_and_a_configured_element(self) -> None:
        snippet = embed_snippet(APP, "abc123", "viewer", SIG)
        assert f'<script src="{APP}/dist/screenshare.js" async></script>' in snippet
        assert 'room="abc123"' in snippet
        assert f'signaling="{SIG}"' in snippet
        assert 'mode="viewer"' in snippet

    def test_attribute_values_are_escaped(self) -> None:
        # Generated ids cannot contain a quote; escaping makes that a property
        # of this function rather than a coincidence of the generator.
        snippet = embed_snippet(APP, '" onload="alert(1)', "host", SIG)
        assert 'onload="alert(1)' not in snippet
        assert "&quot;" in snippet

    def test_rejects_an_unknown_mode(self) -> None:
        with pytest.raises(ValueError, match="mode must be one of"):
            embed_snippet(APP, "r", "spectator", SIG)


class TestCreateRoomEndpoint:
    def test_returns_a_matched_pair(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("APP_BASE_URL", APP)
        monkeypatch.setenv("SIGNALING_PUBLIC_URL", SIG)
        with TestClient(app) as client:
            res = client.post("/rooms")
        assert res.status_code == 201
        body = res.json()

        assert body["signaling"] == SIG
        # Both ends must name the same room, or the pair is useless.
        for role in ("host", "viewer"):
            assert body["room"] in body[role]["url"]
            assert body["room"] in body[role]["embed"]
            assert f'mode="{role}"' in body[role]["embed"]
            assert f"mode={role}" in body[role]["url"]

    def test_each_call_is_a_new_room(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("APP_BASE_URL", APP)
        monkeypatch.setenv("SIGNALING_PUBLIC_URL", SIG)
        with TestClient(app) as client:
            rooms = {client.post("/rooms").json()["room"] for _ in range(25)}
        assert len(rooms) == 25

    def test_falls_back_to_the_request_url_when_unconfigured(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.delenv("APP_BASE_URL", raising=False)
        monkeypatch.delenv("SIGNALING_PUBLIC_URL", raising=False)
        with TestClient(app) as client:
            body = client.post("/rooms").json()
        assert body["host"]["url"].startswith("http://testserver/demo/index.html")

    def test_creates_no_room_server_side(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Minting a name must stay free, or an unauthenticated endpoint becomes
        # a way to fill memory with rooms nobody joins.
        monkeypatch.setenv("APP_BASE_URL", APP)
        with TestClient(app) as client:
            before = client.get("/healthz").json()["rooms"]
            for _ in range(10):
                client.post("/rooms")
            assert client.get("/healthz").json()["rooms"] == before

    def test_a_minted_room_reads_as_empty_not_missing(self) -> None:
        # A link that has been sent but not yet opened is the normal case; 404
        # would report it as an error.
        with TestClient(app) as client:
            room = client.post("/rooms").json()["room"]
            res = client.get(f"/rooms/{room}")
        assert res.status_code == 200
        assert res.json() == {
            "room": room,
            "peers": 0,
            "capacity": 2,
            "occupied": False,
            "full": False,
        }

    def test_status_tracks_peers_joining_and_leaving(self) -> None:
        with TestClient(app) as client:
            room = client.post("/rooms").json()["room"]
            with client.websocket_connect(f"/ws/{room}") as first:
                first.receive_json()  # welcome
                body = client.get(f"/rooms/{room}").json()
                assert (body["peers"], body["occupied"], body["full"]) == (1, True, False)

                with client.websocket_connect(f"/ws/{room}") as second:
                    second.receive_json()
                    body = client.get(f"/rooms/{room}").json()
                    assert (body["peers"], body["full"]) == (2, True)

            # Both sockets closed: the room is reclaimed, so it reads empty again.
            assert client.get(f"/rooms/{room}").json()["peers"] == 0

    def test_the_browser_preflight_is_allowed(self) -> None:
        # A CRM calls this cross-origin; without POST in the CORS policy the
        # request dies at the preflight and never reaches the handler.
        with TestClient(app) as client:
            res = client.options(
                "/rooms",
                headers={
                    "Origin": "https://crm.example.com",
                    "Access-Control-Request-Method": "POST",
                },
            )
        assert res.status_code == 200
        assert "POST" in res.headers["access-control-allow-methods"]
