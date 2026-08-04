from fastapi.testclient import TestClient

from api.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_sum_ok():
    r = client.post("/sum", json={"values": [1, 2, 3.5]})
    assert r.status_code == 200
    assert r.json() == {"total": 6.5, "count": 3}


def test_sum_rejects_empty():
    r = client.post("/sum", json={"values": []})
    assert r.status_code == 422
