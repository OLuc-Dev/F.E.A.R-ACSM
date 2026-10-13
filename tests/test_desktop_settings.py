"""The Windows app's settings panel: switches that take effect live and persist."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fear.auth import Security, UserStore
from fear.config import Settings
from fear.web import app as app_module
from fear.web.app import app, get_rate_limiter, get_security, get_settings, get_user_store
from fear.web.ratelimit import RateLimiter


class RecordingMemory:
    def __init__(self) -> None:
        self.added: list[tuple[str, str]] = []

    def add_memory(self, text: str, speaker: str, source: str, user_id: str = "") -> str:
        self.added.append((text, user_id))
        return "id"


class FakeDetector:
    is_running = True

    def stop(self) -> None:
        self.is_running = False


@pytest.fixture
def env(tmp_path: Path) -> Iterator[dict]:
    security = Security("desktop-secret")
    store = UserStore(path=str(tmp_path / "users.db"), security=security)
    settings = Settings(
        desktop=True,
        desktop_settings_path=str(tmp_path / "data" / "desktop.json"),
        chroma_path=str(tmp_path / "data" / "chroma"),
    )
    memory = RecordingMemory()
    app.dependency_overrides[get_user_store] = lambda: store
    app.dependency_overrides[get_security] = lambda: security
    app.dependency_overrides[get_rate_limiter] = RateLimiter
    app.dependency_overrides[get_settings] = lambda: settings
    # The live switches start and stop real background services from app.state.
    app.state.settings, app.state.user_store, app.state.memory = settings, store, memory
    owner = store.create_user("lucas@fear.local", "unused-password")
    token = security.make_session_token(f"{owner.id}:{owner.token_version}")
    try:
        yield {
            "client": TestClient(app),
            "headers": {"Authorization": f"Bearer {token}"},
            "settings": settings,
            "memory": memory,
            "owner": owner,
        }
    finally:
        app_module.stop_obsidian_watcher(app)
        app.dependency_overrides.clear()
        for name in ("settings", "user_store", "memory", "obsidian_watcher", "clap_detector"):
            if hasattr(app.state, name):
                delattr(app.state, name)
        store.close()


def _saved(settings: Settings) -> dict:
    return json.loads(Path(settings.desktop_settings_path).read_text(encoding="utf-8"))


def test_the_settings_exist_only_in_the_desktop_app(env) -> None:
    app.dependency_overrides[get_settings] = lambda: Settings(desktop=False)
    assert env["client"].get("/desktop/settings", headers=env["headers"]).status_code == 404


def test_pointing_at_a_vault_indexes_the_notes_already_there(env, tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "ideia.md").write_text("Uma ideia antiga que já estava no vault.", encoding="utf-8")

    body = (
        env["client"]
        .post("/desktop/settings", json={"obsidian_vault": str(vault)}, headers=env["headers"])
        .json()
    )

    assert body["obsidian_watching"] is True and body["obsidian_vault"] == str(vault)
    assert _saved(env["settings"])["obsidian_vault"] == str(vault)
    deadline = time.monotonic() + 5
    while not env["memory"].added and time.monotonic() < deadline:
        time.sleep(0.05)
    assert env["memory"].added == [("Uma ideia antiga que já estava no vault.", env["owner"].id)]

    body = (
        env["client"]
        .post("/desktop/settings", json={"obsidian_vault": ""}, headers=env["headers"])
        .json()
    )
    assert body["obsidian_watching"] is False and body["obsidian_vault"] == ""


def test_a_folder_that_does_not_exist_is_refused(env, tmp_path: Path) -> None:
    response = env["client"].post(
        "/desktop/settings",
        json={"obsidian_vault": str(tmp_path / "nope")},
        headers=env["headers"],
    )
    assert response.status_code == 422
    assert not Path(env["settings"].desktop_settings_path).exists()


def test_claps_switch_on_and_off_live(env, monkeypatch) -> None:
    def fake_start(application) -> bool:
        application.state.clap_detector = FakeDetector()
        return True

    monkeypatch.setattr(app_module, "start_clap_detector", fake_start)
    on = (
        env["client"].post("/desktop/settings", json={"claps": True}, headers=env["headers"]).json()
    )
    assert on["claps"] is True and on["claps_listening"] is True
    assert _saved(env["settings"])["claps"] is True

    off = (
        env["client"]
        .post("/desktop/settings", json={"claps": False}, headers=env["headers"])
        .json()
    )
    assert off["claps"] is False and off["claps_listening"] is False


def test_claps_without_a_microphone_library_are_refused(env, monkeypatch) -> None:
    monkeypatch.setattr(app_module, "start_clap_detector", lambda application: False)
    response = env["client"].post("/desktop/settings", json={"claps": True}, headers=env["headers"])
    assert response.status_code == 422


def test_start_with_windows_toggles_the_run_entry(env, monkeypatch) -> None:
    state = {"on": False}
    monkeypatch.setattr(app_module, "autostart_available", lambda: True)
    monkeypatch.setattr(app_module, "autostart_enabled", lambda: state["on"])
    monkeypatch.setattr(app_module, "set_autostart", lambda on: state.update(on=on))

    body = (
        env["client"]
        .post("/desktop/settings", json={"autostart": True}, headers=env["headers"])
        .json()
    )
    assert state["on"] is True and body["autostart"] is True
