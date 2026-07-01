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
