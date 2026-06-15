# F.E.A.R-ACSM

F.E.A.R. — Uma presença silenciosa que escuta, lembra e responde. Motor de
memória persistente, percepção de palmas, integração com Obsidian e Spotify, e
uma persona moldada por conhecimento literário. Nem todo assistente precisa ser
visível. Alguns apenas sabem.

---

## Visão geral

F.E.A.R. é um assistente pessoal **local-first**:

- **Backend** em Python (FastAPI + asyncio) — `fear/`, servido por `fear.web.app`.
- **Frontend** em Next.js / React / Tailwind — `app/`, `components/`, `lib/`.
- **UI estática legada** opcional em `frontend/`, servida em `/legacy`.

O cérebro conversa via OpenRouter (API compatível com a do OpenAI), guarda
memória pessoal em ChromaDB com embeddings locais (`sentence-transformers`) e
pode consultar uma biblioteca de notas em markdown.

## Funcionalidades

- **Memória persistente por interlocutor** (`PersonalMemory`, ChromaDB).
- **Biblioteca de referência** indexável a partir de notas markdown (`ReferenceLibrary`).
- **Spotify** por linguagem natural, palmas e toques de wearable.
- **Percepção de palmas** (`ClapDetector`) e **toques de wearable** (`/wearable/tap`).
- **Voz** opcional (Whisper, push-to-talk) e **TTS** natural (ElevenLabs) com
  fallback offline (`pyttsx3`).
- **Observador do Obsidian**: indexa notas do vault conforme você escreve.

## Requisitos

- Python **3.11–3.13**
- Node **18+** (para o frontend)
- `portaudio` no sistema para o `pyaudio` (recursos de áudio).
  No Debian/Ubuntu: `sudo apt-get install portaudio19-dev`.

## Instalação

```bash
# Backend
python -m pip install -e ".[dev]"

# Frontend
npm ci
```

## Configuração

```bash
cp .env.example .env
# recursos avançados (ElevenLabs, Obsidian, biblioteca de livros):
cat .env.advanced.example >> .env
```

Preencha `OPENROUTER_API_KEY` e `OPENROUTER_CHAT_MODEL` para respostas completas.
Sem eles, F.E.A.R. ainda escuta e lembra, mas responde em modo de fallback.

## Como rodar

```bash
# Backend (http://127.0.0.1:8765)
python main.py
# ou: uvicorn fear.web.app:app --host 127.0.0.1 --port 8765

# Frontend (http://localhost:3000)
npm run dev
```

Áudio é opcional e desligado por padrão. Ative com:

```bash
FEAR_ENABLE_VOICE_LISTENER=1 FEAR_ENABLE_CLAP_DETECTOR=1 python main.py
```

## API

| Método | Rota                  | Descrição                                   |
| ------ | --------------------- | ------------------------------------------- |
| GET    | `/health`             | Status do runtime.                          |
| POST   | `/command`            | `{text, speaker, speak}` → `{reply, ...}`.  |
| GET    | `/memory/{speaker}`   | Memórias recentes de um interlocutor.       |
| POST   | `/wearable/tap`       | Gesto de wearable → comando.                |
| POST   | `/voice/{start,stop,capture-once}` | Captura push-to-talk (se habilitada). |
| WS     | `/ws`                 | Canal de comandos por texto.                |

## Desenvolvimento

```bash
ruff check fear tests      # lint
mypy fear --ignore-missing-imports
pytest                     # testes
npm run typecheck && npm run build
```

Indexar notas markdown para a biblioteca de referência:

```bash
python scripts/index_reference_library.py CAMINHO/DAS/NOTAS --source minhas_notas
```
