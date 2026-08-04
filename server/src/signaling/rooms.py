"""Room bookkeeping for 1:1 screen sharing.

Deliberately transport-agnostic — no FastAPI, no WebSocket, no I/O. That keeps
the only stateful part of the server unit-testable without spinning anything up,
and makes it obvious that the server is a dumb relay: it tracks who is in a room
and forwards bytes. It never inspects SDP or ICE candidates.
"""

from __future__ import annotations

MAX_PEERS = 2


class RoomFull(Exception):
    """A third peer tried to join a room that already holds MAX_PEERS."""

    def __init__(self, room_id: str) -> None:
        super().__init__(f"room {room_id!r} already has {MAX_PEERS} peers")
        self.room_id = room_id


class RoomRegistry:
    """In-memory room -> peer-id mapping.

    Single-process only. Two server replicas would not see each other's rooms;
    swapping this for Redis pub/sub is the documented path to horizontal scale.
    """

    def __init__(self) -> None:
        self._rooms: dict[str, list[str]] = {}

    def join(self, room_id: str, peer_id: str) -> list[str]:
        """Add `peer_id` to `room_id`. Returns the peers that were already there.

        Raises RoomFull if the room is at capacity, ValueError on a duplicate id.
        """
        peers = self._rooms.setdefault(room_id, [])
        if peer_id in peers:
            raise ValueError(f"peer {peer_id!r} is already in room {room_id!r}")
        if len(peers) >= MAX_PEERS:
            # Do not leave an empty room behind if this was the first touch.
            if not peers:
                del self._rooms[room_id]
            raise RoomFull(room_id)
        others = list(peers)
        peers.append(peer_id)
        return others

    def leave(self, room_id: str, peer_id: str) -> list[str]:
        """Remove `peer_id`. Returns the peers remaining. Idempotent."""
        peers = self._rooms.get(room_id)
        if not peers or peer_id not in peers:
            return list(peers or [])
        peers.remove(peer_id)
        if not peers:
            del self._rooms[room_id]
            return []
        return list(peers)

    def peers(self, room_id: str) -> list[str]:
        return list(self._rooms.get(room_id, []))

    def room_ids(self) -> list[str]:
        return list(self._rooms)

    def __len__(self) -> int:
        return len(self._rooms)
