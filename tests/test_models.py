"""Choosing the OpenRouter model, and saying plainly why none answered."""

from __future__ import annotations

import httpx
import openai
import pytest

from fear.brain.models import (
    FALLBACK_MODELS,
    LLM_ERROR_REPLY,
    ModelCatalog,
    ModelChain,
    ModelFailure,
    classify,
    explain,
)

_REQUEST = httpx.Request("POST", "https://openrouter.ai/api/v1/chat/completions")


def status_error(status: int, message: str) -> openai.APIStatusError:
    """What the OpenAI client raises for an OpenRouter error reply."""
    error_class = {
        400: openai.BadRequestError,
        401: openai.AuthenticationError,
        403: openai.PermissionDeniedError,
        404: openai.NotFoundError,
        429: openai.RateLimitError,
    }.get(status, openai.APIStatusError)
    return error_class(message, response=httpx.Response(status, request=_REQUEST), body=None)


@pytest.mark.parametrize(
    ("error", "kind", "try_another"),
    [
        (status_error(401, "No auth credentials found"), "key", False),
        (status_error(403, "Key limit exceeded"), "key_limit", False),
        (status_error(402, "Insufficient credits"), "credits", True),
        (
            status_error(429, "Rate limit exceeded: free-models-per-day. Add 10 credits"),
            "free_quota",
            False,
        ),
        (
            status_error(
                404, "No endpoints found matching your data policy (Free model publication)"
            ),
            "privacy",
            False,
        ),
        (status_error(404, "No endpoints found for openai/gpt-oss-120b:free."), "model", True),
        (status_error(400, "openai/gpt-oss-120b:free is not a valid model ID"), "model", True),
        (status_error(429, "Rate limit exceeded: free-models-per-min."), "busy", True),
        (status_error(502, "Provider returned error"), "busy", True),
        (openai.APIConnectionError(request=_REQUEST), "network", False),
        (openai.APITimeoutError(request=_REQUEST), "network", False),
        (status_error(400, "Your input was flagged"), "other", True),
        (RuntimeError("something odd"), "other", True),
    ],
)
def test_reads_what_each_failure_means(error, kind, try_another) -> None:
    assert classify(error) == ModelFailure(kind, try_another)


def test_says_what_stopped_the_search_else_what_happened_to_the_chosen_model() -> None:
    gone, busy = ModelFailure("model", True), ModelFailure("busy", True)
    quota = ModelFailure("free_quota", False)

    assert "x/y:free não está disponível" in explain([gone, busy], "x/y:free")
    assert "cota de hoje" in explain([gone, busy, quota], "x/y:free")
    assert explain([ModelFailure("other", True)], "x/y") == LLM_ERROR_REPLY
    assert explain([], "x/y") == LLM_ERROR_REPLY


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_tries_the_chosen_model_then_the_fallbacks() -> None:
    chain = ModelChain()
    assert chain.order("x/y:free") == ["x/y:free", *FALLBACK_MODELS]
    # A fallback chosen on purpose goes first, and isn't tried twice.
    assert chain.order(FALLBACK_MODELS[-1]) == [FALLBACK_MODELS[-1], *FALLBACK_MODELS[:-1]]


def test_leaves_out_a_retired_model_for_an_hour_and_a_busy_one_for_a_minute() -> None:
    clock = Clock()
    chain = ModelChain(clock)
    chain.failed("gone/model", ModelFailure("model", True))
    chain.failed(FALLBACK_MODELS[0], ModelFailure("busy", True))

    assert chain.order("gone/model") == list(FALLBACK_MODELS[1:])
    clock.now += 61
    assert chain.order("gone/model") == list(FALLBACK_MODELS)
    clock.now += 3600
    assert chain.order("gone/model") == ["gone/model", *FALLBACK_MODELS]


def test_a_failure_of_the_account_doesnt_rule_out_the_model() -> None:
    chain = ModelChain(Clock())
    chain.failed("x/y", ModelFailure("key", False))
    assert chain.order("x/y")[0] == "x/y"


def test_tries_everything_rather_than_nothing() -> None:
    chain = ModelChain(Clock())
    for model in ["x/y", *FALLBACK_MODELS]:
        chain.failed(model, ModelFailure("model", True))
    assert chain.order("x/y") == ["x/y", *FALLBACK_MODELS]


def _catalog(ids: list[str], calls: list[int], *, fail: bool = False, **kwargs) -> ModelCatalog:
    def answer(request: httpx.Request) -> httpx.Response:
        calls.append(1)
        assert request.url == "https://openrouter.ai/api/v1/models"
        if fail:
            return httpx.Response(503)
        return httpx.Response(200, json={"data": [{"id": model} for model in ids]})

    return ModelCatalog(
        "https://openrouter.ai/api/v1/", transport=httpx.MockTransport(answer), **kwargs
    )


async def test_the_catalog_knows_what_openrouter_offers() -> None:
    calls: list[int] = []
    catalog = _catalog(["openai/gpt-oss-120b", "x/y:free", "openrouter/free"], calls)

    assert await catalog.offers("x/y:free") is True
    assert await catalog.offers("openrouter/free") is True
    assert await catalog.offers("openai/gpt-oss-120b:nitro") is True  # a variant of a listed model
    assert await catalog.offers("openai/gpt-oss-120b:free") is False  # free ones are listed apart
    assert await catalog.offers("bogus/model") is False
    assert len(calls) == 1  # one fetch, kept


async def test_the_catalog_refetches_after_an_hour_and_shrugs_when_offline() -> None:
    calls: list[int] = []
    clock = Clock()
    catalog = _catalog(["x/y"], calls, clock=clock)
    await catalog.models()
    clock.now += 3601
    await catalog.models()
    assert len(calls) == 2

    offline = _catalog([], [], fail=True)
    assert await offline.offers("x/y") is None  # can't tell: nothing is refused
