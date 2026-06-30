from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class PersonalMemoryResult:
    """A memory retrieved from the personal memory store."""

    text: str
    speaker: str
    source: str
    timestamp: float
    id: str = ""
    distance: float | None = None
    metadata: dict[str, Any] | None = None


class SentenceTransformerEmbedding:
    """Embedding adapter using sentence-transformers/all-MiniLM-L6-v2."""

    def __init__(self, model_name: str = "sentence-transformers/all-MiniLM-L6-v2") -> None:
        # Imported lazily so the conversational core can be imported and tested
        # without pulling in sentence-transformers / torch.
        from sentence_transformers import SentenceTransformer

        self.model_name = model_name
        self._model = SentenceTransformer(model_name)

    def embed(self, text: str) -> list[float]:
        """Return an embedding vector for a single text."""
        return self._model.encode(text, normalize_embeddings=True).tolist()

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        """Return embedding vectors for multiple texts."""
        return self._model.encode(texts, normalize_embeddings=True).tolist()


class PersonalMemory:
    """
    Persistent personal memory backed by ChromaDB.

    Stores important statements with speaker, timestamp, and source metadata.
    Sources can be voice, obsidian, web, manual, or another local integration.
    """

    def __init__(
        self,
        *,
        path: str = "data/chroma",
        collection_name: str = "personal_memory",
        embedding_model_name: str = "sentence-transformers/all-MiniLM-L6-v2",
    ) -> None:
        import chromadb

        self.path = path
        self.collection_name = collection_name
        self.embedding = SentenceTransformerEmbedding(embedding_model_name)

        self._client = chromadb.PersistentClient(path=self.path)
        self._collection = self._client.get_or_create_collection(name=self.collection_name)

    def add_memory(self, text: str, speaker: str, source: str) -> str:
        """Store one memory (deduped by content) and return its id."""
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("text cannot be empty")

        now = time.time()
        # Content-addressed id: re-saying the same thing updates that entry in
        # place instead of piling up duplicates that later crowd out real recall.
        digest = hashlib.sha1(clean_text.encode("utf-8")).hexdigest()[:16]
        memory_id = f"{speaker}-{source}-{digest}"
        metadata = {
            "speaker": speaker,
            "source": source,
            "timestamp": now,
        }

        self._collection.upsert(
            ids=[memory_id],
            documents=[clean_text],
            embeddings=[self.embedding.embed(clean_text)],
            metadatas=[metadata],
        )

        return memory_id

    def forget(self, memory_id: str) -> bool:
        """Delete a single memory by id; returns False for a blank id."""
        if not memory_id:
            return False
        self._collection.delete(ids=[memory_id])
        return True

    def query_memories(
        self,
        query: str,
        n_results: int = 5,
        filter_by_speaker: str | None = None,
    ) -> list[PersonalMemoryResult]:
        """Search memories by semantic similarity."""
        if not query.strip():
            return []

        where = {"speaker": filter_by_speaker} if filter_by_speaker else None
        raw = self._collection.query(
            query_embeddings=[self.embedding.embed(query)],
            n_results=n_results,
            where=where,
        )

        return self._format_results(raw)

    def get_facts_about_speaker(
        self, speaker: str, n_results: int = 10
    ) -> list[PersonalMemoryResult]:
        """Return the most recent memories from a specific speaker."""
        # Fetch all of the speaker's memories, then sort by timestamp and take
        # the newest. Applying a Chroma `limit` before sorting would return an
        # arbitrary subset rather than the most recent facts.
        raw = self._collection.get(
            where={"speaker": speaker},
            include=["documents", "metadatas"],
        )

        documents = raw.get("documents", []) or []
        metadatas = raw.get("metadatas", []) or []
        ids = raw.get("ids", []) or []
        results: list[PersonalMemoryResult] = []

        for index, document in enumerate(documents):
            metadata = metadatas[index] if index < len(metadatas) else {}
            memory_id = str(ids[index]) if index < len(ids) else ""
            results.append(self._result_from_document(str(document), metadata, None, memory_id))

        results.sort(key=lambda item: item.timestamp, reverse=True)
        return results[:n_results]

    def _format_results(self, raw: dict[str, Any]) -> list[PersonalMemoryResult]:
        documents = raw.get("documents", [[]])[0] or []
        metadatas = raw.get("metadatas", [[]])[0] or []
        distances = raw.get("distances", [[]])[0] or []
        ids = raw.get("ids", [[]])[0] or []

        results: list[PersonalMemoryResult] = []
        for index, document in enumerate(documents):
            metadata = metadatas[index] if index < len(metadatas) else {}
            distance = distances[index] if index < len(distances) else None
            memory_id = str(ids[index]) if index < len(ids) else ""
            results.append(self._result_from_document(str(document), metadata, distance, memory_id))

        return results

    @staticmethod
    def _result_from_document(
        document: str,
        metadata: dict[str, Any] | None,
        distance: float | None,
        memory_id: str = "",
    ) -> PersonalMemoryResult:
        metadata = metadata or {}
        return PersonalMemoryResult(
            text=document,
            speaker=str(metadata.get("speaker", "unknown")),
            source=str(metadata.get("source", "unknown")),
            timestamp=float(metadata.get("timestamp", 0.0)),
            id=memory_id,
            distance=distance,
            metadata=metadata,
        )


if __name__ == "__main__":
    memory = PersonalMemory()
    memory.add_memory("I like calm desktop assistants.", speaker="user", source="voice")
    for item in memory.query_memories("assistant preferences", filter_by_speaker="user"):
        print(item.speaker, item.source, item.text)
