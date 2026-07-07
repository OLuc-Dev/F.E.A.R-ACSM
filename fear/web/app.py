from __future__ import annotations

import asyncio
import hmac
import logging
import os
import secrets
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Any

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from fear.auth import EmailTaken, Security, TokenError, User, UserStore
from fear.brain.async_conversation import (
    DEFAULT_PERSONA_MODE,
    PERSONA_MODES,
    AsyncConversationalBrain,
    UserContext,
)
from fear.config import DEFAULT_CHAT_MODEL, Settings
from fear.input.wearable_taps import GestureName, WearableTapEvent, gesture_to_command
from fear.library.reference_library import ReferenceLibrary
from fear.logging_config import configure_logging
from fear.memory.embedding import LocalEmbedding
from fear.memory.personal_memory import PersonalMemory
from fear.runtime_state import load_runtime_config
from fear.web.ratelimit import RateLimiter

if TYPE_CHECKING:
    from fear.audio.voice_listener import TranscriptEvent

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
    """Response body for /memory/{speaker}."""

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
    persona_mode: str
    persona_modes: list[str]


class ConfigUpdate(BaseModel):
    """Partial update for runtime configuration. Secrets are never accepted here."""

    model: str | None = None
    persona_mode: str | None = None


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


def _normalize_email(email: str) -> str:
    """Lowercase + validate an email's shape (without the email-validator dep)."""
    cleaned = email.strip().lower()
    local, _, domain = cleaned.partition("@")
    if not local or "." not in domain or domain.startswith(".") or domain.endswith("."):
        raise HTTPException(status_code=422, detail="E-mail inválido.")
    return cleaned


async def _user_context(user: User | None, store: UserStore) -> UserContext | None:
    """Build the brain's per-user context, including the decrypted OpenRouter key."""
    if user is None:
        return None
    api_key = await asyncio.to_thread(store.get_openrouter_key, user.id)
    return UserContext(
        user_id=user.id,
        api_key=api_key,
        chat_model=user.chat_model,
        persona_mode=user.persona_mode,
    )


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


async def process_text_command(application: FastAPI, text: str, speaker: str):
    """Process a text command through the configured brain (used by /ws and callbacks)."""
    return await application.state.brain.process_command(text, speaker)


async def process_voice_event(application: FastAPI, event: TranscriptEvent) -> None:
    """Process a transcript produced by the optional background voice listener."""
    result = await process_text_command(application, event.message, event.speaker)
    if result.reply:
        await application.state.tts.say(result.reply)


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
    from fear.integrations.spotify_client import SpotifyClient
    from fear.memory.obsidian_watcher import ObsidianWatcher

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
    application.state.memory = memory
    application.state.reference_library = reference_library
    application.state.spotify = spotify
    application.state.calendar = calendar
    application.state.security = security
    application.state.user_store = user_store
    application.state.rate_limiter = rate_limiter
    application.state.tts = NaturalTTS()
    application.state.brain = AsyncConversationalBrain(
        settings=settings,
        memory=memory,
        reference_library=reference_library,
        spotify=spotify,
        calendar=calendar,
    )

    # Re-apply the panel's last model/mode choice on top of the .env defaults.
    overrides = load_runtime_config(settings.chroma_path)
    model_override = overrides.get("model")
    if isinstance(model_override, str):
        application.state.brain.set_chat_model(model_override)
    mode_override = overrides.get("persona_mode")
    if isinstance(mode_override, str):
        try:
            application.state.brain.set_persona_mode(mode_override)
        except ValueError:
            logger.warning("Ignoring unknown persisted persona mode: %s", mode_override)

    application.state.loop = asyncio.get_running_loop()
    application.state.voice_listener = None
    application.state.obsidian_watcher = None
    application.state.clap_detector = None

    obsidian_path = os.getenv("OBSIDIAN_VAULT_PATH", "").strip()
    if obsidian_path:
        watcher = ObsidianWatcher(
            vault_path=obsidian_path,
            memory=memory,
            speaker=os.getenv("OBSIDIAN_SPEAKER", "fear_user"),
        )
        watcher.start()
        application.state.obsidian_watcher = watcher

    if env_bool("FEAR_ENABLE_VOICE_LISTENER", default=False):
        # Imported here so the heavy audio stack (whisper, pyaudio) is only
        # needed when voice input is explicitly enabled — install it with
        # `pip install -e ".[audio]"`.
        from fear.audio.voice_listener import VoiceListener

        def on_transcript(event: TranscriptEvent) -> None:
            loop = application.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(process_voice_event(application, event))
            )

        listener = VoiceListener(
            on_transcript=on_transcript,
            model_name=settings.whisper_model_name,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        listener.start()
        application.state.voice_listener = listener

    if env_bool("FEAR_ENABLE_CLAP_DETECTOR", default=False):
        from fear.input.clap_detector import ClapDetector

        def on_double_clap() -> None:
            loop = application.state.loop
            loop.call_soon_threadsafe(
                lambda: asyncio.create_task(
                    process_text_command(application, "toggle Spotify playback", "clap")
                )
            )

        clap_detector = ClapDetector(
            on_double_clap=on_double_clap,
            threshold=settings.clap_threshold,
            sample_rate=settings.sample_rate,
            chunk_size=settings.chunk_size,
        )
        clap_detector.start()
        application.state.clap_detector = clap_detector

    try:
        yield
    finally:
        active_listener = getattr(application.state, "voice_listener", None)
        if active_listener is not None:
            active_listener.stop()

        active_watcher = getattr(application.state, "obsidian_watcher", None)
        if active_watcher is not None:
            active_watcher.stop()

        active_clap_detector = getattr(application.state, "clap_detector", None)
        if active_clap_detector is not None:
            active_clap_detector.stop()

        active_store = getattr(application.state, "user_store", None)
        if active_store is not None:
            active_store.close()


app = FastAPI(title="F.E.A.R. Unified API", lifespan=lifespan)
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
)


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Log unhandled errors and return a clean payload instead of a stack trace."""
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500, content={"detail": "Internal error. The incident was logged."}
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
    _rate_limit(request, limiter, "register")
    # Optional closed registration: when FEAR_INVITE_CODE is set, require it.
    if settings.invite_code and not hmac.compare_digest(payload.invite_code, settings.invite_code):
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
    limiter: RateLimiter = Depends(get_rate_limiter),
) -> AuthResponse:
    """Exchange email + password for a session token."""
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
) -> StatusResponse:
    """Report which integrations are configured/active (drives the system panel)."""
    spotify = getattr(request.app.state, "spotify", None)
    calendar = getattr(request.app.state, "calendar", None)
    return StatusResponse(
        assistant=settings.assistant_name,
        openrouter=bool(settings.openrouter_api_key and settings.openrouter_chat_model),
        memory=getattr(request.app.state, "memory", None) is not None,
        voice=getattr(request.app.state, "voice_listener", None) is not None,
        spotify=bool(spotify is not None and spotify.is_configured),
        obsidian=getattr(request.app.state, "obsidian_watcher", None) is not None,
        calendar=bool(calendar is not None and calendar.is_configured),
    )


@app.post("/command", response_model=CommandResponse)
async def command(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
    tts: Any = Depends(get_tts),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> CommandResponse:
    """Process a text command and optionally speak it locally."""
    ctx = await _user_context(user, store)
    result = await brain.process_command(payload.text, payload.speaker, user=ctx)

    if payload.speak and result.reply:
        audio_path = await tts.say(result.reply)
        if audio_path is not None:
            try:
                audio_path.unlink(missing_ok=True)
            except OSError:
                pass

    return CommandResponse(reply=result.reply, speaker=result.speaker, audio_file=None)


@app.post("/command/stream")
async def command_stream(
    payload: CommandRequest,
    brain: AsyncConversationalBrain = Depends(get_brain),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> StreamingResponse:
    """Stream the reply as plain-text chunks as the model produces them."""
    ctx = await _user_context(user, store)

    async def generate() -> AsyncIterator[str]:
        async for chunk in brain.stream_command(payload.text, payload.speaker, user=ctx):
            yield chunk

    # Disable proxy/browser buffering so tokens reach the client as they are produced.
    return StreamingResponse(
        generate(),
        media_type="text/plain; charset=utf-8",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
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
    brain: AsyncConversationalBrain = Depends(get_brain),
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> CommandResponse:
    """Process a wearable tap as a command, on the signed-in user's context."""
    text = gesture_to_command(WearableTapEvent(payload.gesture, payload.device_id))
    ctx = await _user_context(user, store)
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


