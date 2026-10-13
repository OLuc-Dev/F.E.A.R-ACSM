"""The F.E.A.R. Windows app: one process that runs the backend and its own window.

Each install is a private, single-person F.E.A.R. The launcher creates the one
local account itself and hands the window a fresh session on every start, so
there is never a login. Closing the window only hides it to the tray (the mic
and clap detector keep running; hand gestures pause with the window, since the
camera is only on while you can see the app); "Sair" in the tray quits for real.

Run from source with ``python -m fear.desktop`` (needs the ``desktop`` extra and
a UI built with ``NEXT_PUBLIC_FEAR_DESKTOP=1 npm run build``).
"""

from __future__ import annotations

import argparse
import hmac
import importlib
import json
import logging
import mimetypes
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request

from fear.desktop_prefs import APP_NAME, autostart_enabled, set_autostart
from fear.logging_config import configure_logging

APP_DIR_NAME = "FEAR"
# Fixed so the window keeps the same origin (and so its saved theme etc.) across
# launches; a random port is used only if this one is taken.
PREFERRED_PORT = 47865
INSTANCE_HEADER = "X-Fear-Instance"
_LOG_LIMIT_BYTES = 5 * 1024 * 1024

logger = logging.getLogger("fear.desktop")

# Python's mimetypes also reads the Windows registry, where a stray entry can map
# .js to text/plain; the UI's files (and gestures' WASM) need their real types.
STATIC_TYPES = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".wasm": "application/wasm",
    ".task": "application/octet-stream",
    ".glb": "model/gltf-binary",
    ".svg": "image/svg+xml",
}

PIPER_VOICE_FILE = "pt_BR-cadu-medium.onnx"

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


def mount_ui(application: FastAPI, resources: Path) -> None:
    """Serve the static UI at "/", after every API route so those keep precedence."""
    from fastapi.staticfiles import StaticFiles

    for extension, media_type in STATIC_TYPES.items():
        mimetypes.add_type(media_type, extension)
    application.mount("/", StaticFiles(directory=ui_dir(resources), html=True), name="ui")


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


class DesktopBridge:
    """What the page may ask of the app itself, as ``window.pywebview.api``.

    Only public methods are exposed to the page; the window stays private.
    """

    def __init__(self) -> None:
        self._window: Any = None

    def pick_folder(self) -> str:
        """Open Windows' folder picker: the folder chosen, or "" if cancelled."""
        import webview

        if self._window is None:
            return ""
        chosen = self._window.create_file_dialog(webview.FOLDER_DIALOG)
        return str(chosen[0]) if chosen else ""


def add_show_route(application: FastAPI, key: str, show: Callable[[], None]) -> None:
    """Let a second launch bring this window forward instead of starting another app."""

    async def desktop_show(request: Request) -> dict[str, bool]:
        supplied = request.headers.get(INSTANCE_HEADER, "")
        if not hmac.compare_digest(supplied.encode("utf-8"), key.encode("utf-8")):
            raise HTTPException(status_code=403, detail="forbidden")
        show()
        return {"shown": True}

    application.add_api_route("/desktop/show", desktop_show, methods=["POST"])


