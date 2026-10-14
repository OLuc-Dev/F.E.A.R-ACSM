"""F.E.A.R.'s voice from Microsoft's neural voices, the ones Edge reads aloud with.

Far more natural than the local voice (Piper), free and quick, but it needs the
internet, each sentence goes to Microsoft, and it isn't an official API. So it
is a bonus on top of the local voice: whenever it fails, the local voice speaks
that sentence, and the online one rests for a while before it's tried again.
"""

from __future__ import annotations

import asyncio
import functools
import importlib.util
import io
import ssl
import time
import urllib.request
from collections.abc import AsyncIterator, Callable, Mapping
from typing import Any, Protocol

from fear.audio.speech import FEAR_PITCH, VoiceStyle, encode_wav, fear_voice

# Brazilian Portuguese, male: the most natural free voice for F.E.A.R.
VOICE = "pt-BR-AntonioNeural"
# What the service sends: MP3, 24 kHz mono.
_RATE = 24_000
# For F.E.A.R.'s timbre it speaks this much faster, and the effect stretches it
# back: lower, at the same pace (as Piper's length_scale does locally).
_FEAR_RATE = f"+{round((1 / FEAR_PITCH - 1) * 100)}%"
_TIMEOUT_S = 8.0
# After a failure it rests this long, doubling while it keeps failing: a day
# offline costs a slow sentence now and then, not every sentence.
_REST_S = 60.0
_REST_MAX_S = 15 * 60.0


class OnlineVoiceError(Exception):
    """The service didn't speak this sentence."""


class _Speech(Protocol):
    def stream(self) -> AsyncIterator[Mapping[str, Any]]: ...


# (text, rate) -> the service's reply, streamed as edge-tts does.
Connect = Callable[[str, str], _Speech]


class OnlineVoice:
    """Speaks a sentence with Microsoft's neural voice (edge-tts)."""

    def __init__(
        self,
        voice: str = VOICE,
        *,
        connect: Connect | None = None,
        timeout: float = _TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.voice = voice
        self.timeout = timeout
        self._connect = connect
        self._clock = clock
        self._rest = _REST_S
        self._resting_until = 0.0

    @property
    def available(self) -> bool:
        return self._connect is not None or importlib.util.find_spec("edge_tts") is not None

    def ready(self) -> bool:
        """Worth asking now: installed, and not resting after a failure."""
        return self.available and self._clock() >= self._resting_until

    async def synthesize(self, text: str, style: VoiceStyle = "natural") -> tuple[bytes, str]:
        """`text` spoken, with its media type: the service's MP3 as it comes, or a WAV
        in F.E.A.R.'s timbre. Raises OnlineVoiceError, and rests, on any failure."""
        try:
            spoken = await asyncio.wait_for(self._speak(text, style), self.timeout)
        except Exception as exc:
            self._resting_until = self._clock() + self._rest
            self._rest = min(self._rest * 2, _REST_MAX_S)
            raise OnlineVoiceError(f"{type(exc).__name__}: {exc}") from exc
        self._rest = _REST_S
        return spoken

    async def _speak(self, text: str, style: VoiceStyle) -> tuple[bytes, str]:
        fear = style == "fear"
        speech = (self._connect or self._edge)(text, _FEAR_RATE if fear else "+0%")
        chunks = [chunk["data"] async for chunk in speech.stream() if chunk.get("type") == "audio"]
        mp3 = b"".join(chunks)
        if not mp3:
            raise OnlineVoiceError("no audio came back")
        if not fear:
            return mp3, "audio/mpeg"
        return await asyncio.to_thread(_in_fear_timbre, mp3), "audio/wav"

    def _edge(self, text: str, rate: str) -> _Speech:
        import edge_tts

        _trust_this_computer()
        return edge_tts.Communicate(
            text,
            self.voice,
            rate=rate,
            proxy=_system_proxy(),
            connect_timeout=5,
            receive_timeout=int(self.timeout),
        )


def _in_fear_timbre(mp3: bytes) -> bytes:
    """The service's MP3 (spoken at _FEAR_RATE) as a WAV in F.E.A.R.'s timbre."""
    from faster_whisper import decode_audio  # PyAV underneath, there for recognition

    return encode_wav(fear_voice(decode_audio(io.BytesIO(mp3), sampling_rate=_RATE), _RATE), _RATE)


def _system_proxy() -> str | None:
    """The proxy this computer uses for the web, if any (Windows settings, HTTPS_PROXY)."""
    proxies = urllib.request.getproxies()
    return proxies.get("https") or proxies.get("http") or None


@functools.cache
def _trust_this_computer() -> None:
    """Check the service's certificate against this computer's trusted roots too.

    edge-tts trusts only certifi's list, which fails on networks that inspect
    TLS (a company proxy whose root is installed in Windows) where the browser
    works fine.
    """
    import certifi
    from edge_tts import communicate

    if hasattr(communicate, "_SSL_CTX"):
        context = ssl.create_default_context(cafile=certifi.where())
        context.load_default_certs()
        communicate._SSL_CTX = context
