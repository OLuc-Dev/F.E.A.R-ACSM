from __future__ import annotations

from fear.memory.personal_memory import PersonalMemory

# _scope builds the Chroma `where` filter and is pure, so it is tested directly
# without constructing PersonalMemory (which would need chromadb).


def test_scope_is_none_without_user_or_speaker() -> None:
    assert PersonalMemory._scope("", None) is None


def test_scope_by_speaker_only() -> None:
    assert PersonalMemory._scope("", "Lucas") == {"speaker": "Lucas"}


def test_scope_by_user_only() -> None:
    assert PersonalMemory._scope("u1", None) == {"user_id": "u1"}


def test_scope_by_user_and_speaker_uses_and() -> None:
    assert PersonalMemory._scope("u1", "Lucas") == {
        "$and": [{"user_id": "u1"}, {"speaker": "Lucas"}]
    }


# _owns decides delete permission purely from metadata + the caller's id, so it
# is tested directly (no chromadb) — the same reasoning as _scope above.


def test_owns_true_when_metadata_user_matches() -> None:
    assert PersonalMemory._owns({"user_id": "u1"}, "u1") is True


def test_owns_false_for_another_user() -> None:
    assert PersonalMemory._owns({"user_id": "u2"}, "u1") is False


def test_owns_false_for_unowned_memory() -> None:
    # A memory with no owner (single-user / never-claimed) is not deletable.
    assert PersonalMemory._owns({"user_id": ""}, "u1") is False
    assert PersonalMemory._owns({}, "u1") is False
    assert PersonalMemory._owns(None, "u1") is False


def test_owns_false_when_caller_has_no_id() -> None:
    # An empty caller id must never match anything (no accidental deletes).
    assert PersonalMemory._owns({"user_id": ""}, "") is False
    assert PersonalMemory._owns({"user_id": "u1"}, "") is False
