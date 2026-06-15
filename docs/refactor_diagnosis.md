# Refactor diagnosis

## Entry points found

- `main.py` currently imports `fear.assistant.FearAssistant`, so it still runs the monolithic runtime.
- `fear/assistant.py` is the monolithic runtime. It owns FastAPI routes, wake-word logic, Chroma memory with OpenRouter embeddings, Spotify, TTS, voice recording, and ClapDetector wiring.
- `fear/web/api.py` only re-exports `app` from `fear.assistant`, so it is part of the monolithic path.
- `fear/web/unified_server.py` is the modular runtime. It uses `ConversationalBrain`, `PersonalMemory`, `ReferenceLibrary`, `NaturalTTS`, `VoiceListener`, and `ObsidianWatcher`.
- `fear/web/unified_server_cors.py` wraps the modular app only to add CORS.
- `app/` and `components/` contain the Next.js/shadcn frontend, which talks to `/command` using the modular server contract.
- `frontend/` contains a static legacy UI. It expects the API at `window.location.origin` and therefore only works if served by the backend.

## Duplication confirmed

There are two divergent FastAPI apps today:

1. Monolith: `main.py` -> `fear.assistant`.
2. Modular: `fear.web.unified_server` plus `fear.web.unified_server_cors`.

## Dead code suspicion confirmed

A repository search for `vector_store` returned no imports. `fear/memory/vector_store.py` appears to be unused and can be removed after consolidating on `PersonalMemory`.

## Refactor decision

Keep the modular runtime and make it the only supported backend path. The Next.js app already matches the modular `/command` contract, so the backend default should become `fear.web.unified_server` with built-in CORS.
