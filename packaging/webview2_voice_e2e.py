"""Talking to the real Windows app: FEAR.exe, its WebView2 window, a fake microphone.

Run by the Windows workflow after the build. It starts the built app with
WebView2's test switches — a fake microphone playing a recorded question, and
DevTools on a local port — and then does what a person would: nothing but talk.
The app must hear the question on its own as soon as its window opens (it's
always listening), put it in the conversation, and speak the answer to the end.
Nothing is granted from outside: the app itself must allow the microphone and
let speech play without a click.

    python packaging/webview2_voice_e2e.py dist/FEAR/FEAR.exe
"""

from __future__ import annotations

import contextlib
import json
import os
import subprocess
import sys
import tempfile
import time
import wave
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
QUESTION = ROOT / "tests" / "fixtures" / "browser-recording.webm"  # "Qual é a capital da França?"
DEVTOOLS_PORT = 9223
RATE = 48_000

# Wraps audio playback so the test can see each spoken sentence start and end.
WATCH_PLAYBACK = """() => {
  window.__played = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    const entry = {};
    window.__played.push(entry);
    this.addEventListener("ended", () => { entry.ended = true; });
    this.addEventListener("error", () => { entry.error = this.error && this.error.code; });
    return play.call(this).catch((error) => { entry.rejected = String(error); throw error; });
  };
}"""
QUESTIONS_SHOWN = """() => [...document.querySelectorAll("*")].filter(
  (el) => el.childElementCount === 0 && /capital/i.test(el.textContent || "")).length"""


