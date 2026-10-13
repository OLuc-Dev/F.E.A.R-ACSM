"""Download the speech models into packaging/build/voice so the installer ships them.

Pinned to exact revisions and checked by SHA-256: the app always carries the
models it was tested with, and a corrupt download fails the build here instead
of breaking voice on someone's PC.

  voice/whisper-small/        faster-whisper "small" (speech recognition, MIT)
  voice/piper/                Piper pt-BR voice "cadu" (F.E.A.R.'s voice, CC0 data)
"""

from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download

TARGET = Path(__file__).resolve().parent / "build" / "voice"

WHISPER = {
    "repo": "Systran/faster-whisper-small",
    "revision": "536b0662742c02347bc0e980a01041f333bce120",
    "files": {
        "model.bin": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
        "config.json": None,
        "tokenizer.json": None,
        "vocabulary.txt": None,
    },
}
PIPER = {
    "repo": "rhasspy/piper-voices",
    "revision": "c10ece1aade47bb51c153c893d14e5bf8e5b7117",
    "folder": "pt/pt_BR/cadu/medium",
    "files": {
        "pt_BR-cadu-medium.onnx": "765f0809a6ea9035d4a6d0d008dbf8876e68b2dd32029312672fa8f405bdb535",
        "pt_BR-cadu-medium.onnx.json": None,
        "MODEL_CARD": None,
    },
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def _fetch(repo: str, revision: str, remote: str, local: Path, sha256: str | None) -> None:
    downloaded = Path(hf_hub_download(repo, remote, revision=revision))
    local.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(downloaded, local)
    if sha256 is not None and _sha256(local) != sha256:
        raise SystemExit(f"{local.name}: checksum mismatch, refusing to bundle it")
    print(f"  {local.relative_to(TARGET)}  {local.stat().st_size / 1e6:.1f} MB")


def main() -> None:
    shutil.rmtree(TARGET, ignore_errors=True)
    print("speech models ->", TARGET)
    for name, sha in WHISPER["files"].items():
        _fetch(WHISPER["repo"], WHISPER["revision"], name, TARGET / "whisper-small" / name, sha)
    for name, sha in PIPER["files"].items():
        remote = f"{PIPER['folder']}/{name}"
        _fetch(PIPER["repo"], PIPER["revision"], remote, TARGET / "piper" / name, sha)


if __name__ == "__main__":
    main()
