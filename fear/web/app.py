from __future__ import annotations

import asyncio
import hmac
import importlib.util
import json
import logging
import os
import re
import secrets
import threading
from collections.abc import AsyncIterator, Coroutine
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, Field

from fear.auth import EmailTaken, Security, TokenError, User, UserStore
from fear.brain.async_conversation import (
    DEFAULT_PERSONA_MODE,
    PERSONA_MODES,
    AsyncConversationalBrain,
    UserContext,
)
from fear.brain.local_models import (
    DOWNLOADS,
    RECOMMENDED_LOCAL_MODEL,
    Ollama,
    is_local,
    local_id,
    local_tag,
)
from fear.brain.models import FALLBACK_MODELS, ModelCatalog, ModelInfo
from fear.config import DEFAULT_CHAT_MODEL, Settings
from fear.desktop_prefs import (
    DesktopPrefs,
    autostart_available,
    autostart_enabled,
    load_prefs,
    save_prefs,
    set_autostart,
)
from fear.input.wearable_taps import GestureName, WearableTapEvent, gesture_to_command
from fear.library.reference_library import ReferenceLibrary
from fear.logging_config import configure_logging
from fear.memory.embedding import LocalEmbedding
from fear.memory.personal_memory import PersonalMemory
from fear.web.ratelimit import RateLimiter

if TYPE_CHECKING:
    from fear.audio.voice_listener import TranscriptEvent, VoiceListener

logger = logging.getLogger(__name__)


class CommandRequest(BaseModel):
    """Request body for /command."""

    text: str
    speaker: str = "user"
    speak: bool = True


class CommandResponse(BaseModel):
    """Response body for /command."""

    reply: str
    speaker: str
    audio_file: str | None = None


class MemoryResponse(BaseModel):
    """Response body for GET /memory."""

    speaker: str
    memories: list[dict[str, object]]


class ForgetRequest(BaseModel):
    """Request body for /memory/forget."""

    memory_id: str


class TapGesturePayload(BaseModel):
    """Request body for /wearable/tap."""

    gesture: GestureName = "single_tap"
    device_id: str | None = None
    speaker: str = "user"


class StatusResponse(BaseModel):
    """Which F.E.A.R. integrations are configured/active."""

    assistant: str
    openrouter: bool
    memory: bool
    voice: bool
    spotify: bool
    # Some way to control music: Spotify's API, or the system media keys.
    music: bool
    # Talking to F.E.A.R. in the app: speech recognition, and its own voice.
    voice_input: bool
    voice_output: bool
    # Its voice can come from Microsoft's neural voices (with internet).
    voice_online: bool
    # It can think with a model on this computer (Ollama), no key needed.
    local_models: bool
    obsidian: bool
    calendar: bool


class KnowledgeTextRequest(BaseModel):
    """Request body for adding a free-text knowledge source."""

    name: str
    content: str


class KnowledgeSource(BaseModel):
    """One indexed knowledge source and how many chunks it holds."""

    source: str
    chunks: int


class KnowledgeListResponse(BaseModel):
    """The configured knowledge sources (drives the settings panel)."""

    available: bool
    sources: list[KnowledgeSource]


class ConfigResponse(BaseModel):
    """Live, non-secret runtime configuration (drives the behaviour panel)."""

    model: str
    model_default: str
    # Whether OpenRouter still offers `model` (None: its list can't be read now).
    model_available: bool | None = None
    persona_mode: str
    persona_modes: list[str]


class ModelOption(BaseModel):
    """A model to choose, as the settings panel shows it."""

    id: str
    name: str
    description: str
    free: bool
    context_length: int
    # Roughly what 100 of F.E.A.R.'s replies cost with it, in US dollars (None: it varies).
    cost_per_100_replies: float | None


class ModelsResponse(BaseModel):
    """The chat models OpenRouter offers now: the default and fallbacks first, then
    the other free ones, then the paid ones."""

    models: list[ModelOption]
    default: str
    # Tried in this order whenever the chosen model fails.
    fallbacks: list[str]


class ConfigUpdate(BaseModel):
    """Partial update for runtime configuration. Secrets are never accepted here."""

    model: str | None = None
    persona_mode: str | None = None


class SpeakRequest(BaseModel):
    """One sentence for F.E.A.R. to say (the UI sends a reply sentence by sentence)."""

    text: str = Field(max_length=2000)
    style: Literal["fear", "natural"] = "natural"
    # Microsoft's neural voice when it answers; false: only the local one.
    online: bool = True


class DesktopSettingsResponse(BaseModel):
    """The Windows app's switches, and whether each one is actually working."""

    claps: bool
    claps_available: bool
    claps_listening: bool
    obsidian_vault: str
    obsidian_watching: bool
    autostart: bool
    autostart_available: bool


class DesktopSettingsUpdate(BaseModel):
    """Partial update of the Windows app's switches (None leaves one as it is)."""

    claps: bool | None = None
    obsidian_vault: str | None = None
    autostart: bool | None = None


class RegisterRequest(BaseModel):
    """Request body for /auth/register."""

    email: str
    password: str
    # Only checked when the server sets FEAR_INVITE_CODE (closed registration).
    invite_code: str = ""


class LoginRequest(BaseModel):
    """Request body for /auth/login."""

    email: str
    password: str


class UserResponse(BaseModel):
    """A user's public account state (never includes the password or raw key)."""

    id: str
    email: str
    has_openrouter_key: bool
    chat_model: str
    persona_mode: str


class AuthResponse(BaseModel):
    """A session token plus the authenticated user."""

    token: str
    user: UserResponse


class OpenRouterKeyRequest(BaseModel):
    """Request body for storing a user's own OpenRouter key (BYO key)."""

    api_key: str


def cors_origins() -> list[str]:
    """Read allowed CORS origins from FEAR_CORS_ORIGINS."""
    raw = os.getenv(
        "FEAR_CORS_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:3001,http://127.0.0.1:3001",
    )
    return [origin.strip() for origin in raw.split(",") if origin.strip()]


def env_bool(name: str, *, default: bool = False) -> bool:
    """Parse a boolean environment variable."""
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


# --- Dependency providers (read app state; overridable in tests) ---
def get_brain(request: Request) -> AsyncConversationalBrain:
    return request.app.state.brain


def get_memory(request: Request) -> PersonalMemory:
    return request.app.state.memory


def get_tts(request: Request) -> Any:
    return request.app.state.tts


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def get_reference_library(request: Request) -> ReferenceLibrary | None:
    """Return the reference library, or None when it could not be initialized."""
    return getattr(request.app.state, "reference_library", None)


