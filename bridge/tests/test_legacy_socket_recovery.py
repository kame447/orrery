"""Recorder recovery for a replaced legacy default tmux server."""
import asyncio
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import sys
import tempfile

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from runtime_target import LegacyTargetBoundary, TargetRefused
from orrery_backend import SessionBridgeManager


@pytest.fixture
def default_server(monkeypatch):
    tmux = shutil.which("tmux")
    if not tmux:
        pytest.skip("tmux unavailable")
    base = "/private/tmp" if Path("/private/tmp").is_dir() else tempfile.gettempdir()
    with tempfile.TemporaryDirectory(prefix="orrc-", dir=base) as temp:
        root = Path(temp)
        home = root / "home"
        home.mkdir(mode=0o700)
        tempdir = root / "sockets"
        socket_dir = tempdir / f"tmux-{os.getuid()}"
        socket_dir.mkdir(parents=True, mode=0o700)
        socket = socket_dir / "default"
        for key in list(os.environ):
            if key.startswith(("AGENTSTACK_", "MCP_AGENT_")) or key in (
                "TMUX", "TMUX_PANE", "AGENT_NAME", "PARENT_AGENT",
                "CHILD_REGISTRATION_TOKEN",
            ):
                monkeypatch.delenv(key, raising=False)
        monkeypatch.setenv("HOME", str(home))
        monkeypatch.setenv("AGENTSTACK_HOME", str(home))
        monkeypatch.setenv("TMUX_TMPDIR", str(tempdir))
        env = dict(os.environ)
        root_value = os.environ.get("ORRERY_TEST_TELEMETRY_ROOT")
        if not root_value:
            pytest.fail("ORRERY_TEST_TELEMETRY_ROOT is required")
        library = runpy.run_path(str(Path(root_value) / "tests/_installed_client_payload.py"))
        library["copy_client_library"](home)
        command = [tmux, "-S", str(socket)]

        def run(*args, check=True):
            result = subprocess.run([*command, *args], env=env, capture_output=True,
                                    text=True, check=False, timeout=8)
            if check and result.returncode:
                raise RuntimeError(f"tmux {args}: {result.stderr.strip() or result.stdout.strip()}")
            return result

        run("new-session", "-d", "-s", "before", "sleep", "300")
        try:
            yield tmux, home, env, socket, run
        finally:
            run("kill-server", check=False)


def test_replaced_socket_is_not_retried_inside_a_refused_admission(default_server):
    binary, home, env, socket, run = default_server
    boundary = LegacyTargetBoundary(binary, home=home, environ=env)
    before = boundary.transport.identity
    assert boundary.admit("capture", session="before")["allowed"]
    run("kill-server")
    run("new-session", "-d", "-s", "after", "sleep", "300")
    assert boundary.socket_replaced()
    with pytest.raises(TargetRefused, match="^TMUX_SOCKET_CHANGED$"):
        boundary.admit("capture", session="after")
    assert boundary.transport.identity == before
    assert boundary.rebind_server()
    assert boundary.transport.identity != before
    assert boundary.admit("capture", session="after")["allowed"]


def test_recorder_rebuilds_bridges_and_preserves_new_session(default_server):
    binary, home, env, socket, run = default_server
    boundary = LegacyTargetBoundary(binary, home=home, environ=env)
    async def scenario():
        manager = SessionBridgeManager(boundary, history_dir=home/"history")
        try:
            await manager._reconcile_sessions()
            assert set(manager.states) == {"before"}
            old = manager.states["before"].bridge
            old_pid = boundary.pin["server_pid"]
            run("kill-server")
            await asyncio.sleep(0.5)
            run("new-session", "-d", "-s", "after", "sleep", "300")
            assert old_pid != int(run("display-message", "-p", "#{pid}").stdout.strip())
            await manager._reconcile_sessions()
            assert set(manager.states) == {"after"}
            assert old._closed
            assert boundary.admit("capture", session="after")["allowed"]
            assert not boundary.socket_replaced()
            await manager._reconcile_sessions()
            assert set(manager.states) == {"after"}
            former = manager.states["after"].bridge
            run("kill-server")
            await asyncio.sleep(0.5)
            run("new-session", "-d", "-s", "again", "sleep", "300")
            await manager._reconcile_sessions()
            assert set(manager.states) == {"again"}
            assert former._closed
            assert boundary.admit("capture", session="again")["allowed"]
        finally:
            await manager.close()
    asyncio.run(scenario())


