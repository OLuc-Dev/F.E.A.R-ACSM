"""Download the embedding model into packaging/build so the installer ships it.

Without this, every new install would download ~80 MB on its first message.
"""

from __future__ import annotations

import shutil
from pathlib import Path

from chromadb.utils.embedding_functions import ONNXMiniLM_L6_V2

TARGET = Path(__file__).resolve().parent / "build" / "onnx_models" / ONNXMiniLM_L6_V2.MODEL_NAME


def main() -> None:
    shutil.rmtree(TARGET, ignore_errors=True)
    embedder = ONNXMiniLM_L6_V2()
    embedder.DOWNLOAD_PATH = TARGET
    vector = embedder(["F.E.A.R."])[0]
    assert len(vector) == 384, "unexpected embedding size"
    # The archive is only the download format; the extracted model is what loads.
    (TARGET / embedder.ARCHIVE_FILENAME).unlink(missing_ok=True)
    print(f"model ready in {TARGET}")


if __name__ == "__main__":
    main()
