from __future__ import annotations

from pathlib import Path

from fear.runtime_state import load_runtime_config, save_runtime_config


def test_runtime_config_round_trip(tmp_path: Path) -> None:
    chroma_path = str(tmp_path / "chroma")

    assert load_runtime_config(chroma_path) == {}

    save_runtime_config(chroma_path, model="deepseek/deepseek-chat", persona_mode="sombrio")

    assert load_runtime_config(chroma_path) == {
        "model": "deepseek/deepseek-chat",
        "persona_mode": "sombrio",
    }


def test_runtime_config_ignores_corrupt_file(tmp_path: Path) -> None:
    (tmp_path / "runtime_config.json").write_text("not json", encoding="utf-8")
    assert load_runtime_config(str(tmp_path / "chroma")) == {}