def get_user_store(request: Request) -> UserStore:
    return request.app.state.user_store


def get_security(request: Request) -> Security:
    return request.app.state.security


_bearer_scheme = HTTPBearer(auto_error=False)


def _session_token(security: Security, user: User) -> str:
    """Mint a session token bound to the user's current token_version.

    The payload is ``<user_id>:<token_version>``; bumping the stored version
    (logout-everywhere) invalidates every token minted before it.
    """
    return security.make_session_token(f"{user.id}:{user.token_version}")


async def _user_from_token(
    token: str, store: UserStore, security: Security, settings: Settings
) -> User | None:
    """Resolve a session token to a user, or None if missing/invalid/expired/revoked.

    Shared by the HTTP dependency and the WebSocket handshake so both validate
    identically. Never logs the token.
    """
    if not token:
        return None
    try:
        payload = security.read_session_token(token, settings.session_max_age_days * 86_400)
    except TokenError:
        return None
    user_id, separator, version = payload.partition(":")
    if not separator:
        return None  # malformed or a pre-versioning token
    user = await asyncio.to_thread(store.get_by_id, user_id)
    if user is None or str(user.token_version) != version:
        return None  # user gone, or session revoked via token_version bump
    return user


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    store: UserStore = Depends(get_user_store),
    security: Security = Depends(get_security),
    settings: Settings = Depends(get_settings),
) -> User | None:
    """The logged-in user when a valid token is sent, otherwise None (never 401)."""
    if credentials is None:
        return None
    return await _user_from_token(credentials.credentials, store, security, settings)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer_scheme),
    store: UserStore = Depends(get_user_store),
    security: Security = Depends(get_security),
    settings: Settings = Depends(get_settings),
) -> User:
    """Resolve the logged-in user from the `Authorization: Bearer <token>` header.

    Raises 401 for a missing, malformed, expired, or stale token.
    """
    if credentials is None:
        raise HTTPException(status_code=401, detail="Autenticação necessária.")
    user = await _user_from_token(credentials.credentials, store, security, settings)
    if user is None:
        raise HTTPException(status_code=401, detail="Sessão inválida ou expirada.")
    return user


def _user_response(user: User) -> UserResponse:
    return UserResponse(
        id=user.id,
        email=user.email,
        has_openrouter_key=user.has_openrouter_key,
        chat_model=user.chat_model,
        persona_mode=user.persona_mode,
    )


def _cors_headers_for(request: Request) -> dict[str, str]:
    """CORS headers for a response built outside CORSMiddleware (the 500 handler).

    Mirrors the middleware's decision: echo the caller's Origin when it is
    allowed (or when FEAR_CORS_ORIGINS is "*"), and nothing otherwise — never
    widen access beyond what the configured policy already permits.
    """
    origin = request.headers.get("origin")
    if not origin:
        return {}
    # `allowed_origins` (module level, set below) is the very list handed to
    # CORSMiddleware, so the two can never disagree.
    if "*" in allowed_origins:
        return {"Access-Control-Allow-Origin": "*"}
    if origin in allowed_origins:
        return {"Access-Control-Allow-Origin": origin, "Vary": "Origin"}
    return {}


def _matches_invite(supplied: str, expected: str) -> bool:
    """Constant-time invite-code check that tolerates any input.

    ``hmac.compare_digest`` raises TypeError when handed a str with non-ASCII
    characters, so a code containing (say) an accent would surface as a 500
    instead of a clean refusal. Comparing the UTF-8 bytes keeps the timing
    guarantee and accepts anything the client sends.
    """
    return hmac.compare_digest(supplied.encode("utf-8"), expected.encode("utf-8"))


def _normalize_email(email: str) -> str:
    """Lowercase + validate an email's shape (without the email-validator dep)."""
    cleaned = email.strip().lower()
    # Exactly one "@", no inner whitespace: "a@b@c.com" and "a b@c.com" are not
    # addresses, and letting them through would mint accounts that no real mail
    # provider can match.
    if cleaned.count("@") != 1 or any(character.isspace() for character in cleaned):
        raise HTTPException(status_code=422, detail="E-mail inválido.")
    local, _, domain = cleaned.partition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise HTTPException(status_code=422, detail="E-mail inválido.")
    return cleaned


async def _is_owner(user: User, store: UserStore, settings: Settings) -> bool:
    """Whether ``user`` owns this machine's integrations (see Settings.owner_email)."""
    owner = await asyncio.to_thread(store.owner, settings.owner_email)
    return owner is not None and owner.id == user.id


async def _require_owner(
    user: User,
    store: UserStore,
    settings: Settings,
    detail: str = "Só o dono deste F.E.A.R. controla o microfone.",
) -> None:
    """403 unless ``user`` is the machine's owner — it's their mic, not the caller's."""
    if not await _is_owner(user, store, settings):
        raise HTTPException(status_code=403, detail=detail)


async def _user_context(
    user: User | None, store: UserStore, settings: Settings
) -> UserContext | None:
    """Build the brain's per-user context, including the decrypted OpenRouter key."""
    if user is None:
        return None
    api_key = await asyncio.to_thread(store.get_openrouter_key, user.id)
    return UserContext(
        user_id=user.id,
        api_key=api_key,
        chat_model=user.chat_model,
        persona_mode=user.persona_mode,
        is_owner=await _is_owner(user, store, settings),
    )


async def _owner_context(application: FastAPI) -> UserContext | None:
    """The owner's context, for input that comes from the machine itself (mic, claps)."""
    state = application.state
    owner = await asyncio.to_thread(state.user_store.owner, state.settings.owner_email)
    return await _user_context(owner, state.user_store, state.settings)


def _spawn(application: FastAPI, coroutine: Coroutine[Any, Any, None]) -> None:
    """Run a background coroutine on the app loop, keeping it alive and its errors logged.

    The event loop holds tasks only weakly, so an unreferenced task can be
    garbage-collected mid-flight, and its exception would otherwise vanish.
    """
    task = asyncio.get_running_loop().create_task(coroutine)
    tasks: set[asyncio.Task[None]] = application.state.background_tasks
    tasks.add(task)

    def finished(done: asyncio.Task[None]) -> None:
        tasks.discard(done)
        if not done.cancelled() and done.exception() is not None:
            logger.error("Background task failed", exc_info=done.exception())

    task.add_done_callback(finished)