def allow_media_for_own_page(window, origin: str) -> None:
    """Let the app's own page use the webcam (gestures) and microphone (voice), unprompted.

    WebView2 would otherwise ask on its own; only pages served by this app's
    backend (``origin``) are approved, and only those two — any other page or
    permission still goes through WebView2's default prompt.
    """
    if sys.platform != "win32":
        return
    try:
        from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
            CoreWebView2PermissionKind,
            CoreWebView2PermissionState,
        )
        from System import Func, Type  # type: ignore[import-not-found]
    except Exception:
        logger.warning("WebView2 is not reachable; camera and microphone will ask first")
        return

    allowed = (CoreWebView2PermissionKind.Camera, CoreWebView2PermissionKind.Microphone)

    def on_permission_requested(_sender, args) -> None:
        if args.PermissionKind in allowed and str(args.Uri).startswith(origin):
            args.State = CoreWebView2PermissionState.Allow

    def attach() -> None:
        # CoreWebView2 may only be touched on the window's UI thread.
        try:
            window.native.browser.webview.CoreWebView2.PermissionRequested += (
                on_permission_requested
            )
        except Exception:
            logger.warning("Could not pre-approve camera and microphone", exc_info=True)

    try:
        window.native.Invoke(Func[Type](attach))
    except Exception:
        logger.warning("Could not pre-approve camera and microphone", exc_info=True)


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
    _provide("FEAR_DESKTOP", "1")
    _provide("FEAR_ENV", "local")
    _provide("FEAR_SECRET_KEY", load_or_create_secret(home / "secret.key"))
    # A persona of their own counts only if it's really there: .env.example's
    # prompts/fear_persona.md means the repo's copy, which isn't in this folder.
    persona = os.environ.get("FEAR_PERSONA_FILE", "").strip()
    if not (persona and Path(persona).is_file()):
        os.environ["FEAR_PERSONA_FILE"] = str(resources / "prompts" / "fear_persona.md")
    model_dir = resources / "onnx_models" / "all-MiniLM-L6-v2"
    if model_dir.exists():
        _provide("FEAR_ONNX_MODEL_DIR", str(model_dir))
    voice = voice_dir(resources)
    if voice is not None:
        _provide("FEAR_STT_MODEL", str(voice / "whisper-small"))
        _provide("FEAR_PIPER_VOICE", str(voice / "piper" / PIPER_VOICE_FILE))
        # Loaded in the background at start, so the first spoken command is quick.
        _provide("FEAR_PRELOAD_VOICE", "1")


def _provide(name: str, value: str) -> None:
    """What the app ships, unless the person's .env sets it to something.

    Blank counts as unset: a .env copied from .env.example is full of empty
    placeholders (FEAR_SECRET_KEY=, …) that must not switch off what the app
    brings — an empty secret, for one, would lose the saved key on every start.
    """
    if not os.environ.get(name, "").strip():
        os.environ[name] = value


def webview2_flags(existing: str) -> str:
    """The browser flags for the app's WebView2 window, keeping any already set.

    F.E.A.R. answers out loud even when you only spoke or gestured (no click
    yet), which WebView2's autoplay policy would otherwise silence. pywebview's
    own flag (no rubber-band scrolling) comes along, since its way of passing
    it doesn't apply when it creates the environment itself.
    """
    flags = existing.split()
    if not any(flag.startswith("--autoplay-policy") for flag in flags):
        flags.append("--autoplay-policy=no-user-gesture-required")
    if not any(flag.startswith("--disable-features") for flag in flags):
        flags.append("--disable-features=ElasticOverscroll")
    return " ".join(flags)


def give_webview2_flags(flags: str) -> None:
    """Start WebView2 with these browser flags, in its environment's options.

    With a storage folder, pywebview creates WebView2's environment itself and
    passes no options; WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS didn't reach the
    browser then (in the Windows workflow, its command line had none of them).
    So the same call is made with the flags where WebView2 documents them. If
    that fails for any reason, pywebview's own call runs instead: the window
    opens either way.
    """
    if sys.platform != "win32":
        return
    try:
        # pywebview's module first: it loads .NET and registers WebView2's
        # assemblies, without which the types below can't be imported.
        edgechromium = importlib.import_module("webview.platforms.edgechromium")
        from Microsoft.Web.WebView2.Core import (  # type: ignore[import-not-found]
            CoreWebView2Environment,
            CoreWebView2EnvironmentOptions,
        )
        from System import Action  # type: ignore[import-not-found]
        from System.Threading.Tasks import Task  # type: ignore[import-not-found]
    except Exception as error:
        logger.warning(
            "WebView2 flags can't be set (%s); F.E.A.R. may need a click to speak", error
        )
        return
    original = edgechromium.EdgeChrome.setup_webview2_environment

    def setup_webview2_environment(self) -> None:
        def ready(task) -> None:
            if task.IsFaulted:  # refused the flags: still open, without them
                logger.error("WebView2 refused the browser flags: %s", task.Exception)
                original(self)
                return
            self.webview.EnsureCoreWebView2Async(task.Result)

        try:
            options = CoreWebView2EnvironmentOptions()
            options.AdditionalBrowserArguments = flags
            environment = CoreWebView2Environment.CreateAsync(
                None, edgechromium._state["storage_path"], options
            )
            environment.ContinueWith(
                Action[Task[CoreWebView2Environment]](ready), self.syncContextTaskScheduler
            )
        except Exception:
            logger.exception("WebView2 didn't take the browser flags; starting without them")
            original(self)

    edgechromium.EdgeChrome.setup_webview2_environment = setup_webview2_environment


