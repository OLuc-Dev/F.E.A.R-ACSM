from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fear.memory.embedding import LocalEmbedding


@dataclass(slots=True)
class ReferenceResult:
    """A retrieved excerpt from the local markdown reference library."""

    text: str
    source: str
    section: str
    distance: float | None = None
    metadata: dict[str, Any] | None = None


class ReferenceLibrary:
    """ChromaDB-backed retrieval store for local markdown notes and summaries."""

    def __init__(
        self,
        *,
        path: str = "data/chroma",
        collection_name: str = "reference_library",
        embedding: LocalEmbedding | None = None,
    ) -> None:
        # chromadb imported lazily so this module stays importable/testable
        # without the ML stack.
        import chromadb

        self.path = path
        self.collection_name = collection_name
        # Share one embedder across stores when provided; otherwise make our own.
        self._embedding = embedding or LocalEmbedding()
        self._client = chromadb.PersistentClient(path=self.path)
        self._collection = self._client.get_or_create_collection(name=self.collection_name)

    def index_folder(self, folder: str | Path, *, source: str) -> int:
        """Index all markdown files in a folder."""
        root = Path(folder).expanduser().resolve()
        if not root.exists():
            raise FileNotFoundError(str(root))

        total = 0
        for path in root.rglob("*.md"):
            total += self.index_file(path, source=source)

        return total

    def index_file(self, path: str | Path, *, source: str) -> int:
        """Index one markdown file."""
        file_path = Path(path).expanduser().resolve()
        section = file_path.stem.replace("_", " ").replace("-", " ")
        text = file_path.read_text(encoding="utf-8", errors="ignore")
        chunks = chunk_markdown(text)

        if not chunks:
            return 0

        ids = [f"ref-{source}-{section}-{index}" for index, _ in enumerate(chunks)]
        embeddings = self._embedding.embed_many(chunks)
        metadatas = [
            {"source": source, "section": section, "file_path": str(file_path)} for _ in chunks
        ]

        self._collection.upsert(
            ids=ids,
            documents=chunks,
            embeddings=embeddings,
            metadatas=metadatas,
        )

        return len(chunks)

    @staticmethod
    def _scope(user_id: str, source: str | None) -> dict[str, Any] | None:
        """Build a Chroma ``where`` filter from an optional owner + source name.

        Knowledge is per-user: an owned note only surfaces in that user's list
        and retrieval. An empty ``user_id`` keeps the original shared behaviour.
        """
        conditions: list[dict[str, Any]] = []
        if user_id:
            conditions.append({"user_id": user_id})
        if source:
            conditions.append({"source": source})
        if not conditions:
            return None
        if len(conditions) == 1:
            return conditions[0]
        return {"$and": conditions}

    def index_text(
        self, text: str, *, source: str, section: str = "nota", user_id: str = ""
    ) -> int:
        """Index a free-text knowledge snippet under a named source, owned by a user.

        Re-indexing the same ``source`` (for the same user) replaces its previous
        chunks, so a named source behaves like one editable document.
        """
        clean = text.strip()
        if not clean:
            return 0

        chunks = chunk_markdown(clean)
        if not chunks:
            # Short snippets fall below the chunker's minimum; keep them whole so
            # small notes still become searchable knowledge.
            chunks = [clean]

        # Replace this user's existing chunks for this source (edit semantics).
        self._collection.delete(where=self._scope(user_id, source))

        prefix = f"{user_id}-" if user_id else ""
        ids = [f"ref-{prefix}{source}-{index}" for index, _ in enumerate(chunks)]
        embeddings = self._embedding.embed_many(chunks)
        metadatas = [
            {"source": source, "section": section, "origin": "text", "user_id": user_id}
            for _ in chunks
        ]

        self._collection.upsert(
            ids=ids,
            documents=chunks,
            embeddings=embeddings,
            metadatas=metadatas,
        )

        return len(chunks)

    def list_sources(self, user_id: str = "") -> list[dict[str, Any]]:
        """Return a user's indexed sources with their chunk counts, sorted by name."""
        raw = self._collection.get(where=self._scope(user_id, None), include=["metadatas"])
        metadatas = raw.get("metadatas", []) or []

        counts: dict[str, int] = {}
        for metadata in metadatas:
            source = str((metadata or {}).get("source", "unknown"))
            counts[source] = counts.get(source, 0) + 1

        return [{"source": source, "chunks": count} for source, count in sorted(counts.items())]

    def delete_source(self, source: str, user_id: str = "") -> int:
        """Remove every chunk of a user's source; return how many were removed."""
        existing = self._collection.get(where=self._scope(user_id, source))
        ids = existing.get("ids", []) or []
        if ids:
            self._collection.delete(ids=ids)
        return len(ids)

    def retrieve(
        self, query: str, *, n_results: int = 3, source: str | None = None, user_id: str = ""
    ) -> list[ReferenceResult]:
        """Retrieve a user's relevant local reference notes."""
        if not query.strip():
            return []

        query_embedding = self._embedding.embed(query)
        raw = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=self._scope(user_id, source),
        )

        return self._format_results(raw)

    @staticmethod
    def _format_results(raw: dict[str, Any]) -> list[ReferenceResult]:
        documents = raw.get("documents", [[]])[0] or []
        metadatas = raw.get("metadatas", [[]])[0] or []
        distances = raw.get("distances", [[]])[0] or []

        results: list[ReferenceResult] = []
        for index, document in enumerate(documents):
            metadata = metadatas[index] if index < len(metadatas) else {}
            results.append(
                ReferenceResult(
                    text=str(document),
                    source=str(metadata.get("source", "unknown")),
                    section=str(metadata.get("section", "unknown")),
                    distance=distances[index] if index < len(distances) else None,
                    metadata=metadata,
                )
            )

        return results


def chunk_markdown(text: str, *, max_chars: int = 900, min_chars: int = 80) -> list[str]:
    """Split markdown text into retrieval chunks."""
    text = re.sub(r"^---\s*\n.*?\n---\s*\n", "", text, count=1, flags=re.DOTALL).strip()
    blocks = [" ".join(block.split()).strip() for block in re.split(r"\n\s*\n", text)]
    blocks = [block for block in blocks if block]

    chunks: list[str] = []
    current = ""

    for block in blocks:
        if len(current) + len(block) + 2 <= max_chars:
            current = f"{current}\n\n{block}".strip()
            continue

        if len(current) >= min_chars:
            chunks.append(current)
        current = block

    if len(current) >= min_chars:
        chunks.append(current)

    return chunks
