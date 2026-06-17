# Setup — OpenRouter + Spotify

Keys live only in your local `.env` (gitignored). Never paste them into chats,
issues, or commits.

## 1. Create your .env

```bash
cp .env.example .env
cat .env.advanced.example >> .env   # optional: ElevenLabs, Obsidian, book library
```

## 2. OpenRouter (the brain)

1. Get a key: https://openrouter.ai/keys
2. Pick a model: https://openrouter.ai/models
3. In `.env`:
   ```
   OPENROUTER_API_KEY=sk-or-...
   OPENROUTER_CHAT_MODEL=anthropic/claude-3.5-sonnet
   ```

Without these, F.E.A.R. still listens and remembers, but replies in fallback mode.

## 3. Spotify (playback control)

1. Create an app: https://developer.spotify.com/dashboard
2. In the app settings, add the redirect URI exactly:
   `http://127.0.0.1:8888/callback`
3. In `.env`:
   ```
   SPOTIPY_CLIENT_ID=...
   SPOTIPY_CLIENT_SECRET=...
   SPOTIPY_REDIRECT_URI=http://127.0.0.1:8888/callback
   ```
4. Authorize once (opens a browser, caches a token):
   ```bash
   python scripts/spotify_login.py
   ```

After that, "toque/pause/próxima música" (and the dock's Spotify button) control playback.

## 4. Run

```bash
./scripts/dev.sh           # backend + frontend together
# or run them separately:
python main.py             # backend  → http://127.0.0.1:8765
npm run dev                # frontend → http://localhost:3000
```

Open http://localhost:3000. The **Sistema** panel shows which integrations are
live — green when configured. Confirm via the API too:

```bash
curl -s http://127.0.0.1:8765/status
```