def microphone_file(folder: Path) -> Path:
    """The recorded question as the WAV a fake microphone plays, with quiet around it."""
    from faster_whisper import decode_audio

    speech = decode_audio(str(QUESTION), sampling_rate=RATE)
    quiet = np.zeros(RATE * 3, dtype=np.float32)
    audio = np.concatenate([quiet[: RATE // 2], speech, quiet])
    path = folder / "question.wav"
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(RATE)
        out.writeframes((np.clip(audio, -1, 1) * 32767).astype("<i2").tobytes())
    return path


def app_page(browser, deadline: float):
    """The window's page once it shows the app (it may open on a splash screen)."""
    while time.monotonic() < deadline:
        pages = [page for context in browser.contexts for page in context.pages]
        for page in pages:
            # Served by the app's own backend; the UI scrubs the #token= at once.
            if page.url.startswith("http://127.0.0.1:"):
                return page
        if pages:
            pages[0].wait_for_timeout(500)  # lets Playwright see the navigation
        elif browser.contexts:
            browser.contexts[0].wait_for_event("page", timeout=30_000)
        else:
            time.sleep(0.5)
    raise TimeoutError("the app's page never opened")


def webview2_command_lines() -> list[str]:
    """How WebView2's browser processes were started: which flags reached them."""
    script = (
        "Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" "
        "| ForEach-Object { $_.CommandLine }"
    )
    try:
        shown = subprocess.run(
            ["powershell", "-NoProfile", "-Command", script],
            capture_output=True,
            text=True,
            timeout=60,
        ).stdout
    except Exception as error:
        return [repr(error)]
    return [line for line in shown.splitlines() if line.strip() and "--type=" not in line]


def connect(playwright, app: subprocess.Popen, deadline: float):
    """DevTools of the app's window, once WebView2 is up."""
    while True:
        try:
            return playwright.chromium.connect_over_cdp(f"http://127.0.0.1:{DEVTOOLS_PORT}")
        except Exception:
            if time.monotonic() > deadline or app.poll() is not None:
                raise
            time.sleep(1)


def talk_to_it(page, report: dict) -> None:
    """Says the question — and only that: no click, no key — and listens to the answer."""
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(1500)
    # The first run asks for an OpenRouter key. (Escape is the one key that
    # gives a page no user activation, so speech still has to play on its own.)
    page.keyboard.press("Escape")
    page.evaluate(WATCH_PLAYBACK)
    shown = page.evaluate(QUESTIONS_SHOWN)
    started = time.monotonic()
    # The fake microphone keeps repeating the question: the app hears it by itself.
    with page.expect_response(
        lambda response: response.url.endswith("/voice/transcribe"), timeout=120_000
    ) as transcription:
        pass
    report["heard"] = transcription.value.json().get("text", "")
    report["heard_after_s"] = round(time.monotonic() - started, 1)
    if "capital" not in report["heard"].lower():
        raise AssertionError(f"heard {report['heard']!r}")
    # It went into the conversation, and the answer was spoken to the end.
    page.wait_for_function(f"() => ({QUESTIONS_SHOWN})() > {shown}", timeout=30_000)
    page.wait_for_function("() => (window.__played || []).some((p) => p.ended)", timeout=120_000)


MIC_LABEL = """() => [...document.querySelectorAll("button[aria-pressed]")]
  .map((button) => button.getAttribute("aria-label") || "")
  .find((label) => /microfone|ouvindo|ouvir/i.test(label)) || ''"""


def app_window(pid: int) -> int:
    """The app's own window (WinForms), not the tray icon's hidden one."""
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32  # type: ignore[attr-defined]
    found: list[int] = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def each(hwnd, _):
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        name = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, name, 256)
        if owner.value == pid and user32.IsWindowVisible(hwnd):
            if name.value.startswith("WindowsForms10.Window"):
                found.append(hwnd)
        return True

    user32.EnumWindows(each, 0)
    return found[0] if found else 0


def close_to_tray(page, app: subprocess.Popen, report: dict) -> None:
    """The window's X, as a person clicks it: hidden in the tray, it must stop listening."""
    import ctypes

    window = app_window(app.pid)
    if not window:
        raise AssertionError("the app's window wasn't found")
    ctypes.windll.user32.PostMessageW(window, 0x0010, 0, 0)  # type: ignore[attr-defined]  # WM_CLOSE
    page.wait_for_timeout(2500)
    report["closed_visibility"] = page.evaluate("document.visibilityState")
    report["closed_microphone"] = page.evaluate(MIC_LABEL)
    if "desligado" not in report["closed_microphone"]:
        raise AssertionError("closed to the tray, it kept listening")


def started_with_windows(page, report: dict) -> None:
    """Started minimized to the tray, as at login: it waits there, not listening."""
    heard: list[str] = []
    page.on(
        "response",
        lambda response: (
            heard.append(response.url) if response.url.endswith("/voice/transcribe") else None
        ),
    )
    page.wait_for_load_state("domcontentloaded")
    # The microphone button shows once the backend reports a voice.
    page.wait_for_function(f"() => ({MIC_LABEL})() !== ''", timeout=120_000)
    page.wait_for_timeout(15_000)  # the fake microphone says the question twice meanwhile
    report["tray_microphone"] = page.evaluate(MIC_LABEL)
    report["tray_transcriptions"] = len(heard)
    if heard or "desligado" not in report["tray_microphone"]:
        raise AssertionError("started in the tray, it listened")


def run_app(exe: str, args: list[str], env: dict, report: dict, scenario) -> None:
    """Starts the app, hands its page to `scenario`, and always ends the app."""
    from playwright.sync_api import sync_playwright

    app = subprocess.Popen([exe, *args], env=env)
    try:
        with sync_playwright() as playwright:
            deadline = time.monotonic() + 180
            page = app_page(connect(playwright, app, deadline), deadline)
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.on(
                "console",
                lambda message: errors.append(message.text) if message.type == "error" else None,
            )
            try:
                scenario(page, app)
            finally:
                # What the window played and showed, whatever happened.
                report.setdefault("errors", []).extend(errors)
                with contextlib.suppress(Exception):
                    report.setdefault("played", page.evaluate("() => window.__played"))
                    page.screenshot(path=str(ROOT / "dist" / "voice-e2e.png"))
    except Exception:
        report["webview2_browser"] = webview2_command_lines()
        raise
    finally:
        subprocess.run(["taskkill", "/PID", str(app.pid), "/T", "/F"], capture_output=True)
        time.sleep(2)  # let WebView2 let go of the DevTools port before the next start


def main(exe: str) -> int:
    work = Path(tempfile.mkdtemp(prefix="fear-e2e-"))
    microphone = microphone_file(work)

    def env_for(name: str) -> dict:
        env = dict(os.environ)
        env["LOCALAPPDATA"] = str(work / name)  # a first run, like a new install
        env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(
            [
                f"--remote-debugging-port={DEVTOOLS_PORT}",
                "--use-fake-device-for-media-stream",
                f"--use-file-for-fake-audio-capture={microphone}",
            ]
        )
        return env

    def opened(page, app) -> None:
        talk_to_it(page, report)
        if sys.platform == "win32":
            close_to_tray(page, app, report)

    report: dict = {"ok": False}
    try:
        run_app(exe, [], env_for("appdata"), report, opened)
        if sys.platform == "win32":
            run_app(
                exe,
                ["--minimized"],
                env_for("appdata-tray"),
                report,
                lambda page, app: started_with_windows(page, report),
            )
        report["ok"] = True
    except Exception as error:
        report["failure"] = repr(error)
    for name in ("appdata", "appdata-tray"):
        log = work / name / "FEAR" / "fear.log"
        if log.exists():
            print(f"--- {name}/FEAR/fear.log")
            print("\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]))
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
