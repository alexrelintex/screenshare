"""Minting room ids and the links/embeds that carry them.

Pure functions, deliberately: URL and HTML assembly is where injection and
malformed-link bugs live, and none of it needs a request or a socket to test.

The base URLs are taken from the environment, never from the caller. A caller
that could name its own base could hand out links that look like yours and
point somewhere else, which is a phishing generator with an API.
"""

from __future__ import annotations

import html
import secrets
from urllib.parse import quote

# 9 bytes -> 12 url-safe characters, ~72 bits. There is no authentication on a
# room: whoever knows the id can join it, so the id is the entire secret and
# must not be guessable. The demo page's Math.random ids are fine for a local
# demo and are not fine for anything handed out by an API.
ROOM_ID_BYTES = 9

MODES = ("host", "viewer")


def new_room_id() -> str:
    """A fresh, unguessable room id."""
    return secrets.token_urlsafe(ROOM_ID_BYTES)


def _base(url: str) -> str:
    """Normalise a base URL so joining never doubles or drops a slash."""
    return url.rstrip("/")


def page_url(app_base: str, room: str, mode: str, signaling_base: str) -> str:
    """A ready-to-open demo page URL.

    `signaling` is carried in the query string so the link works regardless of
    what the hosting page was built with — a link that depends on the page's
    own configuration breaks the moment it is opened from a different deploy.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
    query = (
        f"room={quote(room, safe='')}&mode={mode}&signaling={quote(_base(signaling_base), safe='')}"
    )
    return f"{_base(app_base)}/demo/index.html?{query}"


def embed_snippet(app_base: str, room: str, mode: str, signaling_base: str) -> str:
    """A copy-paste block for a CRM or any other host page.

    Attribute values are HTML-escaped. Generated room ids are url-safe and
    cannot contain a quote, but the escaping is what makes that a property of
    this function rather than a coincidence of the generator.
    """
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}, got {mode!r}")
    src = html.escape(f"{_base(app_base)}/dist/screenshare.js", quote=True)
    return (
        f'<script src="{src}" async></script>\n'
        f'<screen-share room="{html.escape(room, quote=True)}"'
        f' signaling="{html.escape(_base(signaling_base), quote=True)}"'
        f' mode="{mode}"></screen-share>'
    )
