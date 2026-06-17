from __future__ import annotations

from fear.library.reference_library import chunk_markdown


def test_chunk_markdown_skips_short_text() -> None:
    assert chunk_markdown("curto demais") == []


def test_chunk_markdown_strips_frontmatter() -> None:
    body = "palavra " * 20  # comfortably above the min length
    chunks = chunk_markdown("---\ntitle: secreto\n---\n\n" + body)

    assert len(chunks) == 1
    assert "secreto" not in chunks[0]
    assert "palavra" in chunks[0]


def test_chunk_markdown_merges_small_blocks() -> None:
    block = "palavra " * 15
    chunks = chunk_markdown(block + "\n\n" + block)

    assert len(chunks) == 1  # both blocks fit under max_chars, so they merge
