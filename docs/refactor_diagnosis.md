# Runtime architecture

> Status: the runtime consolidation described below is **done**. This file is
> kept as a record of the decision.

## Single runtime

There is now **one** FastAPI application: `fear.web.app`.

- It uses a `lifespan` context manager, the async `AsyncConversationalBrain`,
  built-in CORS, and starts the voice listener, clap detector, and Obsidian
  watcher only when their environment flags are set.
- `main.py` launches it; `fear.web.api` re-exports `app` for ASGI servers
  (`uvicorn fear.web.api:app` or `uvicorn fear.web.app:app`).

## What was removed and why

The repository previously carried several divergent FastAPI apps and dead
modules. They were removed in favor of `fear.web.app`:

- `fear/assistant.py` — the monolith (its own Chroma/OpenRouter-embeddings path).
- `fear/brain/conversation.py` — the synchronous brain, superseded by the async one.
- `fear/web/unified_server.py` — `@app.on_event`, synchronous brain, no CORS.
- `fear/web/unified_server_cors.py` — wrapper that double-added CORS.
- `fear/web/runtime.py` — a near-duplicate that raised `NameError` on import
  (it called module-level helpers defined later in the file).
- `fear/memory/vector_store.py` and `fear/integrations/spotify_shortcuts.py` — unused.
- `fear/audio/{microphone,speech_to_text,text_to_speech,wake_word}.py` — unused
  duplicates of `voice_listener` / `natural_tts`.
- `run_fear.py` and `scripts/apply_runtime_refactor.py` — obsolete launchers/scripts.

## Frontends

- `app/` + `components/` — the Next.js UI, which talks to the `/command` contract.
- `frontend/` — a static legacy UI, served at `/legacy` when present.
