"""The Windows app's launcher and the backend's desktop mode.

The GUI pieces (pywebview, pystray) only run on a desktop; everything they
depend on — the per-install secret, the built-in account, the session handed
to the window, the single-instance handshake and the refusal to sign anyone
else up — is exercised here directly.
"""

from __future__ import annotations

import json
import os
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from fear import desktop
from fear.auth import Security, UserStore
from fear.config import Settings
from fear.web.app import app, get_rate_limiter, get_security, get_settings, get_user_store
from fear.web.ratelimit import RateLimiter


def test_secret_is_created_once_and_reused(tmp_path: Path) -> None:
    path = tmp_path / "secret.key"
    first = desktop.load_or_create_secret(path)
    assert len(first) >= 48
    assert desktop.load_or_create_secret(path) == first  # stable: stored keys stay readable


def test_local_email_uses_a_sanitized_windows_username(monkeypatch) -> None:
    monkeypatch.setenv("USERNAME", "Lucas Silva!")
    assert desktop.local_email() == "lucassilva@fear.local"
    monkeypatch.setenv("USERNAME", "***")
    assert desktop.local_email() == "voce@fear.local"


def test_data_dir_lives_in_local_app_data(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path))
    assert desktop.data_dir() == tmp_path / "FEAR"
    assert (tmp_path / "FEAR").is_dir()


@pytest.fixture
def desktop_client(tmp_path: Path) -> Iterator[tuple[TestClient, UserStore, Security]]:
    security = Security("desktop-secret")
    store = UserStore(path=str(tmp_path / "users.db"), security=security)
    app.dependency_overrides[get_user_store] = lambda: store
    app.dependency_overrides[get_security] = lambda: security
    app.dependency_overrides[get_rate_limiter] = RateLimiter
    app.dependency_overrides[get_settings] = lambda: Settings(desktop=True)
    try:
        yield TestClient(app), store, security
    finally:
        app.dependency_overrides.clear()
        store.close()


def test_the_launch_session_opens_the_app_without_a_login(desktop_client) -> None:
    client, store, security = desktop_client
    token = desktop.ensure_local_session(store, security)

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})

    assert me.status_code == 200
    assert me.json()["email"].endswith("@fear.local")


def test_every_launch_reuses_the_same_account(desktop_client) -> None:
    client, store, security = desktop_client
    first = desktop.ensure_local_session(store, security)
    second = desktop.ensure_local_session(store, security)

    ids = {
        client.get("/auth/me", headers={"Authorization": f"Bearer {t}"}).json()["id"]
        for t in (first, second)
    }
    assert len(ids) == 1  # same memory and key, launch after launch


def test_desktop_mode_refuses_sign_up_and_login(desktop_client) -> None:
    # Any program on the PC can reach the local API; it must not be able to
    # mint its own account there.
    client, _, _ = desktop_client
    body = {"email": "intruder@example.com", "password": "longenough"}
    assert client.post("/auth/register", json=body).status_code == 403
    assert client.post("/auth/login", json=body).status_code == 403


def test_pick_port_falls_back_when_the_preferred_one_is_taken() -> None:
    import socket

    with socket.socket() as busy:
        busy.bind(("127.0.0.1", 0))
        busy.listen()
        taken = busy.getsockname()[1]
        port = desktop.pick_port(taken)
    assert port != taken and port > 0


def test_show_route_requires_the_instance_key() -> None:
    shown: list[bool] = []
    application = FastAPI()
    desktop.add_show_route(application, "the-key", lambda: shown.append(True))
    client = TestClient(application)

    assert client.post("/desktop/show").status_code == 403
    assert (
        client.post("/desktop/show", headers={desktop.INSTANCE_HEADER: "nope"}).status_code == 403
    )
    assert shown == []
    response = client.post("/desktop/show", headers={desktop.INSTANCE_HEADER: "the-key"})
    assert response.status_code == 200 and shown == [True]