def resolve_secret_key(settings: Settings) -> str:
    """Return the secret that signs sessions and encrypts stored keys.

    Fatal in production (FEAR_ENV=production) when unset: an ephemeral secret
    would silently reset every session and stored key on each restart. Outside
    production, an ephemeral one is generated with a loud warning (dev only).
    Never logs the secret itself.
    """
    if settings.secret_key:
        return settings.secret_key
    if settings.is_production:
        raise RuntimeError(
            "FEAR_SECRET_KEY is required when FEAR_ENV=production. Set a long, random "
            "value — without it, logins and stored API keys reset on every restart. "
            'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"'
        )
    logger.warning(
        "FEAR_SECRET_KEY is not set; using an ephemeral secret (FEAR_ENV=%s). Logins "
        "and stored keys will reset on restart — set FEAR_SECRET_KEY for production.",
        settings.env,
    )
    return secrets.token_urlsafe(32)


def get_rate_limiter(request: Request) -> RateLimiter:
    return request.app.state.rate_limiter


def _rate_limit(request: Request, limiter: RateLimiter, bucket: str) -> None:
    """Throttle by client IP; raises 429 when the bucket's limit is exceeded."""
    host = request.client.host if request.client else "unknown"
    if not limiter.allow(f"{bucket}:{host}"):
        raise HTTPException(
            status_code=429, detail="Muitas tentativas. Tente de novo em instantes."
        )


def _refuse_in_desktop(settings: Settings) -> None:
    """The desktop app's only account is created by its launcher.

    Leaving sign-up open would let any program on the PC mint an account on
    the local API.
    """
    if settings.desktop:
        raise HTTPException(status_code=403, detail="O app do F.E.A.R. não usa cadastro nem login.")


def require_reference_library(library: ReferenceLibrary | None) -> ReferenceLibrary:
    """Guard endpoints that need the knowledge store, returning a clean 503 if absent."""
    if library is None:
        raise HTTPException(
            status_code=503,
            detail=(
                "Biblioteca de conhecimento indisponível. "
                "Instale as dependências (chromadb) e reinicie o backend."
            ),
        )
    return library


async def process_machine_command(application: FastAPI, text: str, speaker: str):
    """Process input from the machine itself (mic, claps) as its owner.

    Returns None when no owner account exists yet: running it unscoped would
    read every account's memories into a reply spoken out loud.
    """
    ctx = await _owner_context(application)
    if ctx is None:
        logger.warning("Ignoring %s input: no owner account exists yet", speaker)
        return None
    return await application.state.brain.process_command(text, speaker, user=ctx)


async def speak_and_cleanup(tts: Any, text: str) -> None:
    """Say `text` out loud and delete the audio file it produced.

    ``NaturalTTS.say`` returns the temp file it synthesised; dropping that
    return value leaks one file per spoken reply, so every caller must go
    through here.
    """
    audio_path = await tts.say(text)
    if audio_path is None:
        return
    try:
        audio_path.unlink(missing_ok=True)
    except OSError:
        logger.warning("Could not delete synthesised audio file", exc_info=True)


async def process_voice_event(application: FastAPI, event: TranscriptEvent) -> None:
    """Process a transcript produced by the optional background voice listener."""
    result = await process_machine_command(application, event.message, event.speaker)
    if result is not None and result.reply:
        await speak_and_cleanup(application.state.tts, result.reply)


def _preload(engine: Any) -> None:
    try:
        engine.preload()
    except Exception:
        logger.exception("Could not preload %s", type(engine).__name__)


def start_obsidian_watcher(application: FastAPI, vault_path: str) -> None:
    """Watch `vault_path` (replacing any earlier watch); its notes become the owner's."""
    from fear.memory.obsidian_watcher import ObsidianWatcher

    stop_obsidian_watcher(application)
    state = application.state
    settings: Settings = state.settings
    store: UserStore = state.user_store

    def vault_owner_id() -> str:
        owner = store.owner(settings.owner_email)
        return owner.id if owner is not None else ""

    watcher = ObsidianWatcher(
        vault_path=vault_path,
        memory=state.memory,
        speaker=os.getenv("OBSIDIAN_SPEAKER", "fear_user"),
        user_id=vault_owner_id,
        state_file=Path(settings.chroma_path).expanduser().parent / "obsidian_state.json",
    )
    watcher.start()
    state.obsidian_watcher = watcher


def stop_obsidian_watcher(application: FastAPI) -> None:
    watcher = getattr(application.state, "obsidian_watcher", None)
    if watcher is not None:
        watcher.stop()
    application.state.obsidian_watcher = None


def clap_detection_available() -> bool:
    """Whether the microphone library the clap detector needs is installed."""
    return importlib.util.find_spec("pyaudio") is not None


def start_clap_detector(application: FastAPI) -> bool:
    """Listen for double claps, which play/pause the music; False without pyaudio."""
    stop_clap_detector(application)
    try:
        from fear.input.clap_detector import ClapDetector
    except ImportError:
        logger.warning("Clap detection is enabled but pyaudio is not installed")
        return False
    settings: Settings = application.state.settings

    async def toggle_from_clap() -> None:
        await process_machine_command(application, "toggle Spotify playback", "clap")

    def on_double_clap() -> None:
        application.state.loop.call_soon_threadsafe(_spawn, application, toggle_from_clap())

    detector = ClapDetector(
        on_double_clap=on_double_clap,
        threshold=settings.clap_threshold,
        sample_rate=settings.sample_rate,
        chunk_size=settings.chunk_size,
    )
    detector.start()
    application.state.clap_detector = detector
    return True


def stop_clap_detector(application: FastAPI) -> None:
    detector = getattr(application.state, "clap_detector", None)
    if detector is not None:
        detector.stop()
    application.state.clap_detector = None


