"""Real ChromaDB integration tests for PersonalMemory and ReferenceLibrary.

These exercise the actual Chroma layer — collections, metadata, `where`
filters, upsert dedup, delete, and per-user scope — so CI catches real
regressions (Chroma API breaks, user_id leaks, broken dedup/delete, search
returning the wrong thing).

To stay fast and offline, the stores are fed a *deterministic* 384-dim embedder
(pure Python, no model, no download): identical text -> identical vector, so an
exact-text query is the nearest neighbour and user isolation is proven purely by
the metadata filter. The real ONNX embedder is exercised only by an opt-in smoke
test (it downloads a model), guarded by FEAR_TEST_ONNX.

chromadb is a backend runtime dependency and is installed in CI, so these run in
the standard `pytest -q`. The importorskip is only a graceful guard for minimal
local envs without chromadb.
"""

from __future__ import annotations

import hashlib
import math
import os
import random
import time

import pytest

pytest.importorskip("chromadb")

from fear.library.reference_library import ReferenceLibrary  # noqa: E402
from fear.memory.personal_memory import PersonalMemory  # noqa: E402

EMBED_DIM = 384


class DeterministicEmbedding:
    """A stable, ML-free stand-in for LocalEmbedding: text -> fixed 384-dim unit
    vector. Same text always yields the same vector (so exact-text queries match
    exactly); different text yields a different, ~orthogonal vector."""

    def embed(self, text: str) -> list[float]:
        return self._vector(text)

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        return [self._vector(text) for text in texts]

    @staticmethod
    def _vector(text: str) -> list[float]:
        rng = random.Random(hashlib.sha256(text.encode("utf-8")).hexdigest())
        values = [rng.uniform(-1.0, 1.0) for _ in range(EMBED_DIM)]
        norm = math.sqrt(sum(value * value for value in values)) or 1.0
        return [value / norm for value in values]


@pytest.fixture
def embedder() -> DeterministicEmbedding:
    return DeterministicEmbedding()


@pytest.fixture
def memory(tmp_path, embedder: DeterministicEmbedding) -> PersonalMemory:
    # Own temp dir + collection per test -> full isolation, auto-cleaned.
    return PersonalMemory(path=str(tmp_path / "mem_db"), collection_name="mem", embedding=embedder)


@pytest.fixture
def library(tmp_path, embedder: DeterministicEmbedding) -> ReferenceLibrary:
    return ReferenceLibrary(
        path=str(tmp_path / "ref_db"), collection_name="ref", embedding=embedder
    )


# --- PersonalMemory ---------------------------------------------------------


def test_insert_and_search(memory: PersonalMemory) -> None:
    text = "Lucas prefere interfaces escuras e minimalistas"
    memory.add_memory(text, speaker="Lucas", source="conversation", user_id="A")

    results = memory.query_memories(text, n_results=3, user_id="A")

    assert results and results[0].text == text


def test_user_isolation_in_search(memory: PersonalMemory) -> None:
    shared = "gosto de café bem forte de manhã"
    memory.add_memory(shared, speaker="Ana", source="conversation", user_id="A")
    memory.add_memory(shared, speaker="Bruno", source="conversation", user_id="B")

    as_a = memory.query_memories(shared, n_results=5, user_id="A")
    as_b = memory.query_memories(shared, n_results=5, user_id="B")

    assert [r.speaker for r in as_a] == ["Ana"]  # only A's, despite identical text
    assert [r.speaker for r in as_b] == ["Bruno"]


def test_dedup_upsert(memory: PersonalMemory) -> None:
    text = "a mesma ideia dita duas vezes"
    id1 = memory.add_memory(text, speaker="Ana", source="conversation", user_id="A")
    id2 = memory.add_memory(text, speaker="Ana", source="conversation", user_id="A")
    memory.add_memory("uma ideia diferente", speaker="Ana", source="conversation", user_id="A")

    assert id1 == id2  # content-addressed id -> upsert in place
    assert len(memory.recent_for_user("A")) == 2  # deduped, plus the distinct one