def voice_dir(resources: Path) -> Path | None:
    """The speech models: bundled as voice/ in the app, or fetched for a source run."""
    for candidate in (resources / "voice", resources / "packaging" / "build" / "voice"):
        if (candidate / "whisper-small").is_dir():
            return candidate
    return None


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


def _voice_round_trip() -> bool:
    """Piper says a sentence, Whisper must hear it: both engines, end to end."""
    from fear.audio.speech import SpeechToText, TextToSpeech

    voice_out = TextToSpeech(os.environ.get("FEAR_PIPER_VOICE", ""))
    ears = SpeechToText(os.environ.get("FEAR_STT_MODEL", ""))
    if not (voice_out.available and ears.available):
        logger.error("smoke test: voice models are bundled but speech can't load them")
        return False
    heard = ears.transcribe(voice_out.synthesize("Isto é um teste de voz.", "fear"))
    if "teste" not in heard.lower():
        logger.error("smoke test: the voice round trip heard %r", heard)
        return False
    logger.info("smoke test: voice round trip heard %r", heard)
    return True


def smoke_test(home: Path, resources: Path) -> int:
    """Boot the bundled app headless and check what a broken build would lose.

    Run by CI against the built .exe (``--smoke-test``): the UI files, the API,
    and the bundled embedding model must all work, or the release is not made.
    """
    prepare_environment(home, resources)
    from fear.memory.embedding import LocalEmbedding
    from fear.web.app import app

    mount_ui(app, resources)
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
        # Hand gestures: the model and the WASM runtime, with the type the
        # browser needs to compile it.
        with urllib.request.urlopen(f"{base}/mediapipe/gesture_recognizer.task", timeout=10) as r:
            if len(r.read()) < 1_000_000:
                logger.error("smoke test: the gesture model is missing")
                return 1
        wasm = f"{base}/mediapipe/wasm/vision_wasm_internal.wasm"
        with urllib.request.urlopen(wasm, timeout=10) as response:
            if response.headers.get_content_type() != "application/wasm":
                logger.error(
                    "smoke test: gesture WASM served as %s", response.headers.get_content_type()
                )
                return 1
        if len(LocalEmbedding().embed("teste")) != 384:
            logger.error("smoke test: the embedding model is broken")
            return 1
        if voice_dir(resources) is not None and not _voice_round_trip():
            return 1
        logger.info("smoke test passed")
        return 0
    except urllib.error.HTTPError as error:
        logger.error("smoke test: %s is missing from the bundle (HTTP %s)", error.url, error.code)
        return 1
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

    from fear.auth import Security, UserStore
    from fear.config import Settings
    from fear.web.app import app

    settings = Settings.from_env()
    store = UserStore(path=settings.users_db_path, security=Security(settings.secret_key))
    try:
        token = ensure_local_session(store, Security(settings.secret_key))
    finally:
        store.close()

    bridge = DesktopBridge()
    window = webview.create_window(
        APP_NAME,
        html=LOADING_HTML,
        js_api=bridge,
        width=1320,
        height=860,
        min_size=(960, 640),
        hidden=args.minimized,
        background_color="#050506",
    )
    bridge._window = window
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
    mount_ui(app, resources)

    camera_ready = threading.Event()

    def on_loaded() -> None:
        # WebView2 exists once the first page has loaded; hook it up only once.
        if not camera_ready.is_set():
            camera_ready.set()
            allow_media_for_own_page(window, f"http://127.0.0.1:{port}/")

    window.events.loaded += on_loaded

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

    if sys.platform == "win32":
        flags = webview2_flags(os.environ.get("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", ""))
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = flags
        give_webview2_flags(flags)
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
