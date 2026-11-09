"""Ollama discovery for source launches, without contacting the service."""

from fear import config


def test_local_source_launch_discovers_ollama(monkeypatch) -> None:
    monkeypatch.setattr(config, "load_dotenv", lambda: None)
    monkeypatch.delenv("FEAR_OLLAMA_URL", raising=False)
    monkeypatch.setenv("FEAR_ENV", "local")
    assert config.Settings.from_env().ollama_url == "http://127.0.0.1:11434"


def test_explicit_ollama_url_and_opt_out_are_preserved(monkeypatch) -> None:
    monkeypatch.setattr(config, "load_dotenv", lambda: None)
    monkeypatch.setenv("FEAR_ENV", "local")
    for url in ("http://localhost:11435", ""):
        monkeypatch.setenv("FEAR_OLLAMA_URL", url)
        assert config.Settings.from_env().ollama_url == url


def test_production_does_not_enable_ollama_implicitly(monkeypatch) -> None:
    monkeypatch.setattr(config, "load_dotenv", lambda: None)
    monkeypatch.delenv("FEAR_OLLAMA_URL", raising=False)
    monkeypatch.setenv("FEAR_ENV", "production")
    assert config.Settings.from_env().ollama_url == ""
