# F.E.A.R-ACSM

F.E.A.R. — Uma presença silenciosa que escuta, lembra e responde. Motor de
memória persistente, percepção de palmas, integração com Obsidian e Spotify, e
uma persona moldada por conhecimento literário. Nem todo assistente precisa ser
visível. Alguns apenas sabem.

---

## Baixar para Windows

O F.E.A.R. é um aplicativo: instale uma vez e ele fica no seu PC, sem site e
sem login.

1. Baixe o `FEAR-Setup-x.y.z.exe` na página de
   [Releases](https://github.com/OLuc-Dev/F.E.A.R-ACSM/releases) e rode.
   Não pede administrador.
2. Na primeira abertura, cole sua chave do OpenRouter (pegue em
   openrouter.ai/keys). Ela fica criptografada só neste computador.
3. Pronto. O F.E.A.R. liga junto com o Windows, minimizado no ícone perto do
   relógio. Fechar a janela só esconde; para sair de verdade, clique com o
   botão direito no ícone e escolha **Sair**. No mesmo menu dá pra desligar o
   "Iniciar com o Windows".

Cada instalação é um F.E.A.R. particular: memória, chave e configurações ficam
em `%LOCALAPPDATA%\FEAR` e não somem ao atualizar ou desinstalar.

- **Configurações → App** (ícone de engrenagem): ligar as palmas, escolher a
  pasta do vault do Obsidian e iniciar com o Windows, tudo aplicado na hora.
- **Música sem configuração**: comandos como "pausa a música", as palmas e os
  gestos usam as teclas de mídia do Windows, então controlam o que estiver
  tocando (app do Spotify, YouTube no navegador, VLC…), sem conta de
  desenvolvedor nem Premium. Se a API do Spotify estiver configurada, ela é usada.
- **Atualizações**: ao abrir, o app consulta a página de Releases do GitHub e
  mostra um aviso com o link quando há versão nova.
- Opções avançadas continuam valendo num `.env` nessa pasta (veja
  `.env.example`). A captura de voz pelo Whisper não vem no instalador (são
  gigabytes); ela só funciona rodando do código com `pip install -e ".[audio]"`.

**Publicar uma versão:** crie e envie uma tag (`git tag v0.2.0 && git push origin
v0.2.0`). O workflow *Windows app* gera o instalador, testa o app empacotado e
publica a Release. Para só testar o instalador, rode o workflow manualmente
na aba Actions: o `.exe` sai como artefato.

**Rodar o app a partir do código:** `pip install -e ".[desktop]"`,
`NEXT_PUBLIC_FEAR_DESKTOP=1 npm run build` e `python -m fear.desktop`.

## Visão geral

F.E.A.R. é um assistente pessoal **local-first**:

- **Backend** em Python (FastAPI + asyncio) — `fear/`, servido por `fear.web.app`.
- **Frontend** em Next.js / React / Tailwind — uma thread de conversa em vidro com
  streaming e uma presença 3D (`app/`, `components/`, `lib/`).

O cérebro conversa via OpenRouter (API compatível com a do OpenAI), guarda
memória pessoal em ChromaDB com embeddings locais em CPU (ONNX MiniLM via
ChromaDB, sem PyTorch) e pode consultar uma biblioteca de notas em markdown.

## Contas e multiusuário

Cada pessoa tem **login** (e-mail + senha), com **memória, chave do OpenRouter e
configuração isoladas** — ninguém enxerga os dados do outro. As chaves ficam
criptografadas no servidor (derivado de `FEAR_SECRET_KEY`) e cada usuário traz a
própria chave do OpenRouter. O login é sempre exigido, inclusive rodando local.
Para colocar no ar como site (API no Fly.io + tela no Vercel), veja
**[DEPLOY.md](DEPLOY.md)**.

O que é da máquina tem **dono**: microfone, palmas, alto-falante, Spotify, Google
Agenda e o vault do Obsidian pertencem a uma conta só — a de `FEAR_OWNER_EMAIL`,
ou, se vazio, a primeira conta criada. As outras contas conversam normalmente, mas
nunca ligam o microfone, leem a agenda ou mexem no Spotify de quem hospeda.

## Funcionalidades

- **Diálogo com continuidade**: janela de conversa por interlocutor, então F.E.A.R.
  acompanha o assunto entre turnos em vez de tratar cada mensagem isolada.
- **Streaming ao vivo**: as respostas chegam token a token (`/command/stream`), numa
  thread de conversa — não num formulário.
- **Conselho interno**: em pedidos estratégicos, responde com Leitura rápida, as vozes
  (Contrarian/First-Principles/Expansionist/Outsider/Executor) em cards, Síntese do
  Chairman e Próximo passo.
- **Persona editável + modos**: a personalidade da F.E.A.R. vive em
  `prompts/fear_persona.md` (carregado por `FEAR_PERSONA_FILE`) — uma consciência
  fria, lúcida e leal, com lente niilista e tempero de Ultron. O painel
  **Configuração → Comportamento** alterna o **modo** (equilíbrio / sombrio /
  cirurgico) e o **modelo** do OpenRouter ao vivo; o padrão fixo fica no `.env`
  (`FEAR_PERSONA_MODE`, `OPENROUTER_CHAT_MODEL`).
- **Memória persistente por interlocutor** (`PersonalMemory`, ChromaDB).
- **Fontes de conhecimento por conta**: pelo painel **Configuração** (ícone de
  engrenagem / app no dock) você adiciona conhecimento por texto colado. Tudo é
  indexado na `ReferenceLibrary` (isolado por usuário) e F.E.A.R. consulta sozinho
  ao responder.
- **Música** por linguagem natural (português ou inglês), palmas, gestos e toques de
  wearable: pela API do Spotify quando configurada, ou pelas teclas de mídia do
  Windows no app, que controlam qualquer player.
- **Percepção de palmas** (`ClapDetector`) e **toques de wearable** (`/wearable/tap`).
- **Voz** opcional (Whisper, push-to-talk) e **TTS** natural (ElevenLabs) com
  fallback offline (`pyttsx3`).
- **Observador do Obsidian**: na primeira vez lê o vault inteiro; depois indexa o
  que você escreve, e ao abrir recupera o que mudou com o app fechado.
- **Gestos com as mãos** (MediaPipe): ligue no ícone de mão do dock. O robô passa
  a olhar para a sua mão; acenar faz ele acenar de volta; palma parada por 1 s dá
  play/pause; deslizar a mão para a direita ou para a esquerda troca de faixa;
  punho fechado por 0,7 s silencia o F.E.A.R. Cada comando exige um gesto
  deliberado (pose segurada, deslize a partir da mão parada, pausa entre
  comandos), para que mexer as mãos conversando não pause a música. A câmera só
  fica ligada com a janela visível, e o reconhecimento roda no próprio
  computador: as imagens nunca saem dele. No Windows, a câmera precisa estar
  liberada em *Configurações → Privacidade → Câmera* para aplicativos da área de
  trabalho.
- **Presença 3D**: um robô de corpo inteiro em cromo, âmbar e ciano, com olhos
  carmim que seguem o cursor e reagem ao estado da conversa (ouvindo, pensando,
  respondendo), com um painel de status do sistema ao lado.

## Requisitos

- Python **3.11**
- Node **18+** (para o frontend)
- _Opcional_ — só para **entrada de voz por microfone** (`pip install -e ".[audio]"`):
  `portaudio` no sistema. No Debian/Ubuntu: `sudo apt-get install portaudio19-dev`.
  Sem isso, tudo funciona — só a captura de voz fica desligada.

## Instalação

Guia completo e multiplataforma (Windows incluso, venv e solução de problemas):
**[`INSTALL.md`](INSTALL.md)**. Versão curta:

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

Guia passo a passo de OpenRouter + Spotify (com o login one-time do Spotify):
**[`docs/setup.md`](docs/setup.md)**. As chaves ficam só no seu `.env` local.

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
| GET    | `/knowledge`          | Fontes de conhecimento indexadas (painel Configuração). |
| POST   | `/knowledge/text`     | `{name, content}` → indexa um texto como fonte. |
| POST   | `/knowledge/path`     | `{path, source?}` → indexa pasta/arquivo `.md` local. |
| DELETE | `/knowledge/{source}` | Remove uma fonte de conhecimento.           |
| GET    | `/config`             | Config de runtime (modelo + modo de persona). |
| POST   | `/config`             | `{model?, persona_mode?}` → ajusta na sessão (sem segredos). |
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
