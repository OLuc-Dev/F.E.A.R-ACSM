# F.E.A.R-ACSM

F.E.A.R. — Uma presença silenciosa que escuta, lembra e responde. Motor de
memória persistente, percepção de palmas, integração com Obsidian e Spotify, e
uma persona moldada por conhecimento literário. Nem todo assistente precisa ser
visível. Alguns apenas sabem.

---

## Visão geral

F.E.A.R. é um assistente pessoal **local-first**:

- **Backend** em Python (FastAPI + asyncio) — `fear/`, servido por `fear.web.app`.
- **Frontend** em Next.js / React / Tailwind — uma thread de conversa em vidro com
  streaming e uma presença 3D (`app/`, `components/`, `lib/`).
- **UI estática legada** opcional em `frontend/`, servida em `/legacy`.

O cérebro conversa via OpenRouter (API compatível com a do OpenAI), guarda
memória pessoal em ChromaDB com embeddings locais (`sentence-transformers`) e
pode consultar uma biblioteca de notas em markdown.

## Funcionalidades

- **Diálogo com continuidade**: janela de conversa por interlocutor, então F.E.A.R.
  acompanha o assunto entre turnos em vez de tratar cada mensagem isolada.
- **Streaming ao vivo**: as respostas chegam token a token (`/command/stream`), numa
  thread de conversa — não num formulário.
- **Conselho interno**: em pedidos estratégicos, responde com Leitura rápida, as vozes
  (Contrarian/First-Principles/Expansionist/Outsider/Executor) em cards, Síntese do
  Chairman e Próximo passo.
- **Persona editável**: a personalidade da F.E.A.R. vive em `prompts/fear_persona.md`
  (carregado por `FEAR_PERSONA_FILE`). Edite esse arquivo para mudar a voz dele; sem
  ele, uma persona embutida é usada como fallback.
- **Memória persistente por interlocutor** (`PersonalMemory`, ChromaDB).
- **Biblioteca de referência** indexável a partir de notas markdown (`ReferenceLibrary`).
- **Spotify** por linguagem natural, palmas e toques de wearable.
- **Percepção de palmas** (`ClapDetector`) e **toques de wearable** (`/wearable/tap`).
- **Voz** opcional (Whisper, push-to-talk) e **TTS** natural (ElevenLabs) com
  fallback offline (`pyttsx3`).
- **Observador do Obsidian**: indexa notas do vault conforme você escreve.
- **Presença 3D**: cabeça cromada com olhos vermelhos e boca que anima ao falar
  (React Three Fiber), com um painel de status do sistema ao lado.

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
| GET    | `/status`             | Integrações configuradas/ativas (painel Sistema). |
| POST   | `/command`            | `{text, speaker, speak}` → `{reply, ...}`.  |
| POST   | `/command/stream`     | Mesma entrada; resposta em streaming (texto).|
| POST   | `/conversation/reset` | Limpa a janela de diálogo de um interlocutor. |
| GET    | `/memory/{speaker}`   | Memórias recentes de um interlocutor.       |
| POST   | `/wearable/tap`       | Gesto de wearable → comando.                |
| POST   | `/voice/{start,stop,capture-once}` | Captura push-to-talk (se habilitada). |
| WS     | `/ws`                 | Canal de comandos por texto.                |

## Desenvolvimento

```bash
ruff check fear tests          # lint
ruff format --check fear tests # formatação
mypy fear --ignore-missing-imports
pytest                         # testes (cérebro + endpoints web)
npm run typecheck && npm run build
```

Indexar notas markdown para a biblioteca de referência:

```bash
python scripts/index_reference_library.py CAMINHO/DAS/NOTAS --source minhas_notas
```
