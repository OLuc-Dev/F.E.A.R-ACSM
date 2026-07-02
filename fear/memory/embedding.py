from __future__ import annotations

from typing import Any


class LocalEmbedding:
    """CPU text embeddings via ChromaDB's bundled ONNX MiniLM (all-MiniLM-L6-v2).

    No PyTorch — light enough for a small server — and meant to be shared across
    the memory stores so the model loads once. Same model family as before, so
    vectors stay compatible with data that was already indexed.
    """

    def __init__(self) -> None:
        # Imported lazily so importing this module (and the memory modules that
        # depend on it) does not require chromadb/onnxruntime — keeps the app
        # importable and unit-testable without the ML stack.
        from chromadb.utils import embedding_functions

        self._embed = embedding_functions.ONNXMiniLM_L6_V2()

    def embed(self, text: str) -> list[float]:
        """Return the embedding vector for a single text."""
        return self._as_floats(self._embed([text])[0])

    def embed_many(self, texts: list[str]) -> list[list[float]]:
        """Return embedding vectors for a batch of texts."""
        return [self._as_floats(vector) for vector in self._embed(list(texts))]

    @staticmethod
    def _as_floats(vector: Any) -> list[float]:
        # Chroma embedding functions may hand back numpy arrays or plain lists;
        # normalize to a list of floats either way.
        if hasattr(vector, "tolist"):
            return list(vector.tolist())
        return [float(value) for value in vector]
