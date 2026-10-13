"""The F.E.A.R. Windows app: one process that runs the backend and its own window.

Each install is a private, single-person F.E.A.R. The launcher creates the one
local account itself and hands the window a fresh session on every start, so
there is never a login. Closing the window only hides it to the tray (the mic
and clap detector keep running); "Sair" in the tray quits for real.

Run from source with ``python -m fear.desktop`` (needs the ``desktop`` extra and
a UI built with ``NEXT_PUBLIC_FEAR_DESKTOP=1 npm run build``).
"""

from __future__ import annotations

import argparse
import hmac
import json
import logging
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request

from fear.logging_config import configure_logging

APP_NAME = "F.E.A.R."
APP_DIR_NAME = "FEAR"
# Fixed so the window keeps the same origin (and so its saved theme etc.) across
# launches; a random port is used only if this one is taken.
PREFERRED_PORT = 47865
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
INSTANCE_HEADER = "X-Fear-Instance"
_LOG_LIMIT_BYTES = 5 * 1024 * 1024

logger = logging.getLogger("fear.desktop")

LOADING_HTML = """<!doctype html><html><body style="margin:0;height:100vh;display:grid;
place-items:center;background:#050506;color:#9aa0a6;font:14px system-ui,sans-serif">
<div>Despertando o F.E.A.R.…</div></body></html>"""


def data_dir() -> Path:
    """Where this install keeps its memory, settings and logs (%LOCALAPPDATA%\\FEAR)."""
    base = os.getenv("LOCALAPPDATA") or os.getenv("XDG_DATA_HOME")
    root = Path(base) if base else Path.home() / ".local" / "share"
    path = root / APP_DIR_NAME
    path.mkdir(parents=True, exist_ok=True)
    return path


def resource_dir() -> Path:
    """Bundled files: PyInstaller's unpack dir when frozen, the repo root from source."""
    frozen_root = getattr(sys, "_MEIPASS", None)
    return Path(frozen_root) if frozen_root else Path(__file__).resolve().parents[1]


def ui_dir(resources: Path) -> Path:
    """The static UI: bundled as ui/ in the app, or the fresh `out/` export from source."""
    bundled = resources / "ui"
    return bundled if bundled.exists() else resources / "out"


def load_or_create_secret(path: Path) -> str:
    """The key that signs sessions and encrypts the OpenRouter key, kept per install."""
    if path.exists():
        existing = path.read_text(encoding="utf-8").strip()
        if existing:
            return existing
    secret = secrets.token_urlsafe(48)
    path.write_text(secret, encoding="utf-8")
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    return secret


def local_email() -> str:
    """The built-in account's address; its local part is how F.E.A.R. addresses you."""
    name = re.sub(r"[^a-z0-9._-]", "", os.getenv("USERNAME", os.getenv("USER", "")).lower())
    return f"{name or 'voce'}@fear.local"


def ensure_local_session(store, security) -> str:
    """Create the install's single account on first run and mint a session for it."""
    from fear.web.app import _session_token

    owner = store.owner()
    if owner is None:
        # The password is never used: login is disabled in the desktop app.
        owner = store.create_user(local_email(), secrets.token_urlsafe(32))
    return _session_token(security, owner)


def pick_port(preferred: int = PREFERRED_PORT) -> int:
    """The preferred port when it is free, otherwise any free local port."""
    for candidate in (preferred, 0):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", candidate))
            except OSError:
                continue
            return int(sock.getsockname()[1])
    raise RuntimeError("no free local port")


def wake_running_instance(instance_file: Path, timeout: float = 2.0) -> bool:
    """Ask an already-running F.E.A.R. to show its window; True if one answered."""
    try:
        info = json.loads(instance_file.read_text(encoding="utf-8"))
        request = urllib.request.Request(
            f"http://127.0.0.1:{int(info['port'])}/desktop/show",
            method="POST",
            headers={INSTANCE_HEADER: str(info["key"])},
        )
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status == 200
    except Exception:
        return False


def add_show_route(application: FastAPI, key: str, show: Callable[[], None]) -> None:
    """Let a second launch bring this window forward instead of starting another app."""

    async def desktop_show(request: Request) -> dict[str, bool]:
        supplied = request.headers.get(INSTANCE_HEADER, "")
        if not hmac.compare_digest(supplied.encode("utf-8"), key.encode("utf-8")):
            raise HTTPException(status_code=403, detail="forbidden")
        show()
        return {"shown": True}

    application.add_api_route("/desktop/show", desktop_show, methods=["POST"])


# --- "Iniciar com o Windows" (the same Run entry the installer writes) ------------


def autostart_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --minimized'
    return f'"{sys.executable}" -m fear.desktop --minimized'


def autostart_enabled() -> bool:
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, APP_NAME)
        return True
    except OSError:
        return False


def set_autostart(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass


# --- process setup ----------------------------------------------------------------


def _route_output_to_log(home: Path) -> None:
    """A windowed .exe has no console (sys.stdout is None); log to a file instead."""
    if sys.stdout is not None and sys.stderr is not None:
        return
    log_path = home / "fear.log"
    if log_path.exists() and log_path.stat().st_size > _LOG_LIMIT_BYTES:
        log_path.unlink()
    # Left open on purpose: it is the app's stdout/stderr until the process exits.
    stream = open(log_path, "a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream


def prepare_environment(home: Path, resources: Path) -> None:
    """Point the backend at this install's data, before any of it is imported."""
    from dotenv import load_dotenv

    # Relative paths in Settings (data/chroma, data/users.db, …) land in the data dir.
    os.chdir(home)
    # The person's own overrides (e.g. FEAR_ENABLE_CLAP_DETECTOR=1) live here.
    load_dotenv(home / ".env")
    os.environ.setdefault("FEAR_DESKTOP", "1")
    os.environ.setdefault("FEAR_ENV", "local")
    os.environ.setdefault("FEAR_SECRET_KEY", load_or_create_secret(home / "secret.key"))
    os.environ.setdefault("FEAR_PERSONA_FILE", str(resources / "prompts" / "fear_persona.md"))
    model_dir = resources / "onnx_models" / "all-MiniLM-L6-v2"
    if model_dir.exists():
        os.environ.setdefault("FEAR_ONNX_MODEL_DIR", str(model_dir))


def _start_backend(port: int):
    """Run uvicorn on a background thread; returns (server, thread)."""
    import uvicorn

    from fear.web.app import app

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_config=None))
    thread = threading.Thread(target=server.run, name="FearBackend", daemon=True)
    thread.start()
    return server, thread