def test_forget_is_scoped(memory: PersonalMemory) -> None:
    id_a = memory.add_memory("memória da Ana", speaker="Ana", source="conversation", user_id="A")
    memory.add_memory("memória do Bruno", speaker="Bruno", source="conversation", user_id="B")

    assert memory.forget(id_a) is True

    assert memory.recent_for_user("A") == []  # gone for A
    assert [r.text for r in memory.recent_for_user("B")] == ["memória do Bruno"]  # B intact


def test_recent_for_user_scope_order_and_limit(memory: PersonalMemory) -> None:
    for index in range(3):
        memory.add_memory(f"nota A {index}", speaker="Ana", source="conversation", user_id="A")
        time.sleep(0.005)  # keep timestamps distinct for the ordering assertion
    memory.add_memory("nota do Bruno", speaker="Bruno", source="conversation", user_id="B")

    recent = memory.recent_for_user("A")
    assert [r.text for r in recent] == ["nota A 2", "nota A 1", "nota A 0"]  # newest first, only A
    assert len(memory.recent_for_user("A", n_results=2)) == 2  # limit honored


def test_claim_unowned(memory: PersonalMemory) -> None:
    memory.add_memory("nota legada sem dono", speaker="x", source="conversation")  # user_id=""
    memory.add_memory("nota do Bruno", speaker="Bruno", source="conversation", user_id="B")

    claimed = memory.claim_unowned("A")

    assert claimed == 1
    assert [r.text for r in memory.recent_for_user("A")] == ["nota legada sem dono"]
    assert [r.text for r in memory.recent_for_user("B")] == ["nota do Bruno"]  # not stolen


def test_forget_for_user_deletes_own_memory(memory: PersonalMemory) -> None:
    mid = memory.add_memory("memória da Ana", speaker="Ana", source="conversation", user_id="A")

    assert memory.forget_for_user(mid, "A") is True
    assert memory.recent_for_user("A") == []


def test_forget_for_user_deletes_claimed_memory(memory: PersonalMemory) -> None:
    # The bug this PR fixes: a memory created before accounts keeps its old,
    # prefix-less id; claim_unowned only sets metadata.user_id. It must still be
    # deletable by its new owner.
    legacy_id = memory.add_memory("nota legada", speaker="x", source="conversation")  # user_id=""
    memory.claim_unowned("A")
    assert not legacy_id.startswith("A-")  # id was NOT rewritten by the claim

    assert memory.forget_for_user(legacy_id, "A") is True
    assert memory.recent_for_user("A") == []


def test_forget_for_user_refuses_another_users_memory(memory: PersonalMemory) -> None:
    mid_b = memory.add_memory(
        "memória do Bruno", speaker="Bruno", source="conversation", user_id="B"
    )

    assert memory.forget_for_user(mid_b, "A") is False  # A cannot delete B's
    assert [r.text for r in memory.recent_for_user("B")] == ["memória do Bruno"]  # intact


def test_forget_for_user_refuses_unowned_and_missing(memory: PersonalMemory) -> None:
    legacy_id = memory.add_memory("nota sem dono", speaker="x", source="conversation")  # user_id=""

    assert memory.forget_for_user(legacy_id, "A") is False  # unowned -> not deletable
    assert memory.forget_for_user("no-such-id", "A") is False  # missing -> False
    # The unowned memory is untouched (still claimable/visible once owned).
    memory.claim_unowned("A")
    assert [r.text for r in memory.recent_for_user("A")] == ["nota sem dono"]


def test_recent_for_user_can_exclude_assistant_replies(memory: PersonalMemory) -> None:
    memory.add_memory("o que o usuário disse", speaker="Ana", source="conversation", user_id="A")
    memory.add_memory(
        "o que o F.E.A.R. respondeu", speaker="fear", source="assistant_reply", user_id="A"
    )

    with_replies = memory.recent_for_user("A", include_assistant_replies=True)
    without_replies = memory.recent_for_user("A", include_assistant_replies=False)

    assert {r.source for r in with_replies} == {"conversation", "assistant_reply"}
    assert [r.source for r in without_replies] == ["conversation"]  # replies dropped


