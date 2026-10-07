"""The /browser test page and /ws/browser are off unless asked for.

They run a full voice session with no account and no token, on our provider
keys, so in production they have to not exist at all -- not merely be hard to
find.
"""
import os
import sys

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def make_client(monkeypatch):
    import server  # imported first: bot.py's load_dotenv(override=True) runs here

    def build(flag: str | None) -> TestClient:
        if flag is None:
            monkeypatch.delenv("ENABLE_BROWSER_TEST", raising=False)
        else:
            monkeypatch.setenv("ENABLE_BROWSER_TEST", flag)
        return TestClient(server.create_app())

    return build


@pytest.mark.parametrize("flag", [None, "", "false", "0", "no"])
def test_off_by_default(make_client, flag):
    client = make_client(flag)
    assert client.get("/browser").status_code == 404
    assert client.get("/", follow_redirects=False).status_code == 404
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/browser"):
            pass
    # Turning the test page off must not take the health check with it.
    assert client.get("/healthz").json() == {"ok": True}


@pytest.mark.parametrize("flag", ["true", "1", "yes", "TRUE"])
def test_on_when_asked_for(make_client, flag):
    client = make_client(flag)
    assert client.get("/browser").status_code == 200
    root = client.get("/", follow_redirects=False)
    assert root.status_code == 307 and root.headers["location"] == "/browser"
    assert any(getattr(r, "path", None) == "/ws/browser" for r in client.app.routes)
