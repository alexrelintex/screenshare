import pytest

from signaling.rooms import MAX_PEERS, RoomFull, RoomRegistry


def test_first_peer_sees_empty_room():
    r = RoomRegistry()
    assert r.join("a", "p1") == []
    assert r.peers("a") == ["p1"]


def test_second_peer_sees_the_first():
    r = RoomRegistry()
    r.join("a", "p1")
    assert r.join("a", "p2") == ["p1"]


def test_third_peer_is_rejected():
    r = RoomRegistry()
    r.join("a", "p1")
    r.join("a", "p2")
    with pytest.raises(RoomFull) as exc:
        r.join("a", "p3")
    assert exc.value.room_id == "a"
    assert r.peers("a") == ["p1", "p2"], "rejected peer must not be added"


def test_duplicate_peer_id_is_an_error():
    r = RoomRegistry()
    r.join("a", "p1")
    with pytest.raises(ValueError):
        r.join("a", "p1")


def test_leave_returns_remaining_and_is_idempotent():
    r = RoomRegistry()
    r.join("a", "p1")
    r.join("a", "p2")
    assert r.leave("a", "p1") == ["p2"]
    assert r.leave("a", "p1") == ["p2"], "leaving twice must not raise or double-remove"


def test_empty_room_is_reclaimed():
    r = RoomRegistry()
    r.join("a", "p1")
    r.leave("a", "p1")
    assert r.room_ids() == [], "rooms must not leak once the last peer leaves"
    assert len(r) == 0


def test_rooms_are_isolated():
    r = RoomRegistry()
    r.join("a", "p1")
    r.join("b", "p2")
    assert r.peers("a") == ["p1"]
    assert r.peers("b") == ["p2"]


def test_capacity_is_two():
    assert MAX_PEERS == 2, "the widget's offer/answer logic assumes exactly two peers"


def test_rejected_join_does_not_create_a_room():
    """A RoomFull on an untouched room id must not leave an empty room behind."""
    r = RoomRegistry()
    r.join("a", "p1")
    r.join("a", "p2")
    before = set(r.room_ids())
    with pytest.raises(RoomFull):
        r.join("a", "p3")
    assert set(r.room_ids()) == before


def test_leave_unknown_room_is_safe():
    r = RoomRegistry()
    assert r.leave("nope", "p1") == []