def test_old_websocket_cannot_inherit_reused_pane_on_server_rollover(default_server):
    binary, home, env, socket, run = default_server
    boundary = LegacyTargetBoundary(binary, home=home, environ=env)

    class Peer:
        def __init__(self):
            self.response = self
            self.closed = False
            self.messages = []

        async def send(self, data):
            return None

        async def send_json(self, payload):
            self.messages.append(payload)

        async def close(self, *, code, message):
            assert code == 1012
            self.closed = True

    async def scenario():
        manager = SessionBridgeManager(boundary, history_dir=home / "history")
        try:
            await manager._reconcile_sessions()
            old = manager.states["before"]
            peer = Peer()
            attached = set()
            await manager.attach(peer, attached, "before")
            assert manager._legacy_peer_epoch[peer] == 0
            run("kill-server")
            await asyncio.sleep(0.5)
            # Reuse the session name and numeric pane ID on the replacement.
            run("new-session", "-d", "-s", "before", "sleep", "300")
            await manager._reconcile_sessions()
            current = manager.states["before"]
            assert current is not old and old.bridge._closed
            assert peer.closed
            assert manager._legacy_peer_epoch[peer] != manager._legacy_epoch
            # The numeric pane ID may be identical, but old peers may not
            # write to the new session without a fresh attachment.
            await manager.handle_message(peer, attached,
                {"type": "input", "paneId": next(iter(current.bridge.panes)), "data": "stale"})
            assert peer.messages[-1]["type"] == "error"
            assert "reattach" in peer.messages[-1]["message"]
        finally:
            await manager.close()

    asyncio.run(scenario())


def test_untrusted_replacement_socket_is_not_adopted(default_server):
    binary, home, env, socket, run = default_server
    boundary = LegacyTargetBoundary(binary, home=home, environ=env)
    original = boundary.transport.identity
    run("kill-server")
    # The socket path is owned by the test, but a symlink/file is never
    # a legitimate replacement tmux server even under that directory.
    if socket.exists():
        socket.unlink()
    socket.symlink_to(home)
    assert not socket.is_socket()
    with pytest.raises(TargetRefused, match="^TMUX_SOCKET_UNSAFE$"):
        boundary.socket_replaced()
    assert boundary.transport.identity == original
    assert boundary.pin["server_pid"] is not None


def test_inherited_tmux_pin_is_not_silently_replaced(default_server):
    binary, home, env, socket, run = default_server
    pid = run("display-message", "-p", "#{pid}").stdout.strip()
    inherited = {**env, "TMUX": f"{socket},{pid},0"}
    boundary = LegacyTargetBoundary(binary, home=home, environ=inherited)
    run("kill-server")
    run("new-session", "-d", "-s", "after", "sleep", "300")
    assert not boundary.socket_replaced()
    with pytest.raises(TargetRefused, match="^TMUX_SOCKET_CHANGED$"):
        boundary.rebind_server()
    with pytest.raises(TargetRefused):
        boundary.admit("capture", session="after")


def test_recovery_errors_are_rate_limited(capsys):
    manager = SessionBridgeManager("tmux")
    for _ in range(1000):
        manager._log_attach_error("same", TargetRefused("TMUX_SOCKET_CHANGED"))
    assert capsys.readouterr().err.count("TMUX_SOCKET_CHANGED") == 1