@asynccontextmanager
async def lifespan(application: FastAPI) -> AsyncIterator[None]:
    """Initialize and stop the unified F.E.A.R. runtime."""
    configure_logging()
    settings = Settings.from_env()
    logger.info("Starting F.E.A.R. runtime")

    # Hardware/IO-heavy modules are imported here so importing this module (and
    # testing the HTTP layer) does not require the audio/ML stack to be present.
    from fear.audio.natural_tts import NaturalTTS
    from fear.integrations.google_calendar import GoogleCalendarClient
    from fear.integrations.music import MediaKeys, choose_music_player
    from fear.integrations.spotify_client import SpotifyClient

    # One CPU embedder (ONNX MiniLM, no torch) shared by both stores so the
    # model loads once.
    embedding = await asyncio.to_thread(LocalEmbedding)
    memory = await asyncio.to_thread(
        PersonalMemory,
        path=settings.chroma_path,
        collection_name="personal_memory",
        embedding=embedding,
    )
    reference_library = await asyncio.to_thread(
        ReferenceLibrary,
        path=settings.chroma_path,
        collection_name=os.getenv("BOOK_KNOWLEDGE_COLLECTION", "book_knowledge"),
        embedding=embedding,
    )

    # Loads only when SPOTIPY_* credentials are present; otherwise stays inert.
    spotify = SpotifyClient(scope=settings.spotify_scope)
    await spotify.load()
    # Without Spotify's API, the system media keys drive whatever player is open.
    music = choose_music_player(spotify, MediaKeys())

    # Loads only after a one-time google_login.py has cached a token; else inert.
    calendar = GoogleCalendarClient(
        credentials_file=settings.google_credentials_file,
        token_file=settings.google_token_file,
        calendar_id=settings.google_calendar_id,
        scope=settings.google_calendar_scope,
    )
    await calendar.load()

    # Multi-user auth: one secret signs session tokens and encrypts each user's
    # stored OpenRouter key. Fatal in production if unset (see resolve_secret_key);
    # ephemeral (with a warning) only outside production.
    security = Security(resolve_secret_key(settings))
    user_store = await asyncio.to_thread(UserStore, path=settings.users_db_path, security=security)
    # Throttles auth attempts per client IP (in-memory, single-process).
    rate_limiter = RateLimiter(limit=10, window_seconds=60.0)

    application.state.settings = settings
    application.state.model_catalog = ModelCatalog(settings.openrouter_base_url)
    application.state.ollama = Ollama(settings.ollama_url) if settings.ollama_url else None
    application.state.memory = memory
    application.state.reference_library = reference_library
    application.state.spotify = spotify
    application.state.music = music
    application.state.calendar = calendar
    application.state.security = security
    application.state.user_store = user_store
    application.state.rate_limiter = rate_limiter
    application.state.tts = NaturalTTS()
    application.state.brain = AsyncConversationalBrain(
        settings=settings,
        memory=memory,
        reference_library=reference_library,
        music=music,
        calendar=calendar,
    )

    application.state.loop = asyncio.get_running_loop()

    # Local speech (optional): unavailable without its packages or models.
    from fear.audio.online_voice import OnlineVoice
    from fear.audio.speech import SpeechToText, TextToSpeech

    stt = SpeechToText(settings.stt_model, language=settings.voice_language)
    voice_out = TextToSpeech(settings.piper_voice)
    application.state.stt = stt if stt.available else None
    application.state.voice_out = voice_out if voice_out.available else None
    online_voice = OnlineVoice()
    application.state.voice_online = (
        online_voice if settings.online_voice and online_voice.available else None
    )
    if settings.preload_voice:
        for engine in (application.state.stt, application.state.voice_out):
            if engine is not None:
                threading.Thread(target=_preload, args=(engine,), daemon=True).start()
    application.state.voice_listener = None
    application.state.obsidian_watcher = None
    application.state.clap_detector = None

    # The Windows app's own switches (its settings panel); .env still wins.
    prefs = load_prefs(settings.desktop_settings_path) if settings.desktop else DesktopPrefs()
    obsidian_path = os.getenv("OBSIDIAN_VAULT_PATH", "").strip() or prefs.obsidian_vault
    if obsidian_path:
        start_obsidian_watcher(application, obsidian_path)

    voice_listener_class: type[VoiceListener] | None = None
    if env_bool("FEAR_ENABLE_VOICE_LISTENER", default=False):
        # Imported here so the heavy audio stack (whisper, pyaudio) is only
        # needed when voice input is explicitly enabled — install it with
        # `pip install -e ".[audio]"`. Missing it turns voice off, not the app
        # (the Windows app ships without it: there you talk through its window).
        try:
            from fear.audio.voice_listener import VoiceListener as voice_listener_class
        except ImportError:
            logger.warning("Voice input is enabled but whisper/pyaudio is not installed")

    if voice_listener_class is not None:

        def on_transcript(event: TranscriptEvent) -> None:
            application.state.loop.call_soon_threadsafe(
                _spawn, application, process_voice_event(application, event)
            )

        listener = voice_listener_class(
            on_transcript=on_transcript,
            model_name=settings.whisper_model_name,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        listener.start()
        application.state.voice_listener = listener

    if env_bool("FEAR_ENABLE_CLAP_DETECTOR", default=False) or prefs.claps:
        start_clap_detector(application)

    try:
        yield
    finally:
        active_listener = getattr(application.state, "voice_listener", None)
        if active_listener is not None:
            active_listener.stop()

        stop_obsidian_watcher(application)
        stop_clap_detector(application)

        active_store = getattr(application.state, "user_store", None)
        if active_store is not None:
            active_store.close()


app = FastAPI(title="F.E.A.R. Unified API", lifespan=lifespan)
app.state.background_tasks = set()
allowed_origins = cors_origins()
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    # The CORS spec forbids wildcard origins with credentials; F.E.A.R. doesn't
    # use cookies, so when FEAR_CORS_ORIGINS="*" (handy for testing from a phone
    # on the same Wi-Fi) we drop credentials to keep browsers happy.
    allow_credentials="*" not in allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    # Custom response headers are hidden from cross-origin JS unless exposed; the
    # UI reads the consulted-memory ids from /command/stream, so expose it.
    expose_headers=["X-Fear-Consulted-Memory-Ids"],
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log unhandled errors and return a clean payload instead of a stack trace.

    Starlette serves this from ServerErrorMiddleware, which sits *outside*
    CORSMiddleware — so the usual CORS headers are never applied and a browser
    would discard the body, turning a readable 500 into an opaque network
    error. Echo the allowed origin here so the UI can still read the reason.
    """
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal error. The incident was logged."},
        headers=_cors_headers_for(request),
    )


@app.post("/auth/register", response_model=AuthResponse)
async def auth_register(
    payload: RegisterRequest,
    request: Request,
    store: UserStore = Depends(get_user_store),
    security: Security = Depends(get_security),
    settings: Settings = Depends(get_settings),
    limiter: RateLimiter = Depends(get_rate_limiter),
) -> AuthResponse:
    """Create an account and return a session token."""
    _refuse_in_desktop(settings)
    _rate_limit(request, limiter, "register")
    # Optional closed registration: when FEAR_INVITE_CODE is set, require it.
    if settings.invite_code and not _matches_invite(payload.invite_code, settings.invite_code):
        raise HTTPException(status_code=403, detail="Convite inválido.")
    email = _normalize_email(payload.email)
    if len(payload.password) < 8:
        raise HTTPException(status_code=422, detail="A senha precisa de ao menos 8 caracteres.")
    try:
        user = await asyncio.to_thread(store.create_user, email, payload.password)
    except EmailTaken as exc:
        raise HTTPException(status_code=409, detail="Esse e-mail já está cadastrado.") from exc
    return AuthResponse(token=_session_token(security, user), user=_user_response(user))


@app.post("/auth/login", response_model=AuthResponse)
async def auth_login(
    payload: LoginRequest,
    request: Request,
    store: UserStore = Depends(get_user_store),
    security: Security = Depends(get_security),
    settings: Settings = Depends(get_settings),
    limiter: RateLimiter = Depends(get_rate_limiter),
) -> AuthResponse:
    """Exchange email + password for a session token."""
    _refuse_in_desktop(settings)
    _rate_limit(request, limiter, "login")
    user = await asyncio.to_thread(
        store.verify_credentials, payload.email.strip().lower(), payload.password
    )
    if user is None:
        raise HTTPException(status_code=401, detail="E-mail ou senha incorretos.")
    return AuthResponse(token=_session_token(security, user), user=_user_response(user))


@app.get("/auth/me", response_model=UserResponse)
async def auth_me(user: User = Depends(get_current_user)) -> UserResponse:
    """Return the authenticated user's account state."""
    return _user_response(user)


@app.post("/auth/logout-all")
async def auth_logout_all(
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> dict[str, bool]:
    """Revoke every session for this user by bumping their token version."""
    await asyncio.to_thread(store.bump_token_version, user.id)
    return {"logged_out": True}


@app.post("/auth/openrouter-key", response_model=UserResponse)
async def auth_set_openrouter_key(
    payload: OpenRouterKeyRequest,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> UserResponse:
    """Store (or clear) the user's own OpenRouter key, encrypted at rest."""
    await asyncio.to_thread(store.set_openrouter_key, user.id, payload.api_key.strip())
    refreshed = await asyncio.to_thread(store.get_by_id, user.id)
    return _user_response(refreshed or user)


@app.get("/health")
async def health() -> dict[str, str]:
    """Health check."""
    settings = getattr(app.state, "settings", None)
    assistant_name = settings.assistant_name if settings else "F.E.A.R."
    return {"status": "ok", "assistant": assistant_name}


@app.get("/status", response_model=StatusResponse)
async def status(
    request: Request,
    settings: Settings = Depends(get_settings),
    user: User | None = Depends(get_optional_user),
    store: UserStore = Depends(get_user_store),
) -> StatusResponse:
    """Report which integrations are configured/active (drives the system panel).

    The machine's own integrations are reported only to its owner — for anyone
    else they are off, because the brain won't route their requests to them.
    """
    state = request.app.state
    spotify = getattr(state, "spotify", None)
    music = getattr(state, "music", None)
    calendar = getattr(state, "calendar", None)
    owner = user is not None and await _is_owner(user, store, settings)
    ollama: Ollama | None = getattr(state, "ollama", None)
    return StatusResponse(
        assistant=settings.assistant_name,
        openrouter=bool(settings.openrouter_api_key and settings.openrouter_chat_model),
        memory=getattr(state, "memory", None) is not None,
        voice=owner and getattr(state, "voice_listener", None) is not None,
        spotify=owner and bool(spotify is not None and spotify.is_configured),
        music=owner and bool(music is not None and music.is_configured),
        voice_input=getattr(state, "stt", None) is not None,
        voice_output=getattr(state, "voice_out", None) is not None
        or getattr(state, "voice_online", None) is not None,
        voice_online=getattr(state, "voice_online", None) is not None,
        local_models=bool(await ollama.chat_models()) if ollama else False,
        obsidian=owner and getattr(state, "obsidian_watcher", None) is not None,
        calendar=owner and bool(calendar is not None and calendar.is_configured),
    )


@app.post("/command", response_model=CommandResponse)
async def command(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
    tts: Any = Depends(get_tts),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> CommandResponse:
    """Process a text command and optionally speak it locally."""
    ctx = await _user_context(user, store, settings)
    result = await brain.process_command(payload.text, payload.speaker, user=ctx)

    # The speakers are the owner's: nobody else gets to talk through their room.
    if payload.speak and result.reply and ctx is not None and ctx.is_owner:
        await speak_and_cleanup(tts, result.reply)

    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.post("/command/stream")
async def command_stream(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Stream the reply as plain-text chunks as the model produces them.

    The memories consulted to build this turn's context are surfaced in the
    ``X-Fear-Consulted-Memory-Ids`` response header (ids only, percent-encoded,
    comma-separated). They are known before the first token, so the streamed
    body is byte-for-byte unchanged; the header is simply absent when nothing
    was consulted.
    """
    ctx = await _user_context(user, store, settings)
    session = await brain.open_stream(payload.text, payload.speaker, user=ctx)

    # Disable proxy/browser buffering so tokens reach the client as they are produced.
    headers = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
    if session.consulted_memory_ids:
        headers["X-Fear-Consulted-Memory-Ids"] = ",".join(
            quote(memory_id, safe="") for memory_id in session.consulted_memory_ids
        )

    return StreamingResponse(
        session.stream,
        media_type="text/plain; charset=utf-8",
        headers=headers,
    )


@app.get("/memory", response_model=MemoryResponse)
async def memory_list(
    user: User = Depends(get_current_user),
    memory: PersonalMemory = Depends(get_memory),
    include_assistant_replies: bool = False,
) -> MemoryResponse:
    """Return the signed-in user's own recent memories.

    This endpoint is UI-facing (it drives the memory inspector), so by default
    it omits F.E.A.R.'s own replies (``source="assistant_reply"``) — showing
    them as "what it remembers about you" is confusing, and they would eat slots
    in the capped window. Pass ``include_assistant_replies=true`` to get them.
    """
    facts = await asyncio.to_thread(memory.recent_for_user, user.id, 20, include_assistant_replies)
    return MemoryResponse(
        speaker=user.email,
        memories=[
            {"id": item.id, "text": item.text, "source": item.source, "timestamp": item.timestamp}
            for item in facts
        ],
    )


@app.post("/memory/forget")
async def memory_forget(
    payload: ForgetRequest,
    user: User = Depends(get_current_user),
    memory: PersonalMemory = Depends(get_memory),
) -> dict[str, object]:
    """Delete one of the signed-in user's memories by id.

    Ownership is checked by the store against the memory's metadata (not the id
    shape), so a user can forget their own memories — including ones claimed
    after accounts existed — but never anyone else's. ``forgotten`` is False when
    the memory isn't the caller's or doesn't exist.
    """
    forgotten = await asyncio.to_thread(memory.forget_for_user, payload.memory_id, user.id)
    return {"forgotten": forgotten, "id": payload.memory_id}


@app.get("/knowledge", response_model=KnowledgeListResponse)
async def knowledge_list(
    user: User = Depends(get_current_user),
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> KnowledgeListResponse:
    """List the signed-in user's own knowledge sources."""
    if library is None:
        return KnowledgeListResponse(available=False, sources=[])

    sources = await asyncio.to_thread(library.list_sources, user.id)
    return KnowledgeListResponse(
        available=True,
        sources=[KnowledgeSource(source=item["source"], chunks=item["chunks"]) for item in sources],
    )


@app.post("/knowledge/text", response_model=KnowledgeSource)
async def knowledge_add_text(
    payload: KnowledgeTextRequest,
    user: User = Depends(get_current_user),
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> KnowledgeSource:
    """Add a free-text knowledge source (a named, editable note) owned by the user."""
    store = require_reference_library(library)
    name = payload.name.strip() or "nota"
    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=422, detail="O conteúdo não pode ser vazio.")

    chunks = await asyncio.to_thread(store.index_text, content, source=name, user_id=user.id)
    return KnowledgeSource(source=name, chunks=chunks)


@app.delete("/knowledge/{source}")
async def knowledge_delete(
    source: str,
    user: User = Depends(get_current_user),
    library: ReferenceLibrary | None = Depends(get_reference_library),
) -> dict[str, object]:
    """Remove one of the user's knowledge sources and all of its chunks."""
    store = require_reference_library(library)
    deleted = await asyncio.to_thread(store.delete_source, source, user.id)
    return {"source": source, "deleted": deleted}


@app.post("/wearable/tap", response_model=CommandResponse)
async def wearable_tap(
    payload: TapGesturePayload,
    request: Request,
    brain: AsyncConversationalBrain = Depends(get_brain),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> CommandResponse:
    """Process a wearable tap as a command, on the signed-in user's context."""
    if payload.gesture == "long_press":
        # A long press means "listen to me": it opens the mic, it isn't a chat line.
        await _require_owner(user, store, settings)
        listener = getattr(request.app.state, "voice_listener", None)
        if listener is None:
            reply = "A captura de voz está desligada. Ative FEAR_ENABLE_VOICE_LISTENER=1."
        else:
            # Recording blocks for seconds and nothing waits on it: its own thread.
            threading.Thread(target=listener.capture_once, daemon=True).start()
            reply = "Estou ouvindo."
        return CommandResponse(reply=reply, speaker=payload.speaker, audio_file=None)

    text = gesture_to_command(WearableTapEvent(payload.gesture, payload.device_id))
    ctx = await _user_context(user, store, settings)
    result = await brain.process_command(text or payload.gesture, payload.speaker, user=ctx)
    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.post("/conversation/reset")
async def conversation_reset(
    user: User = Depends(get_current_user),
    brain: AsyncConversationalBrain = Depends(get_brain),
) -> dict[str, str]:
    """Clear the signed-in user's dialogue window (persistent memory is kept)."""
    brain.reset_conversation(user.id)
    return {"status": "reset", "speaker": user.email}


async def _model_available(
    model: str, catalog: ModelCatalog | None, ollama: Ollama | None
) -> bool | None:
    """Whether `model` can answer: OpenRouter offers it, or it's downloaded into
    Ollama here (None: can't tell right now)."""
    if is_local(model):
        installed = await ollama.chat_models() if ollama else []
        if ollama is None or await ollama.installed() is None:
            return None
        return local_tag(model) in {local.tag for local in installed}
    return await catalog.offers(model) if catalog else None


async def _user_config(
    user: User, catalog: ModelCatalog | None, ollama: Ollama | None
) -> ConfigResponse:
    """A user's effective model + persona mode (their choice, or the defaults)."""
    model = user.chat_model or DEFAULT_CHAT_MODEL
    return ConfigResponse(
        model=model,
        model_default=DEFAULT_CHAT_MODEL,
        model_available=await _model_available(model, catalog, ollama),
        persona_mode=user.persona_mode or DEFAULT_PERSONA_MODE,
        persona_modes=list(PERSONA_MODES.keys()),
    )


# OpenRouter's own routers, but for these two, do jobs other than chatting.
_CHAT_ROUTERS = ("openrouter/free", "openrouter/auto")


def _model_option(model: ModelInfo) -> ModelOption:
    # "Google: Gemma 4 31B (free)": the panel already sorts the free ones apart.
    name = re.sub(r"\s*\(free\)$", "", model.name).strip()
    first_sentence = model.description.split(". ")[0].strip()
    cost = None if model.free else model.cost_per_100_replies()
    return ModelOption(
        id=model.id,
        name=name,
        description=first_sentence[:160],
        free=model.free,
        context_length=model.context_length,
        cost_per_100_replies=None if cost is None else round(cost, 4),
    )


@app.get("/models", response_model=ModelsResponse)
async def models_list(request: Request, user: User = Depends(get_current_user)) -> ModelsResponse:
    """The chat models OpenRouter offers now, for choosing F.E.A.R.'s model."""
    catalog: ModelCatalog | None = getattr(request.app.state, "model_catalog", None)
    listed = await catalog.listing() if catalog else None
    if listed is None:
        raise HTTPException(
            status_code=503, detail="Não consegui ler a lista de modelos do OpenRouter agora."
        )
    recommended = [DEFAULT_CHAT_MODEL, *FALLBACK_MODELS]
    chat = [
        model
        for model in listed
        if model.chat and (not model.id.startswith("openrouter/") or model.id in _CHAT_ROUTERS)
    ]

    def order(model: ModelInfo) -> tuple[int, int, str]:
        rank = recommended.index(model.id) if model.id in recommended else len(recommended)
        return (rank, 0 if model.free else 1, model.name.lower())

    return ModelsResponse(
        models=[_model_option(model) for model in sorted(chat, key=order)],
        default=DEFAULT_CHAT_MODEL,
        fallbacks=list(FALLBACK_MODELS),
    )


class LocalModelOption(BaseModel):
    """A model downloaded into Ollama on this computer."""

    id: str  # "ollama/<tag>", as the model setting stores it
    tag: str
    size: int  # bytes on disk
    parameter_size: str


class LocalDownload(BaseModel):
    """A model the settings offer to download into Ollama."""

    id: str
    tag: str
    name: str
    size: int  # bytes to download, roughly
    note: str
    installed: bool


class LocalModelsResponse(BaseModel):
    """What Ollama on this computer has, and can download."""

    # Ollama answers (installed and open).
    running: bool
    models: list[LocalModelOption]
    downloads: list[LocalDownload]
    recommended: str


class PullRequest(BaseModel):
    """A model to download into Ollama, by its tag (e.g. "qwen3.5:4b")."""

    tag: str = Field(pattern=r"^[a-z0-9][a-z0-9._\-/]*(:[a-z0-9._\-]+)?$", max_length=120)


@app.get("/models/local", response_model=LocalModelsResponse)
async def models_local(
    request: Request, user: User = Depends(get_current_user)
) -> LocalModelsResponse:
    """The models F.E.A.R. can think with on this computer, through Ollama."""
    ollama: Ollama | None = getattr(request.app.state, "ollama", None)
    running = ollama is not None and await ollama.installed() is not None
    installed = await ollama.chat_models() if ollama else []
    tags = {model.tag for model in installed}
    return LocalModelsResponse(
        running=running,
        models=[
            LocalModelOption(
                id=local_id(model.tag),
                tag=model.tag,
                size=model.size,
                parameter_size=model.parameter_size,
            )
            for model in installed
        ],
        downloads=[
            LocalDownload(
                id=local_id(str(offer["tag"])),
                tag=str(offer["tag"]),
                name=str(offer["name"]),
                size=int(offer["size"]),
                note=str(offer["note"]),
                installed=offer["tag"] in tags,
            )
            for offer in DOWNLOADS
        ],
        recommended=RECOMMENDED_LOCAL_MODEL,
    )


@app.post("/models/local/pull")
async def models_local_pull(
    payload: PullRequest,
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Download a model into Ollama, streaming its progress as NDJSON lines:
    {"status", "completed", "total"} (bytes, all layers together), then
    {"status": "success"} or {"error": ...}."""
    await _require_owner(
        user, store, settings, detail="Só o dono deste F.E.A.R. baixa modelos neste computador."
    )
    ollama: Ollama | None = getattr(request.app.state, "ollama", None)
    if ollama is None:
        raise HTTPException(status_code=503, detail="Os modelos locais não estão ativados.")
    pulling = ollama

    async def progress() -> AsyncIterator[str]:
        layers: dict[str, tuple[int, int]] = {}
        async for event in pulling.pull(payload.tag):
            if "error" in event:
                yield json.dumps({"error": str(event["error"])}) + "\n"
                return
            digest, total = event.get("digest"), event.get("total")
            if digest and total:
                layers[str(digest)] = (int(event.get("completed") or 0), int(total))
            yield (
                json.dumps(
                    {
                        "status": str(event.get("status") or ""),
                        "completed": sum(done for done, _ in layers.values()),
                        "total": sum(size for _, size in layers.values()),
                    }
                )
                + "\n"
            )

    return StreamingResponse(progress(), media_type="application/x-ndjson")


@app.get("/config", response_model=ConfigResponse)
async def config_get(request: Request, user: User = Depends(get_current_user)) -> ConfigResponse:
    """Return the signed-in user's own model + persona choices."""
    state = request.app.state
    return await _user_config(
        user, getattr(state, "model_catalog", None), getattr(state, "ollama", None)
    )


@app.post("/config", response_model=ConfigResponse)
async def config_set(
    payload: ConfigUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> ConfigResponse:
    """Update the user's own chat model and/or persona mode (no secrets)."""
    catalog: ModelCatalog | None = getattr(request.app.state, "model_catalog", None)
    ollama: Ollama | None = getattr(request.app.state, "ollama", None)
    model: str | None = None
    persona_mode: str | None = None
    if payload.model is not None:
        model = payload.model.strip()
        # A typo, a retired model or one not downloaded would fail every reply.
        if model and await _model_available(model, catalog, ollama) is False:
            detail = (
                f"O modelo {local_tag(model)} não está baixado no Ollama."
                if is_local(model)
                else f"O OpenRouter não tem o modelo {model}. Confira o id em "
                "openrouter.ai/models; os grátis terminam em :free."
            )
            raise HTTPException(status_code=422, detail=detail)
    if payload.persona_mode is not None:
        persona_mode = payload.persona_mode.strip().lower()
        if persona_mode not in PERSONA_MODES:
            raise HTTPException(status_code=422, detail="Modo de persona inválido.")

    if model is not None or persona_mode is not None:
        await asyncio.to_thread(
            store.set_preferences, user.id, chat_model=model, persona_mode=persona_mode
        )
    refreshed = await asyncio.to_thread(store.get_by_id, user.id)
    return await _user_config(refreshed or user, catalog, ollama)


# Ten minutes of opus is ~5 MB; nothing spoken to F.E.A.R. needs more than that.
_MAX_VOICE_UPLOAD = 10 * 1024 * 1024


@app.post("/voice/transcribe")
async def voice_transcribe(
    request: Request, user: User = Depends(get_current_user)
) -> dict[str, str]:
    """Turn a recording from the UI's microphone into text (locally, with Whisper)."""
    stt = getattr(request.app.state, "stt", None)
    if stt is None:
        raise HTTPException(status_code=503, detail="O reconhecimento de voz não está instalado.")
    audio = await _read_capped(request, _MAX_VOICE_UPLOAD)
    if not audio:
        raise HTTPException(status_code=422, detail="Nenhum áudio recebido.")
    try:
        text = await asyncio.to_thread(stt.transcribe, audio)
    except Exception as exc:
        logger.exception("Transcription failed")
        raise HTTPException(status_code=422, detail="Não consegui entender esse áudio.") from exc
    return {"text": text}


@app.post("/voice/speak")
async def voice_speak(
    payload: SpeakRequest, request: Request, user: User = Depends(get_current_user)
) -> Response:
    """One sentence in F.E.A.R.'s voice: Microsoft's neural voice when it's wanted
    and answers, the local one (Piper) otherwise."""
    state = request.app.state
    voice_out = getattr(state, "voice_out", None)
    online = getattr(state, "voice_online", None) if payload.online else None
    if voice_out is None and online is None:
        raise HTTPException(status_code=503, detail="A voz do F.E.A.R. não está instalada.")
    text = payload.text.strip()
    if not text:
        raise HTTPException(status_code=422, detail="Nada para falar.")
    # One sentence at a time, waiting here rather than in a worker thread; and
    # a sentence whose reply was interrupted in the meantime (the page gave up
    # on it) is skipped, so a long answer cut short leaves no backlog behind.
    if getattr(state, "speech_turn", None) is None:
        state.speech_turn = asyncio.Lock()
    async with state.speech_turn:
        if await request.is_disconnected():
            return Response(status_code=204)
        if online is not None and online.ready():
            from fear.audio.online_voice import OnlineVoiceError

            try:
                audio, media_type = await online.synthesize(text, payload.style)
                return Response(
                    content=audio, media_type=media_type, headers={"Cache-Control": "no-store"}
                )
            except OnlineVoiceError as exc:
                logger.warning("Online voice failed, speaking locally: %s", exc)
        if voice_out is None:
            raise HTTPException(
                status_code=503, detail="A voz online não respondeu e não há voz local instalada."
            )
        wav = await asyncio.to_thread(voice_out.synthesize, text, payload.style)
    return Response(content=wav, media_type="audio/wav", headers={"Cache-Control": "no-store"})


async def _read_capped(request: Request, limit: int) -> bytes:
    """The request body, refused (413) as soon as it passes `limit` bytes."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > limit:
        raise HTTPException(status_code=413, detail="Áudio longo demais.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > limit:
            raise HTTPException(status_code=413, detail="Áudio longo demais.")
    return bytes(body)


@app.post("/voice/start")
async def voice_start(
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Start push-to-talk capture when the optional voice listener is enabled.

    Owner-only: this drives the machine's microphone, so neither an anonymous
    caller nor another account may switch it on.
    """
    await _require_owner(user, store, settings)
    listener = getattr(request.app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.begin_capture()
    return {"status": "capturing"}


@app.post("/voice/stop")
async def voice_stop(
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Stop push-to-talk capture (owner-only; see /voice/start)."""
    await _require_owner(user, store, settings)
    listener = getattr(request.app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.end_capture()
    return {"status": "paused"}


@app.post("/voice/capture-once")
async def voice_capture_once(
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> dict[str, str]:
    """Capture one voice chunk (owner-only; see /voice/start)."""
    await _require_owner(user, store, settings)
    listener = getattr(request.app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    # capture_once records synchronously for several seconds; calling it inline
    # would freeze the event loop (every other request, every live stream).
    await asyncio.to_thread(listener.capture_once)
    return {"status": "queued"}


async def _require_desktop_owner(user: User, store: UserStore, settings: Settings) -> None:
    if not settings.desktop:
        raise HTTPException(status_code=404, detail="Disponível só no app do F.E.A.R.")
    await _require_owner(user, store, settings, "Só o dono deste F.E.A.R. muda o app.")


def _desktop_settings_view(application: FastAPI, prefs: DesktopPrefs) -> DesktopSettingsResponse:
    detector = getattr(application.state, "clap_detector", None)
    return DesktopSettingsResponse(
        claps=prefs.claps,
        claps_available=clap_detection_available(),
        # Off when the microphone couldn't be opened, even with the switch on.
        claps_listening=bool(detector is not None and detector.is_running),
        obsidian_vault=prefs.obsidian_vault,
        obsidian_watching=getattr(application.state, "obsidian_watcher", None) is not None,
        autostart=autostart_enabled(),
        autostart_available=autostart_available(),
    )


@app.get("/desktop/settings", response_model=DesktopSettingsResponse)
async def desktop_settings_get(
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> DesktopSettingsResponse:
    """The Windows app's switches: claps, the Obsidian vault, start with Windows."""
    await _require_desktop_owner(user, store, settings)
    prefs = await asyncio.to_thread(load_prefs, settings.desktop_settings_path)
    return _desktop_settings_view(request.app, prefs)


@app.post("/desktop/settings", response_model=DesktopSettingsResponse)
async def desktop_settings_set(
    payload: DesktopSettingsUpdate,
    request: Request,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
    settings: Settings = Depends(get_settings),
) -> DesktopSettingsResponse:
    """Change the Windows app's switches; each takes effect at once and is remembered."""
    await _require_desktop_owner(user, store, settings)
    application = request.app
    prefs = await asyncio.to_thread(load_prefs, settings.desktop_settings_path)

    if payload.obsidian_vault is not None:
        vault = payload.obsidian_vault.strip()
        if vault and not Path(vault).expanduser().is_dir():
            raise HTTPException(status_code=422, detail="Essa pasta não existe.")
        if vault:
            await asyncio.to_thread(start_obsidian_watcher, application, vault)
        else:
            await asyncio.to_thread(stop_obsidian_watcher, application)
        prefs.obsidian_vault = vault

    if payload.claps is not None:
        if payload.claps:
            if not await asyncio.to_thread(start_clap_detector, application):
                raise HTTPException(
                    status_code=422, detail="Este F.E.A.R. não tem acesso ao microfone."
                )
        else:
            await asyncio.to_thread(stop_clap_detector, application)
        prefs.claps = payload.claps

    if payload.autostart is not None:
        if not autostart_available():
            raise HTTPException(status_code=422, detail="Disponível só no Windows.")
        await asyncio.to_thread(set_autostart, payload.autostart)

    await asyncio.to_thread(save_prefs, settings.desktop_settings_path, prefs)
    return _desktop_settings_view(application, prefs)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    """Authenticated text command channel.

    The first message MUST be an auth handshake: {"type": "auth", "token": "..."}.
    Without a valid token the socket is closed with 1008 (policy violation) before
    anything touches the brain or memory — there is no anonymous fallback. Shared
    state is read from app.state, populated at startup.
    """
    await websocket.accept()
    state = websocket.app.state
    store = getattr(state, "user_store", None)
    security = getattr(state, "security", None)
    settings = getattr(state, "settings", None)
    brain = getattr(state, "brain", None)
    if store is None or security is None or settings is None or brain is None:
        await websocket.close(code=1008)
        return

    # First message must be an auth handshake before anything touches the brain.
    try:
        handshake = await websocket.receive_json()
    except Exception:
        await websocket.close(code=1008)
        return
    user: User | None = None
    if isinstance(handshake, dict) and handshake.get("type") == "auth":
        user = await _user_from_token(str(handshake.get("token") or ""), store, security, settings)
    if user is None:
        await websocket.close(code=1008)  # policy violation — never reached the brain
        return

    ctx = await _user_context(user, store, settings)
    try:
        while True:
            text = await websocket.receive_text()
            result = await brain.process_command(text, user.email, user=ctx)
            await websocket.send_json({"reply": result.reply, "speaker": result.speaker})
    except WebSocketDisconnect:
        return


def run() -> None:
    """Run the unified API with uvicorn."""
    import uvicorn

    configure_logging()
    settings = Settings.from_env()
    uvicorn.run(app, host=settings.host, port=settings.port)


if __name__ == "__main__":
    run()
