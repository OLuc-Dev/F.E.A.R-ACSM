from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import chromadb
from sentence_transformers import SentenceTransformer


@dataclass(slots=True)
class ReferenceResult:
    """A retrieved excerpt from the local markdown reference library."""

    text: str
    source: str
    section: str
    distance: Optional[float] = None
    metadata: Optional[dict[str, Any]] = None


class ReferenceLibrary:
    """ChromaDB-backed retrieval store for local markdown notes and summaries."""

    def __init__(
        self,
        *,
        path: str = "data/chroma",
        collection_name: str = "reference_library",
        embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
    ) -> None:
        self.path = path
        self.collection_name = collection_name
        self._embedding_model = SentenceTransformer(embedding_model_name)
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
        embeddings = self._embedding_model.encode(chunks, normalize_embeddings=True).tolist()
        metadatas = [
            {"source": source, "section": section, "file_path": str(file_path)}
            for _ in chunks
        ]

        self._collection.upsert(
            ids=ids,
            documents=chunks,
            embeddings=embeddings,
            metadatas=metadatas,
        )

        return len(chunks)

    def retrieve(self, query: str, *, n_results: int = 3, source: Optional[str] = None) -> list[ReferenceResult]:
        """Retrieve relevant local reference notes."""
        if not query.strip():
            return []

        where = {"source": source} if source else None
        query_embedding = self._embedding_model.encode(query, normalize_embeddings=True).tolist()
        raw = self._collection.query(
            query_embeddings=[query_embedding],
            n_results=n_results,
            where=where,
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