def test_a_second_launch_wakes_the_running_instance(tmp_path: Path) -> None:
    import uvicorn

    shown = threading.Event()
    application = FastAPI()
    desktop.add_show_route(application, "k", shown.set)
    port = desktop.pick_port(0)
    server = uvicorn.Server(
        uvicorn.Config(application, host="127.0.0.1", port=port, log_config=None)
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = time.monotonic() + 10
        while not server.started and time.monotonic() < deadline:
            time.sleep(0.05)
        instance = tmp_path / "instance.json"
        instance.write_text(json.dumps({"port": port, "key": "k"}), encoding="utf-8")

        assert desktop.wake_running_instance(instance) is True
        assert shown.is_set()
    finally:
        server.should_exit = True
        thread.join(timeout=5)


def test_no_running_instance_means_start_normally(tmp_path: Path) -> None:
    assert desktop.wake_running_instance(tmp_path / "missing.json") is False
    stale = tmp_path / "instance.json"
    stale.write_text(json.dumps({"port": desktop.pick_port(0), "key": "k"}), encoding="utf-8")
    assert desktop.wake_running_instance(stale, timeout=0.5) is False


def test_prepare_environment_points_the_backend_at_the_install(monkeypatch, tmp_path: Path) -> None:
    for name in ("FEAR_DESKTOP", "FEAR_SECRET_KEY", "FEAR_PERSONA_FILE", "FEAR_ONNX_MODEL_DIR"):
        monkeypatch.delenv(name, raising=False)
    resources = tmp_path / "bundle"
    (resources / "onnx_models" / "all-MiniLM-L6-v2").mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    (home / ".env").write_text("FEAR_ENABLE_CLAP_DETECTOR=1\n", encoding="utf-8")
    monkeypatch.delenv("FEAR_ENABLE_CLAP_DETECTOR", raising=False)
    cwd = os.getcwd()
    saved = dict(os.environ)  # prepare_environment writes os.environ directly
    try:
        desktop.prepare_environment(home, resources)
        assert Path.cwd() == home  # data/chroma and data/users.db land in the install
        assert os.environ["FEAR_DESKTOP"] == "1"
        assert os.environ["FEAR_SECRET_KEY"] == (home / "secret.key").read_text(encoding="utf-8")
        assert os.environ["FEAR_ENABLE_CLAP_DETECTOR"] == "1"  # the person's own .env
        assert os.environ["FEAR_ONNX_MODEL_DIR"].endswith("all-MiniLM-L6-v2")
        assert Settings().desktop is True
    finally:
        os.chdir(cwd)
        os.environ.clear()
        os.environ.update(saved)


def test_a_copied_env_example_keeps_what_the_app_ships(monkeypatch, tmp_path: Path) -> None:
    # The README points to .env.example for advanced options. Copied whole into
    # the app's folder, its blanks (FEAR_SECRET_KEY=) and repo-relative paths
    # must not cost anyone their saved key, the persona or the voice.
    for name in (
        "FEAR_DESKTOP",
        "FEAR_ENV",
        "FEAR_SECRET_KEY",
        "FEAR_PERSONA_FILE",
        "FEAR_ONNX_MODEL_DIR",
        "FEAR_STT_MODEL",
        "FEAR_PIPER_VOICE",
        "FEAR_PRELOAD_VOICE",
    ):
        monkeypatch.delenv(name, raising=False)
    resources = tmp_path / "bundle"
    (resources / "prompts").mkdir(parents=True)
    (resources / "prompts" / "fear_persona.md").write_text("F.E.A.R.", encoding="utf-8")
    (resources / "voice" / "whisper-small").mkdir(parents=True)
    home = tmp_path / "home"
    home.mkdir()
    example = Path(__file__).resolve().parents[1] / ".env.example"
    (home / ".env").write_text(example.read_text(encoding="utf-8"), encoding="utf-8")
    cwd = os.getcwd()
    saved = dict(os.environ)
    try:
        desktop.prepare_environment(home, resources)
        assert os.environ["FEAR_SECRET_KEY"] == (home / "secret.key").read_text(encoding="utf-8")
        assert os.environ["FEAR_PERSONA_FILE"] == str(resources / "prompts" / "fear_persona.md")
        assert os.environ["FEAR_STT_MODEL"] == str(resources / "voice" / "whisper-small")
        assert os.environ["FEAR_PIPER_VOICE"] == str(
            resources / "voice" / "piper" / desktop.PIPER_VOICE_FILE
        )
        assert os.environ["FEAR_PRELOAD_VOICE"] == "1"
        assert Settings().desktop is True
    finally:
        os.chdir(cwd)
        os.environ.clear()
        os.environ.update(saved)


def test_a_persona_of_their_own_is_kept(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / "home"
    home.mkdir()
    (home / "minha_persona.md").write_text("outra", encoding="utf-8")
    (home / ".env").write_text("FEAR_PERSONA_FILE=minha_persona.md\n", encoding="utf-8")
    monkeypatch.delenv("FEAR_PERSONA_FILE", raising=False)
    cwd = os.getcwd()
    saved = dict(os.environ)
    try:
        desktop.prepare_environment(home, tmp_path / "bundle")
        assert os.environ["FEAR_PERSONA_FILE"] == "minha_persona.md"  # in the app's folder
    finally:
        os.chdir(cwd)
        os.environ.clear()
        os.environ.update(saved)


def test_webview2_lets_speech_play_and_keeps_flags_already_set() -> None:
    assert desktop.webview2_flags("").split() == [
        "--autoplay-policy=no-user-gesture-required",
        "--disable-features=ElasticOverscroll",  # pywebview's own, which the variable replaces
    ]
    # A test run's switches stay, and a policy or feature list set on purpose wins.
    assert desktop.webview2_flags(
        "--remote-debugging-port=9223 --autoplay-policy=document-user-activation-required"
    ).split() == [
        "--remote-debugging-port=9223",
        "--autoplay-policy=document-user-activation-required",
        "--disable-features=ElasticOverscroll",
    ]


def test_autostart_command_starts_minimized() -> None:
    from fear.desktop_prefs import autostart_command

    assert autostart_command().endswith("--minimized")


def test_ui_files_are_served_with_their_real_types(monkeypatch, tmp_path: Path) -> None:
    # Python's mimetypes also reads the Windows registry, where a stray entry can
    # map .js to text/plain; the browser then refuses the gestures' WASM runtime.
    import mimetypes

    mimetypes.init()
    monkeypatch.setitem(mimetypes.types_map, ".js", "text/plain")
    monkeypatch.setitem(mimetypes.types_map, ".wasm", "text/plain")
    ui = tmp_path / "ui"
    (ui / "mediapipe" / "wasm").mkdir(parents=True)
    (ui / "index.html").write_text("<html></html>", encoding="utf-8")
    (ui / "mediapipe" / "wasm" / "runtime.js").write_text("void 0;", encoding="utf-8")
    (ui / "mediapipe" / "wasm" / "runtime.wasm").write_bytes(b"\x00asm\x01\x00\x00\x00")
    application = FastAPI()
    desktop.mount_ui(application, tmp_path)
    client = TestClient(application)

    wasm = client.get("/mediapipe/wasm/runtime.wasm")
    script = client.get("/mediapipe/wasm/runtime.js")

    assert wasm.headers["content-type"] == "application/wasm"
    assert script.headers["content-type"].startswith("text/javascript")
    assert client.get("/").status_code == 200


def test_the_folder_picker_returns_the_choice_or_nothing() -> None:
    class FakeWindow:
        def __init__(self, result):
            self.result = result

        def create_file_dialog(self, dialog_type):
            return self.result

    pytest.importorskip("webview")
    bridge = desktop.DesktopBridge()
    assert bridge.pick_folder() == ""  # no window yet
    bridge._window = FakeWindow(["C:/Users/lucas/Obsidian"])
    assert bridge.pick_folder() == "C:/Users/lucas/Obsidian"
    bridge._window = FakeWindow(None)  # cancelled
    assert bridge.pick_folder() == ""
