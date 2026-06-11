from __future__ import annotations

import hashlib
import math
import time
from dataclasses import dataclass
from typing import Any, Iterable, List, Optional

import chromadb


@dataclass(slots=True)
class MemoryResult:
    """A single memory search result."""

    document: str
    distance: Optional[float] = None
    metadata: Optional[dict[str, Any]] = None


class HashEmbedding:
    """
    Tiny local embedding fallback for development.

    This is not as semantically powerful as a real embedding model, but it lets
    F.E.A.R. keep a vector-style memory loop working without a paid API key.
    Later, replace this with OpenRouter embeddings, sentence-transformers, or
    another local embedding model.
    """

    def __init__(self, dimensions: int = 384) -> None:
        if dimensions <= 0:
            raise ValueError("dimensions must be positive")

        self.dimensions = dimensions

    def embed(self, text: str) -> list[float]:
        """Create a normalized hashing-vector embedding for text."""
        vector = [0.0] * self.dimensions

        for token in self._tokens(text):
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimensions
            sign = 1.0 if digest[4] % 2 == 0 else -1.0
            vector[index] += sign

        norm = math.sqrt(sum(value * value for value in vector))
        if norm == 0.0:
            return vector

        return [value / norm for value in vector]

    def embed_many(self, texts: Iterable[str]) -> list[list[float]]:
        """Embed multiple texts."""
        return [self.embed(text) for text in texts]

    @staticmethod
    def _tokens(text: str) -> list[str]:
        """Simple tokenization suitable for the local fallback."""
        return [token.strip().lower() for token in text.split() if token.strip()]


class VectorMemoryStore:
    """Persistent ChromaDB-backed memory store."""

    def __init__(
        self,
        *,
        path: str = "data/chroma",
        collection_name: str = "fear_memory",
        embedding: Optional[HashEmbedding] = None,
    ) -> None:
        self.path = path
        self.collection_name = collection_name
        self.embedding = embedding or HashEmbedding()

        self._client = chromadb.PersistentClient(path=self.path)
        self._collection = self._client.get_or_create_collection(
            name=self.collection_name,
        )

    def remember(self, text: str, *, metadata: Optional[dict[str, Any]] = None) -> str:
        """Store text and return the generated memory id."""
        if not text.strip():
            raise ValueError("text cannot be empty")

        memory_id = f"memory-{time.time_ns()}"
        full_metadata = {"created_at": time.time()}

        if metadata:
            full_metadata.update(metadata)

        self._collection.add(
            ids=[memory_id],
            documents=[text],
            embeddings=[self.embedding.embed(text)],
            metadatas=[full_metadata],
        )

        return memory_id

    def search(self, query: str, *, n_results: int = 3) -> list[MemoryResult]:
        """Search for memories related to a query."""
        if not query.strip():
            return []

        raw = self._collection.query(
            query_embeddings=[self.embedding.embed(query)],
            n_results=n_results,
        )

        documents: List[str] = raw.get("documents", [[]])[0] or []
        distances: list[float] = raw.get("distances", [[]])[0] or []
        metadatas: list[dict[str, Any]] = raw.get("metadatas", [[]])[0] or []

        results: list[MemoryResult] = []

        for index, document in enumerate(documents):
            results.append(
                MemoryResult(
                    document=str(document),
                    distance=distances[index] if index < len(distances) else None,
                    metadata=metadatas[index] if index < len(metadatas) else None,
                )
            )

        return results

    def search_as_context(self, query: str, *, n_results: int = 3) -> str:
        """Return search results as a compact context string for the LLM."""
        results = self.search(query, n_results=n_results)
        return "\n".join(result.document for result in results)
