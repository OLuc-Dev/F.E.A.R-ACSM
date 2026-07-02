from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass
from typing import Any

from fear.memory.embedding import LocalEmbedding


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
        embedding: LocalEmbedding | None = None,
    ) -> None:
        import chromadb

        self.path = path
        self.collection_name = collection_name
        # Share one embedder across stores when provided; otherwise make our own.
        self.embedding = embedding or LocalEmbedding()

        self._client = chromadb.PersistentClient(path=self.path)
        self._collection = self._client.get_or_create_collection(name=self.collection_name)

    def add_memory(self, text: str, speaker: str, source: str, user_id: str = "") -> str:
        """Store one memory (deduped by content) and return its id.

        When ``user_id`` is set the memory belongs to that user: it is stored
        under a user-scoped id and only surfaces in that user's queries. An empty
        ``user_id`` keeps the original single-user behaviour (and id shape).
        """
        clean_text = text.strip()
        if not clean_text:
            raise ValueError("text cannot be empty")

        now = time.time()
        # Content-addressed id: re-saying the same thing updates that entry in
        # place instead of piling up duplicates that later crowd out real recall.
        # The user prefix keeps two people who say the same thing separate.
        digest = hashlib.sha1(clean_text.encode("utf-8")).hexdigest()[:16]
        prefix = f"{user_id}-" if user_id else ""
        memory_id = f"{prefix}{speaker}-{source}-{digest}"
        metadata = {
            "speaker": speaker,
            "source": source,
            "timestamp": now,
            "user_id": user_id,
        }

        self._collection.upsert(
            ids=[memory_id],
            documents=[clean_text],
            embeddings=[self.embedding.embed(clean_text)],
            metadatas=[metadata],
        )

        return memory_id

    @staticmethod
    def _scope(user_id: str, speaker: str | None) -> dict[str, Any] | None:
        """Build a Chroma ``where`` filter from an optional user id + speaker.

        Chroma wants a single condition or an explicit ``$and`` of several, so
        this returns None (no filter), one condition, or the ``$and`` of both.
        """
        conditions: list[dict[str, Any]] = []
        if user_id:
            conditions.append({"user_id": user_id})
        if speaker:
            conditions.append({"speaker": speaker})
        if not conditions:
            return None
        if len(conditions) == 1:
            return conditions[0]
        return {"$and": conditions}

    def forget(self, memory_id: str) -> bool:
        """Delete a single memory by id; returns False for a blank id."""
        if not memory_id:
            return False
        self._collection.delete(ids=[memory_id])
        return True

    def claim_unowned(self, user_id: str) -> int:
        """Attach every un-owned memory (no user_id) to a user; return the count.

        A one-time migration for memories created before accounts existed, so a
        user can keep the history F.E.A.R. already had for them.
        """
        if not user_id:
            return 0

        raw = self._collection.get(include=["metadatas"])
        ids = raw.get("ids", []) or []
        metadatas = raw.get("metadatas", []) or []

        claim_ids: list[str] = []
        claim_metadatas: list[dict[str, Any]] = []
        for index, memory_id in enumerate(ids):
            metadata = dict(metadatas[index] or {}) if index < len(metadatas) else {}
            if not metadata.get("user_id"):
                metadata["user_id"] = user_id
                claim_ids.append(str(memory_id))
                claim_metadatas.append(metadata)

        if claim_ids:
            self._collection.update(ids=claim_ids, metadatas=claim_metadatas)
        return len(claim_ids)

    def query_memories(
        self,
        query: str,
        n_results: int = 5,
        filter_by_speaker: str | None = None,
        user_id: str = "",
    ) -> list[PersonalMemoryResult]:
        """Search memories by semantic similarity, optionally scoped to a user."""
        if not query.strip():
            return []

        raw = self._collection.query(
            query_embeddings=[self.embedding.embed(query)],
            n_results=n_results,
            where=self._scope(user_id, filter_by_speaker),
        )

        return self._format_results(raw)

    def get_facts_about_speaker(
        self, speaker: str, n_results: int = 10, user_id: str = ""
    ) -> list[PersonalMemoryResult]:
        """Return the most recent memories from a speaker, optionally scoped to a user."""
        return self._recent(self._scope(user_id, speaker), n_results)

    def recent_for_user(self, user_id: str, n_results: int = 20) -> list[PersonalMemoryResult]:
        """Return all of a user's memories (any speaker), newest first.

        Powers the memory inspector, where a signed-in user should see everything
        they've told F.E.A.R. regardless of the speaker label on each entry.
        """
        return self._recent(self._scope(user_id, None), n_results)

    def _recent(self, where: dict[str, Any] | None, n_results: int) -> list[PersonalMemoryResult]:
        # Fetch the matching memories, then sort by timestamp and take the
        # newest. Applying a Chroma `limit` before sorting would return an
        # arbitrary subset rather than the most recent facts.
        raw = self._collection.get(where=where, include=["documents", "metadatas"])

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
