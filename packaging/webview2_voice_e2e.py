"""Talking to the real Windows app: FEAR.exe, its WebView2 window, a fake microphone.

Run by the Windows workflow after the build. It starts the built app with
WebView2's test switches — a fake microphone playing a recorded question, and
DevTools on a local port — then uses the window like a person would: opens the
microphone, waits for the question to show up in the conversation, and for
F.E.A.R.'s spoken answer to play to the end. Nothing is granted from outside:
the app itself must allow the microphone, and it is opened without a real
click (as the pointing gesture does), so the answer plays only if the app lets
speech play on its own.

    python packaging/webview2_voice_e2e.py dist/FEAR/FEAR.exe
"""

from __future__ import annotations

import contextlib
import json
import os
import re
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
# A script-made press: unlike a real click it gives the page no user activation.
PRESS_MIC = """() => {
  const mic = [...document.querySelectorAll("button")].find((button) =>
    /Falar com o F\\.E\\.A\\.R\\./.test(button.getAttribute("aria-label") || ""));
  mic.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  mic.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}"""


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
    """Opens the microphone like the pointing gesture does, and listens to the answer."""
    page.wait_for_load_state("domcontentloaded")
    page.wait_for_timeout(1500)
    # The first run asks for an OpenRouter key. (Escape is the one key that
    # gives a page no user activation, so speech still has to play on its own.)
    page.keyboard.press("Escape")
    mic = page.get_by_role("button", name=re.compile(r"Falar com o F\.E\.A\.R\."))
    mic.wait_for(timeout=120_000)  # shows once the backend reports the voice
    page.evaluate(WATCH_PLAYBACK)
    shown = page.evaluate(QUESTIONS_SHOWN)
    started = time.monotonic()
    with page.expect_response(
        lambda response: response.url.endswith("/voice/transcribe"), timeout=120_000
    ) as transcription:
        page.evaluate(PRESS_MIC)
    report["heard"] = transcription.value.json().get("text", "")
    report["heard_after_s"] = round(time.monotonic() - started, 1)
    if "capital" not in report["heard"].lower():
        raise AssertionError(f"heard {report['heard']!r}")
    # It went into the conversation, and the answer was spoken to the end.
    page.wait_for_function(f"() => ({QUESTIONS_SHOWN})() > {shown}", timeout=30_000)
    page.wait_for_function("() => (window.__played || []).some((p) => p.ended)", timeout=120_000)


def main(exe: str) -> int:
    from playwright.sync_api import sync_playwright

    work = Path(tempfile.mkdtemp(prefix="fear-e2e-"))
    env = dict(os.environ)
    env["LOCALAPPDATA"] = str(work / "appdata")  # a first run, like a new install
    env["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = " ".join(
        [
            f"--remote-debugging-port={DEVTOOLS_PORT}",
            "--use-fake-device-for-media-stream",
            f"--use-file-for-fake-audio-capture={microphone_file(work)}",
        ]
    )
    app = subprocess.Popen([exe], env=env)
    report: dict = {"ok": False}
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
                talk_to_it(page, report)
                report["ok"] = True
            finally:
                # What the window played and showed, whatever happened.
                report["errors"] = errors
                with contextlib.suppress(Exception):
                    report["played"] = page.evaluate("() => window.__played")
                    page.screenshot(path=str(ROOT / "dist" / "voice-e2e.png"))
    except Exception as error:
        report["failure"] = repr(error)
    finally:
        subprocess.run(["taskkill", "/PID", str(app.pid), "/T", "/F"], capture_output=True)
    log = work / "appdata" / "FEAR" / "fear.log"
    if log.exists():
        print("\n".join(log.read_text(encoding="utf-8", errors="replace").splitlines()[-40:]))
    print(json.dumps(report, indent=1, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