def _wait_until_started(server, thread: threading.Thread) -> bool:
    while thread.is_alive() and not server.started:
        time.sleep(0.05)
    return bool(server.started)


def _tray_image(resources: Path):
    from PIL import Image

    return Image.open(resources / "packaging" / "fear.ico")


def smoke_test(home: Path, resources: Path) -> int:
    """Boot the bundled app headless and check what a broken build would lose.

    Run by CI against the built .exe (``--smoke-test``): the UI files, the API,
    and the bundled embedding model must all work, or the release is not made.
    """
    prepare_environment(home, resources)
    from fastapi.staticfiles import StaticFiles

    from fear.memory.embedding import LocalEmbedding
    from fear.web.app import app

    app.mount("/", StaticFiles(directory=ui_dir(resources), html=True), name="ui")
    port = pick_port(0)
    server, thread = _start_backend(port)
    try:
        if not _wait_until_started(server, thread):
            logger.error("smoke test: backend did not start")
            return 1
        base = f"http://127.0.0.1:{port}"
        with urllib.request.urlopen(f"{base}/health", timeout=10) as response:
            if json.loads(response.read())["status"] != "ok":
                return 1
        with urllib.request.urlopen(f"{base}/", timeout=10) as response:
            if b"<html" not in response.read().lower():
                logger.error("smoke test: the UI is missing")
                return 1
        if len(LocalEmbedding().embed("teste")) != 384:
            logger.error("smoke test: the embedding model is broken")
            return 1
        logger.info("smoke test passed")
        return 0
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="fear")
    parser.add_argument("--minimized", action="store_true", help="start hidden in the tray")
    parser.add_argument("--smoke-test", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)

    home = data_dir()
    resources = resource_dir()
    _route_output_to_log(home)
    configure_logging()

    if args.smoke_test:
        sys.exit(smoke_test(home, resources))

    instance_file = home / "instance.json"
    if wake_running_instance(instance_file):
        return  # the running F.E.A.R. brought its window forward

    prepare_environment(home, resources)

    import pystray
    import webview
    from fastapi.staticfiles import StaticFiles

    from fear.auth import Security, UserStore
    from fear.config import Settings
    from fear.web.app import app

    settings = Settings.from_env()
    store = UserStore(path=settings.users_db_path, security=Security(settings.secret_key))
    try:
        token = ensure_local_session(store, Security(settings.secret_key))
    finally:
        store.close()

    window = webview.create_window(
        APP_NAME,
        html=LOADING_HTML,
        width=1320,
        height=860,
        min_size=(960, 640),
        hidden=args.minimized,
        background_color="#050506",
    )
    quitting = threading.Event()

    def show() -> None:
        window.show()
        window.restore()

    def on_closing() -> bool:
        if quitting.is_set():
            return True
        window.hide()  # keep listening in the tray
        return False

    window.events.closing += on_closing

    port = pick_port()
    key = secrets.token_urlsafe(24)
    add_show_route(app, key, show)
    # Mounted last so every API route above keeps precedence over the UI files.
    app.mount("/", StaticFiles(directory=ui_dir(resources), html=True), name="ui")

    def quit_app(icon) -> None:
        quitting.set()
        icon.stop()
        window.destroy()

    def toggle_autostart(icon, item) -> None:
        set_autostart(not autostart_enabled())

    tray = pystray.Icon(
        APP_DIR_NAME,
        _tray_image(resources),
        APP_NAME,
        menu=pystray.Menu(
            pystray.MenuItem("Abrir F.E.A.R.", lambda icon, item: show(), default=True),
            pystray.MenuItem(
                "Iniciar com o Windows",
                toggle_autostart,
                checked=lambda item: autostart_enabled(),
                visible=sys.platform == "win32",
            ),
            pystray.MenuItem("Sair", lambda icon, item: quit_app(icon)),
        ),
    )

    server_box: dict[str, object] = {}

    def boot() -> None:
        server, thread = _start_backend(port)
        server_box["server"] = server
        if not _wait_until_started(server, thread):
            logger.error("The backend failed to start; see fear.log")
            window.load_html(
                LOADING_HTML.replace(
                    "Despertando o F.E.A.R.…",
                    f"O F.E.A.R. não conseguiu iniciar. Veja o log em {home / 'fear.log'}.",
                )
            )
            return
        instance_file.write_text(json.dumps({"port": port, "key": key}), encoding="utf-8")
        window.load_url(f"http://127.0.0.1:{port}/#token={token}")

    tray.run_detached()
    try:
        webview.start(boot, private_mode=False, storage_path=str(home / "webview"))
    finally:
        tray.stop()
        instance_file.unlink(missing_ok=True)
        server = server_box.get("server")
        if server is not None:
            server.should_exit = True  # type: ignore[attr-defined]


if __name__ == "__main__":
    main()
