"""Talking to Ollama on this computer, against a stand-in that answers as it does.

The replies below are the shapes a real Ollama (0.40) gives: /api/tags with
capabilities, streamed /api/chat lines, /api/pull progress, and its errors.
"""

from __future__ import annotations

import json

import httpx
import pytest

from fear.brain.local_models import (
    LocalModelError,
    Ollama,
    is_local,
    local_id,
    local_tag,
)

TAGS = {
    "models": [
        {
            "name": "qwen3.5:4b",
            "size": 3324173934,
            "details": {"family": "qwen35", "parameter_size": "4.2B"},
            "capabilities": ["completion", "vision", "thinking"],
        },
        {"name": "nomic-embed-text:latest", "size": 274302450, "capabilities": ["embedding"]},
    ]
}


class FakeOllama:
    """Answers like Ollama: tags, chat (streamed or not), pull, errors."""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict]] = []
        self.down = False
        self.chat_lines = [
            {"message": {"role": "assistant", "content": "A capital "}, "done": False},
            {"message": {"role": "assistant", "content": "é Paris."}, "done": False},
            {"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop"},
        ]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        if self.down:
            raise httpx.ConnectError("connection refused", request=request)
        body = json.loads(request.content) if request.content else {}
        self.requests.append((request.url.path, body))
        if request.url.path == "/api/tags":
            return httpx.Response(200, json=TAGS)
        if request.url.path == "/api/chat":
            if body["model"] != "qwen3.5:4b":
                return httpx.Response(404, json={"error": f"model '{body['model']}' not found"})
            if not body.get("stream", True):
                return httpx.Response(
                    200, json={"message": {"role": "assistant", "content": "Paris."}, "done": True}
                )
            lines = "".join(json.dumps(line) + "\n" for line in self.chat_lines)
            return httpx.Response(200, content=lines.encode())
        if request.url.path == "/api/pull":
            if body["model"] == "nope:1b":
                return httpx.Response(
                    500, json={"error": "pull model manifest: file does not exist"}
                )
            lines = [
                {"status": "pulling manifest"},
                {"status": "pulling 735af2139dc6", "digest": "sha256:735a", "total": 1000},
                {
                    "status": "pulling 735af2139dc6",
                    "digest": "sha256:735a",
                    "total": 1000,
                    "completed": 600,
                },
                {"status": "verifying sha256 digest"},
                {"status": "success"},
            ]
            return httpx.Response(
                200, content="".join(json.dumps(x) + "\n" for x in lines).encode()
            )
        return httpx.Response(404)


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _ollama(fake: FakeOllama, clock: Clock | None = None) -> Ollama:
    return Ollama(
        "http://127.0.0.1:11434/", transport=httpx.MockTransport(fake), clock=clock or Clock()
    )


def test_local_ids_say_where_a_model_runs() -> None:
    assert local_id("qwen3.5:4b") == "ollama/qwen3.5:4b"
    assert local_tag("ollama/qwen3.5:4b") == "qwen3.5:4b"
    assert is_local("ollama/qwen3.5:4b") and not is_local("openai/gpt-oss-120b")


async def test_lists_what_is_downloaded_and_what_can_talk() -> None:
    fake = FakeOllama()
    clock = Clock()
    ollama = _ollama(fake, clock)

    installed = await ollama.installed()
    chat = await ollama.chat_models()

    assert installed is not None and [model.tag for model in installed] == [
        "qwen3.5:4b",
        "nomic-embed-text:latest",
    ]
    assert [(model.tag, model.size, model.parameter_size) for model in chat] == [
        ("qwen3.5:4b", 3324173934, "4.2B")
    ]  # an embedding model can't talk
    # Read on every reply: asked once, then trusted for a few seconds.
    assert [path for path, _ in fake.requests] == ["/api/tags"]
    clock.now += 11
    await ollama.installed()
    assert len(fake.requests) == 2


async def test_says_nothing_is_there_when_ollama_is_closed() -> None:
    fake = FakeOllama()
    fake.down = True
    ollama = _ollama(fake)
    assert await ollama.installed() is None
    assert await ollama.chat_models() == []


async def test_talks_without_thinking_and_with_room_for_the_persona() -> None:
    fake = FakeOllama()
    ollama = _ollama(fake)
    messages = [{"role": "user", "content": "Qual é a capital da França?"}]

    reply = await ollama.chat.completions.create(model="ollama/qwen3.5:4b", messages=messages)
    stream = await ollama.chat.completions.create(
        model="ollama/qwen3.5:4b", messages=messages, stream=True
    )
    pieces = [chunk.choices[0].delta.content async for chunk in stream]

    assert reply.choices[0].message.content == "Paris."
    assert pieces == ["A capital ", "é Paris."]
    _, sent = fake.requests[-1]
    assert sent["model"] == "qwen3.5:4b"  # Ollama's own tag, without "ollama/"
    assert sent["think"] is False  # a spoken reply doesn't wait on reasoning
    assert sent["options"]["num_ctx"] >= 8192
    assert sent["keep_alive"]


async def test_tells_a_missing_model_from_ollama_being_closed() -> None:
    fake = FakeOllama()
    messages = [{"role": "user", "content": "oi"}]

    with pytest.raises(LocalModelError) as missing:
        await _ollama(fake).chat.completions.create(model="ollama/nope:1b", messages=messages)
    fake.down = True
    with pytest.raises(LocalModelError) as down:
        await _ollama(fake).chat.completions.create(
            model="ollama/qwen3.5:4b", messages=messages, stream=True
        )

    assert missing.value.kind == "missing" and "not found" in str(missing.value)
    assert down.value.kind == "down"


async def test_a_failure_mid_reply_is_an_error() -> None:
    fake = FakeOllama()
    fake.chat_lines = [
        {"message": {"content": "A capital"}, "done": False},
        {"error": "model runner has unexpectedly stopped"},
    ]
    stream = await _ollama(fake).chat.completions.create(
        model="ollama/qwen3.5:4b", messages=[], stream=True
    )
    with pytest.raises(LocalModelError) as stopped:
        async for _ in stream:
            pass
    assert stopped.value.kind == "other"


async def test_downloads_report_progress_until_success() -> None:
    fake = FakeOllama()
    clock = Clock()
    ollama = _ollama(fake, clock)
    await ollama.installed()

    events = [event async for event in ollama.pull("qwen3.5:4b")]

    assert events[0] == {"status": "pulling manifest"}
    assert events[2]["completed"] == 600 and events[2]["total"] == 1000
    assert events[-1] == {"status": "success"}
    # What came in shows at once, without waiting for the list to go stale.
    await ollama.installed()
    assert [path for path, _ in fake.requests].count("/api/tags") == 2


async def test_a_failed_download_says_why() -> None:
    fake = FakeOllama()
    assert [event async for event in _ollama(fake).pull("nope:1b")] == [
        {"error": "pull model manifest: file does not exist"}
    ]
    fake.down = True
    assert [event async for event in _ollama(fake).pull("qwen3.5:4b")] == [
        {"error": "O Ollama não está aberto."}
    ]