def test_exclusion_happens_before_the_limit(memory: PersonalMemory) -> None:
    # Newer assistant_reply entries must not consume the window: excluding them
    # first should still surface the older, useful conversation memory.
    memory.add_memory("lembrança útil", speaker="Ana", source="conversation", user_id="A")
    time.sleep(0.005)
    for index in range(3):
        memory.add_memory(
            f"resposta {index}", speaker="fear", source="assistant_reply", user_id="A"
        )
        time.sleep(0.005)

    kept = memory.recent_for_user("A", n_results=2, include_assistant_replies=False)

    assert [r.text for r in kept] == ["lembrança útil"]  # survived despite newer replies


# --- ReferenceLibrary -------------------------------------------------------


def test_index_and_list(library: ReferenceLibrary) -> None:
    library.index_text("conteúdo de referência sobre o projeto", source="Manifesto", user_id="A")

    sources = library.list_sources("A")

    assert [s["source"] for s in sources] == ["Manifesto"]


def test_retrieve_real(library: ReferenceLibrary) -> None:
    text = "o núcleo do produto é a memória persistente"
    library.index_text(text, source="Notas", user_id="A")

    hits = library.retrieve(text, n_results=2, user_id="A")

    assert hits and hits[0].source == "Notas"


def test_knowledge_user_isolation(library: ReferenceLibrary) -> None:
    text = "mesmo trecho de conhecimento"
    library.index_text(text, source="DocA", user_id="A")
    library.index_text(text, source="DocB", user_id="B")

    as_a = library.retrieve(text, n_results=5, user_id="A")
    as_b = library.retrieve(text, n_results=5, user_id="B")

    assert as_a and {h.source for h in as_a} == {"DocA"}  # never B's
    assert as_b and {h.source for h in as_b} == {"DocB"}


def test_listing_respects_user(library: ReferenceLibrary) -> None:
    library.index_text("algo do A", source="DocA", user_id="A")
    library.index_text("algo do B", source="DocB", user_id="B")

    assert [s["source"] for s in library.list_sources("A")] == ["DocA"]
    assert [s["source"] for s in library.list_sources("B")] == ["DocB"]


def test_delete_is_scoped(library: ReferenceLibrary) -> None:
    library.index_text("algo do A", source="DocA", user_id="A")
    library.index_text("algo do B", source="DocB", user_id="B")

    assert library.delete_source("DocA", "A") > 0
    assert library.delete_source("DocA", "B") == 0  # B never had DocA

    assert library.list_sources("A") == []
    assert library.retrieve("algo do A", n_results=5, user_id="A") == []
    assert [s["source"] for s in library.list_sources("B")] == ["DocB"]  # B intact


def test_chunking_and_metadata(library: ReferenceLibrary) -> None:
    para1 = "Alpha. " + ("sobre estratégia e produto " * 25)  # > 80 chars
    para2 = "Beta. " + ("sobre execução e prazos " * 25)
    big = f"{para1}\n\n{para2}"

    chunks = library.index_text(big, source="Livro", user_id="A")
    assert chunks >= 2  # the long, two-paragraph text is split

    hits = library.retrieve(para2.strip(), n_results=3, user_id="A")
    assert hits and hits[0].source == "Livro"
    assert (hits[0].metadata or {}).get("user_id") == "A"  # metadata preserved


# --- ONNX embedder smoke (opt-in; downloads a model) ------------------------


@pytest.mark.skipif(
    not os.getenv("FEAR_TEST_ONNX"),
    reason="opt-in: LocalEmbedding downloads the ONNX model; set FEAR_TEST_ONNX=1 to run",
)
def test_local_embedding_onnx_smoke() -> None:
    from fear.memory.embedding import LocalEmbedding

    vector = LocalEmbedding().embed("uma frase simples")

    assert len(vector) == EMBED_DIM
    assert all(isinstance(value, float) for value in vector)