def _user_config(user: User) -> ConfigResponse:
    """A user's effective model + persona mode (their choice, or the defaults)."""
    return ConfigResponse(
        model=user.chat_model or DEFAULT_CHAT_MODEL,
        model_default=DEFAULT_CHAT_MODEL,
        persona_mode=user.persona_mode or DEFAULT_PERSONA_MODE,
        persona_modes=list(PERSONA_MODES.keys()),
    )


@app.get("/config", response_model=ConfigResponse)
async def config_get(user: User = Depends(get_current_user)) -> ConfigResponse:
    """Return the signed-in user's own model + persona choices."""
    return _user_config(user)


@app.post("/config", response_model=ConfigResponse)
async def config_set(
    payload: ConfigUpdate,
    user: User = Depends(get_current_user),
    store: UserStore = Depends(get_user_store),
) -> ConfigResponse:
    """Update the user's own chat model and/or persona mode (no secrets)."""
    model: str | None = None
    persona_mode: str | None = None
    if payload.model is not None:
        model = payload.model.strip()
    if payload.persona_mode is not None:
        persona_mode = payload.persona_mode.strip().lower()
        if persona_mode not in PERSONA_MODES:
            raise HTTPException(status_code=422, detail="Modo de persona inválido.")

    if model is not None or persona_mode is not None:
        await asyncio.to_thread(
            store.set_preferences, user.id, chat_model=model, persona_mode=persona_mode
        )
    refreshed = await asyncio.to_thread(store.get_by_id, user.id)
    return _user_config(refreshed or user)


@app.post("/voice/start")
async def voice_start() -> dict[str, str]:
    """Start push-to-talk capture when the optional voice listener is enabled."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.begin_capture()
    return {"status": "capturing"}


@app.post("/voice/stop")
async def voice_stop() -> dict[str, str]:
    """Stop push-to-talk capture."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.end_capture()
    return {"status": "paused"}


@app.post("/voice/capture-once")
async def voice_capture_once() -> dict[str, str]:
    """Capture one voice chunk when the optional voice listener is enabled."""
    listener = getattr(app.state, "voice_listener", None)
    if listener is None:
        return {"status": "disabled", "hint": "Set FEAR_ENABLE_VOICE_LISTENER=1"}

    listener.capture_once()
    return {"status": "queued"}


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

    ctx = await _user_context(user, store)
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
