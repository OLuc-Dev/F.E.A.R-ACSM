from __future__ import annotations

from fear.library.reference_library import ReferenceLibrary

# _scope builds the Chroma `where` filter and is pure, so it is tested directly
# without constructing ReferenceLibrary (which would need chromadb).


def test_scope_is_none_without_owner_or_source() -> None:
    assert ReferenceLibrary._scope("", None) is None


def test_scope_by_source_only() -> None:
    assert ReferenceLibrary._scope("", "Manifesto") == {"source": "Manifesto"}


def test_scope_by_owner_only() -> None:
    assert ReferenceLibrary._scope("u1", None) == {"user_id": "u1"}


def test_scope_by_owner_and_source_uses_and() -> None:
    assert ReferenceLibrary._scope("u1", "Manifesto") == {
        "$and": [{"user_id": "u1"}, {"source": "Manifesto"}]
    }
