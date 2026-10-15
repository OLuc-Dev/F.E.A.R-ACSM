"""F.E.A.R.'s brain on this computer: models Ollama runs, free and unlimited.

Ollama (ollama.com) runs open models on the machine's own graphics card and
serves them at 127.0.0.1:11434. A model chosen from it is stored as
"ollama/<tag>". F.E.A.R. uses Ollama's own API rather than its OpenAI-shaped
one: it can switch thinking off (a spoken reply mustn't wait on reasoning
nobody hears) and give the persona and memories enough room in the context.
"""

from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any

import httpx

LOCAL_PREFIX = "ollama/"

# What the settings offer to download, smallest first. The recommended one fits
# a 6 GB card (the RTX 3050's smaller version) beside everything else running.
DOWNLOADS: tuple[dict[str, str | int], ...] = (
    {
        "tag": "qwen3.5:4b",
        "name": "Qwen 3.5 4B (Alibaba)",
        "size": 3_320_000_000,
        "note": "rápido, bom em português, cabe em placa de 6 GB",
    },
    {
        "tag": "gemma4:e4b",
        "name": "Gemma 4 E4B (Google)",
        "size": 6_580_000_000,
        "note": "mais esperto, precisa de placa de 8 GB",
    },
)
RECOMMENDED_LOCAL_MODEL = str(DOWNLOADS[0]["tag"])

# Between turns the model stays in the card this long; the first reply after
# it's unloaded waits a few seconds for it to load again.
_KEEP_ALIVE = "10m"
# The persona, memories and recent turns make a prompt of ~3,500 tokens: the
# context must hold that and the reply, or Ollama cuts the persona off.
_CONTEXT_TOKENS = 8192
# The list of installed models is trusted this long (it's read on every reply).
_LIST_FOR_S = 10.0


def is_local(model: str) -> bool:
    return model.startswith(LOCAL_PREFIX)


def local_id(tag: str) -> str:
    return LOCAL_PREFIX + tag


def local_tag(model: str) -> str:
    return model.removeprefix(LOCAL_PREFIX)


class LocalModelError(Exception):
    """Ollama didn't answer: it isn't running ("down"), doesn't have the model
    ("missing"), or failed to run it ("other")."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


@dataclass(frozen=True)
class LocalModel:
    """A model downloaded into this computer's Ollama."""

    tag: str
    size: int = 0  # bytes on disk
    parameter_size: str = ""
    # It writes text (an embedding-only model can't talk).
    chat: bool = True

    @classmethod
    def parse(cls, item: Mapping[str, Any]) -> LocalModel:
        details = item.get("details") or {}
        capabilities = item.get("capabilities")
        return cls(
            tag=item.get("name") or item.get("model") or "",
            size=int(item.get("size") or 0),
            parameter_size=details.get("parameter_size") or "",
            chat=capabilities is None or "completion" in capabilities,
        )


def _error_text(body: bytes) -> str:
    try:
        return str(json.loads(body).get("error") or body.decode(errors="replace"))
    except (ValueError, AttributeError):
        return body.decode(errors="replace")


class Ollama:
    """The Ollama on this computer: what it has, downloading more, and talking.

    `chat.completions.create(...)` mirrors the OpenAI client, so the brain
    drives a local model exactly as it drives one in the cloud.
    """

    def __init__(
        self,
        url: str,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.url = url.rstrip("/")
        self._transport = transport
        self._clock = clock
        self._listed: list[LocalModel] | None = None
        self._listed_at = float("-inf")
        self.chat = SimpleNamespace(completions=SimpleNamespace(create=self._create))

    def _client(self, read: float | None = 10.0) -> httpx.AsyncClient:
        return httpx.AsyncClient(
            base_url=self.url,
            transport=self._transport,
            timeout=httpx.Timeout(read, connect=3.0),
        )

    async def installed(self) -> list[LocalModel] | None:
        """The models downloaded here, or None when Ollama isn't running."""
        if self._clock() - self._listed_at < _LIST_FOR_S:
            return self._listed
        try:
            async with self._client() as client:
                response = await client.get("/api/tags")
                response.raise_for_status()
                listed: list[LocalModel] | None = [
                    LocalModel.parse(item) for item in response.json().get("models", [])
                ]
        except (httpx.HTTPError, ValueError):
            listed = None
        self._listed, self._listed_at = listed, self._clock()
        return listed

    async def chat_models(self) -> list[LocalModel]:
        """The installed models F.E.A.R. can talk with (none when Ollama is off)."""
        return [model for model in (await self.installed() or []) if model.chat]

    async def pull(self, tag: str) -> AsyncIterator[Mapping[str, Any]]:
        """Download `tag`; yields Ollama's progress ({status, digest, total,
        completed}), ending with {"status": "success"} or {"error": ...}."""
        try:
            async with self._client(read=None) as client:
                async with client.stream("POST", "/api/pull", json={"model": tag}) as response:
                    if response.status_code != 200:
                        yield {"error": _error_text(await response.aread())}
                        return
                    async for line in response.aiter_lines():
                        if line.strip():
                            yield json.loads(line)
        except (httpx.ConnectError, httpx.ConnectTimeout):
            yield {"error": "O Ollama não está aberto."}
        finally:
            self._listed_at = float("-inf")  # the next look sees what came in

    async def _create(self, *, model: str, messages: Any, stream: bool = False) -> Any:
        """One reply from a local model, shaped like the OpenAI client's."""
        body = {
            "model": local_tag(model),
            "messages": messages,
            "stream": stream,
            "think": False,
            "keep_alive": _KEEP_ALIVE,
            "options": {"num_ctx": _CONTEXT_TOKENS},
        }
        # Loading the model into the card can take a while; once it talks,
        # the words come quickly.
        client = self._client(read=180.0)
        try:
            response = await client.send(
                client.build_request("POST", "/api/chat", json=body), stream=True
            )
        except (httpx.ConnectError, httpx.ConnectTimeout) as exc:
            await client.aclose()
            raise LocalModelError("down", "O Ollama não está aberto.") from exc
        except httpx.TimeoutException as exc:
            await client.aclose()
            raise LocalModelError("other", "O modelo demorou demais para carregar.") from exc
        except BaseException:
            await client.aclose()
            raise
        if response.status_code != 200:
            text = _error_text(await response.aread())
            await response.aclose()
            await client.aclose()
            raise LocalModelError("missing" if response.status_code == 404 else "other", text)
        if not stream:
            try:
                data = json.loads(await response.aread())
            finally:
                await response.aclose()
                await client.aclose()
            content = (data.get("message") or {}).get("content") or ""
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content=content))]
            )
        return _chunks(response, client)


async def _chunks(response: httpx.Response, client: httpx.AsyncClient) -> AsyncIterator[Any]:
    """Ollama's streamed lines as OpenAI-shaped chunks."""
    try:
        async for line in response.aiter_lines():
            if not line.strip():
                continue
            data = json.loads(line)
            if data.get("error"):
                raise LocalModelError("other", str(data["error"]))
            content = (data.get("message") or {}).get("content") or ""
            if content:
                delta = SimpleNamespace(content=content)
                yield SimpleNamespace(choices=[SimpleNamespace(delta=delta)])
            if data.get("done"):
                break
    finally:
        await response.aclose()
        await client.aclose()
