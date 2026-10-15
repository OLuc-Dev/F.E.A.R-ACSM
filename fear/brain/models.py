"""Which OpenRouter model answers, and what F.E.A.R. says when none can.

OpenRouter retires models without warning, the free ones above all, and a
retired model fails every reply sent to it. So a reply never rests on one model:
the chosen one is tried first, then FALLBACK_MODELS, ending with openrouter/free
(OpenRouter's router over whatever free models exist that day). Each failure is
read for what it means to the person, so F.E.A.R. can say it plainly instead of
"something went wrong".
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

import httpx
import openai

logger = logging.getLogger(__name__)

# After the chosen model: a free one served by the lab that made it, then
# OpenRouter's free router, which picks among whatever free models are up.
FALLBACK_MODELS = ("nvidia/nemotron-3-super-120b-a12b:free", "openrouter/free")

# A model OpenRouter doesn't have is skipped for an hour; an overloaded one,
# for a minute. A reply never waits on a model known to be failing.
_GONE_FOR_S = 3600.0
_BUSY_FOR_S = 60.0

# Shown to the user when a model call fails for no reason worth explaining.
LLM_ERROR_REPLY = "Tive um problema para processar isso agora. Tenta de novo em instantes."

FailureKind = Literal[
    "key", "key_limit", "credits", "free_quota", "privacy", "model", "busy", "network", "other"
]

# What F.E.A.R. says when no model answers, by why the last one didn't.
_REPLIES: dict[FailureKind, str] = {
    "key": (
        "O OpenRouter recusou a sua chave. Abra sua conta no ícone de pessoa, lá em cima, "
        "e cole uma chave nova: você gera uma em openrouter.ai/keys."
    ),
    "key_limit": (
        "A sua chave do OpenRouter chegou ao limite de gastos dela. Aumente o limite em "
        "openrouter.ai/keys, ou cole outra chave na sua conta."
    ),
    "credits": (
        "A sua conta do OpenRouter está sem créditos para o modelo {model}. Escolha um modelo "
        "grátis, dos que terminam em :free, em Configurações, na aba Comportamento, ou coloque "
        "créditos no OpenRouter."
    ),
    "free_quota": (
        "Acabou a cota de hoje dos modelos grátis do OpenRouter: são 50 mensagens por dia, ou mil "
        "para quem já colocou 10 dólares de créditos. Amanhã ela volta."
    ),
    "privacy": (
        "O OpenRouter está bloqueando os modelos grátis pela sua configuração de privacidade. "
        "Em openrouter.ai/settings/privacy, libere os modelos grátis e fale comigo de novo."
    ),
    "model": (
        "O modelo {model} não está disponível no OpenRouter agora. Escolha outro em "
        "Configurações, na aba Comportamento."
    ),
    "busy": "Os modelos do OpenRouter estão sobrecarregados agora. Tenta de novo em instantes.",
    "network": "Não consegui falar com o OpenRouter. Confira a internet e tenta de novo.",
    "other": LLM_ERROR_REPLY,
}


@dataclass(frozen=True)
class ModelFailure:
    kind: FailureKind
    # Another model may still answer: the key, the account and the network are fine.
    try_another: bool


EMPTY_REPLY = ModelFailure("other", try_another=True)


def classify(error: Exception) -> ModelFailure:
    """What a failed OpenRouter call means for the person."""
    if isinstance(error, openai.APIConnectionError):  # timeouts included
        return ModelFailure("network", try_another=False)
    text = str(error).lower()
    status = getattr(error, "status_code", None)
    # The account's settings and quotas hold for every free model alike.
    if "data policy" in text or "settings/privacy" in text:
        return ModelFailure("privacy", try_another=False)
    if "free-models-per-day" in text:
        return ModelFailure("free_quota", try_another=False)
    if status == 401:
        return ModelFailure("key", try_another=False)
    if status == 402 or "insufficient credits" in text:
        return ModelFailure("credits", try_another=True)  # the free ones need none
    if status == 403 and "limit" in text:
        return ModelFailure("key_limit", try_another=False)
    if (
        status == 404
        or "not a valid model" in text
        or "no endpoints found" in text
        or "model not found" in text
    ):
        return ModelFailure("model", try_another=True)
    if status == 429 or (isinstance(status, int) and status >= 500):
        return ModelFailure("busy", try_another=True)
    return ModelFailure("other", try_another=True)


def explain(failures: list[ModelFailure], chosen: str) -> str:
    """What to tell the person once no model answered: what stopped the search,
    or else what happened to the model they chose."""
    if not failures:
        return LLM_ERROR_REPLY
    stopped = next((failure for failure in failures if not failure.try_another), None)
    return _REPLIES[(stopped or failures[0]).kind].format(model=chosen)


class ModelChain:
    """The models to try for a reply, in order, leaving out those failing lately."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._skip_until: dict[str, float] = {}

    def order(self, chosen: str) -> list[str]:
        models = list(dict.fromkeys([chosen, *FALLBACK_MODELS]))
        now = self._clock()
        ready = [model for model in models if self._skip_until.get(model, 0.0) <= now]
        return ready or models  # all failing lately: better to try than to give up

    def failed(self, model: str, failure: ModelFailure) -> None:
        logger.warning("OpenRouter model %s failed: %s", model, failure.kind)
        if failure.kind == "model":
            self._skip_until[model] = self._clock() + _GONE_FOR_S
        elif failure.kind == "busy":
            self._skip_until[model] = self._clock() + _BUSY_FOR_S


class ModelCatalog:
    """The models OpenRouter offers right now: its public list, kept for an hour."""

    def __init__(
        self,
        base_url: str,
        *,
        keep_for: float = 3600.0,
        clock: Callable[[], float] = time.monotonic,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.url = base_url.rstrip("/") + "/models"
        self.keep_for = keep_for
        self._clock = clock
        self._transport = transport
        self._models: frozenset[str] | None = None
        self._fetched_at = 0.0

    async def models(self) -> frozenset[str] | None:
        """Every model id on offer, or None when the list can't be had (offline)."""
        if self._models is not None and self._clock() - self._fetched_at < self.keep_for:
            return self._models
        try:
            async with httpx.AsyncClient(timeout=8.0, transport=self._transport) as client:
                response = await client.get(self.url)
                response.raise_for_status()
                listed = frozenset(item["id"] for item in response.json()["data"])
        except Exception as exc:
            logger.warning("Couldn't read OpenRouter's model list: %s", exc)
            return self._models  # the last list known, if any
        self._models, self._fetched_at = listed, self._clock()
        return listed

    async def offers(self, model: str) -> bool | None:
        """Whether OpenRouter has `model` (None: can't tell right now)."""
        models = await self.models()
        if models is None:
            return None
        if model in models:
            return True
        # Variants like :nitro or :online route the listed model; :free ones are
        # listed on their own, so a :free not in the list is gone.
        base, _, variant = model.partition(":")
        return bool(variant) and variant != "free" and base in models
