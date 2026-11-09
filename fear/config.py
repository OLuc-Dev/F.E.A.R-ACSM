from __future__ import annotations

from dotenv import load_dotenv
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# Thinking Machines' Inkling, free, served by the lab itself; the single source
# of truth for the default chat model, reused by the /config endpoint to offer a
# "reset to default" option. If it goes away, fear.brain.models falls back.
DEFAULT_CHAT_MODEL = "thinkingmachines/inkling:free"


class Settings(BaseSettings):
    """Validated runtime configuration for the F.E.A.R. assistant.

    Construct with ``Settings.from_env()`` to load ``.env`` + the environment.
    A bare ``Settings()`` reads only the current process environment, which keeps
    it predictable in tests (where init kwargs override everything).
    """

    model_config = SettingsConfigDict(populate_by_name=True, extra="ignore")

    assistant_name: str = Field("F.E.A.R.", validation_alias="FEAR_ASSISTANT_NAME")

    host: str = Field("127.0.0.1", validation_alias="FEAR_HOST")
    port: int = Field(8765, validation_alias="FEAR_PORT", ge=1, le=65535)

    sample_rate: int = Field(16_000, validation_alias="FEAR_SAMPLE_RATE", gt=0)
    chunk_size: int = Field(1_024, validation_alias="FEAR_CHUNK_SIZE", gt=0)

    whisper_model_name: str = Field("base", validation_alias="WHISPER_MODEL")
    # Talking to F.E.A.R. through the app (faster-whisper + Piper, all local).
    # The STT model is a faster-whisper name ("small") or a folder; the Windows
    # app points both at the models it ships.
    stt_model: str = Field("small", validation_alias="FEAR_STT_MODEL")
    voice_language: str = Field("pt", validation_alias="FEAR_VOICE_LANGUAGE")
    piper_voice: str = Field("", validation_alias="FEAR_PIPER_VOICE")
    # Load both models at start (in the background) so the first command is quick.
    preload_voice: bool = Field(False, validation_alias="FEAR_PRELOAD_VOICE")
    # F.E.A.R. speaks with Microsoft's neural voice when there's internet (each
    # sentence goes to Microsoft), the local one otherwise; off: always local.
    online_voice: bool = Field(True, validation_alias="FEAR_ONLINE_VOICE")

    chroma_path: str = Field("data/chroma", validation_alias="CHROMA_PATH")

    # Deployment environment: local | development | test | production. Safe
    # default (local). In production a missing FEAR_SECRET_KEY is fatal at boot.
    env: str = Field("local", validation_alias="FEAR_ENV")

    # Multi-user accounts. The secret signs session tokens and encrypts each
    # user's stored OpenRouter key; keep it stable and private in production. An
    # empty value makes the server mint an ephemeral one (fine for local dev,
    # but logins and stored keys then reset on every restart — and it is refused
    # outright in production).
    secret_key: str = Field("", validation_alias="FEAR_SECRET_KEY")
    users_db_path: str = Field("data/users.db", validation_alias="FEAR_USERS_DB")
    session_max_age_days: int = Field(30, validation_alias="FEAR_SESSION_MAX_AGE_DAYS", ge=1)
    # When set, /auth/register requires this code (closed / invite-only signup).
    invite_code: str = Field("", validation_alias="FEAR_INVITE_CODE")
    # The account that owns this machine's integrations (microphone, claps,
    # Spotify, Google Calendar, Obsidian vault). Empty: the first account created.
    owner_email: str = Field("", validation_alias="FEAR_OWNER_EMAIL")
    # Set by the Windows app launcher: one built-in account, no sign-up or login.
    desktop: bool = Field(False, validation_alias="FEAR_DESKTOP")
    # The Windows app's settings-panel switches (claps, Obsidian vault).
    desktop_settings_path: str = Field(
        "data/desktop.json", validation_alias="FEAR_DESKTOP_SETTINGS"
    )

    # OpenRouter is used through an OpenAI-compatible client interface.
    openrouter_api_key: str = Field("", validation_alias="OPENROUTER_API_KEY")
    openrouter_base_url: str = Field(
        "https://openrouter.ai/api/v1", validation_alias="OPENROUTER_BASE_URL"
    )
    openrouter_chat_model: str = Field(DEFAULT_CHAT_MODEL, validation_alias="OPENROUTER_CHAT_MODEL")
    # Ollama on this computer (models that run here, free and unlimited). The
    # Windows app sets it; empty: no local models.
    ollama_url: str = Field("", validation_alias="FEAR_OLLAMA_URL")
    openrouter_http_referer: str = Field(
        "http://127.0.0.1:8765", validation_alias="OPENROUTER_HTTP_REFERER"
    )
    openrouter_app_title: str = Field("F.E.A.R.", validation_alias="OPENROUTER_APP_TITLE")

    clap_threshold: float = Field(0.1, validation_alias="CLAP_THRESHOLD", ge=0.0, le=1.0)

    # Conversation behaviour.
    persona_file: str = Field("prompts/fear_persona.md", validation_alias="FEAR_PERSONA_FILE")
    # Permanent default persona mode: equilibrio | sombrio | cirurgico. The settings
    # panel can switch it live for the session; this is the value restored on restart.
    persona_mode: str = Field("equilibrio", validation_alias="FEAR_PERSONA_MODE")
    max_history_turns: int = Field(12, validation_alias="FEAR_MAX_HISTORY_TURNS", ge=0)

    spotify_scope: str = (
        "user-read-playback-state user-modify-playback-state user-read-currently-playing"
    )

    # Google Calendar (read-only). credentials.json comes from the Google Cloud
    # OAuth "Desktop" client; the token is created once via scripts/google_login.py.
    google_credentials_file: str = Field(
        "credentials.json", validation_alias="GOOGLE_CREDENTIALS_FILE"
    )
    google_token_file: str = Field("data/google_token.json", validation_alias="GOOGLE_TOKEN_FILE")
    google_calendar_id: str = Field("primary", validation_alias="GOOGLE_CALENDAR_ID")
    google_calendar_scope: str = "https://www.googleapis.com/auth/calendar.readonly"

    @property
    def is_production(self) -> bool:
        """True when running as a published service (FEAR_ENV=production).

        Matches any "prod…" spelling ("prod", "PRODUCTION", "production-eu").
        This flag is the only gate on the fatal missing-FEAR_SECRET_KEY check,
        and an exact match let a deployment written as FEAR_ENV=prod boot with
        an ephemeral secret — silently logging every user out and making stored
        API keys undecryptable on each restart.
        """
        return self.env.strip().lower().startswith("prod")

    @classmethod
    def from_env(cls) -> Settings:
        """Load .env into the environment, then read and validate settings."""
        load_dotenv()
        settings = cls()
        # Local source runs discover Ollama just like the Windows launcher.
        # An explicit URL (including empty to opt out) always wins.
        if not settings.is_production and "ollama_url" not in settings.model_fields_set:
            settings.ollama_url = "http://127.0.0.1:11434"
        return settings
