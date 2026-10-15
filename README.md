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

- **Converse com ele, estilo J.A.R.V.I.S.**: a tela é só para conversar — sem
  caixa de texto nem histórico. No centro, um núcleo que ouve você (ciano) e
  fala com a voz do F.E.A.R. (âmbar), com legendas só do que está sendo dito
  agora; em volta, o estado do sistema, o relógio e o robô.
  - Abriu a janela, é só falar: ele fica ouvindo e responde em voz alta, sem
    clicar em nada. Enquanto ele fala, não ouve (para não responder a si
    mesmo) e volta a ouvir assim que termina. Com a janela minimizada ou
    fechada na bandeja, o microfone desliga (e a câmera dos gestos também).
  - Um clique no núcleo pausa ou retoma o microfone — ou, enquanto ele fala,
    interrompe a resposta. **Ctrl+Espaço** (segure enquanto fala) ou, com os
    gestos ligados, apontar o indicador para cima por 0,6 s também cortam a
    resposta para você falar na hora.
  - Os gestos com as mãos ficam à esquerda, abaixo de *Sistema*: clique em
    *Gestos com as mãos* (ou no ícone de mão do dock) e a câmera aparece ali,
    com a mão desenhada por cima, o gesto que ele está vendo e a lista do que
    cada gesto faz. Em janelas estreitas, ela fica no canto de cima.
  - A voz: com internet, ele fala com a voz neural Antonio, da Microsoft (a
    mesma do "Ler em voz alta" do Edge), e o texto de cada frase que ele fala
    vai para o serviço de voz da Microsoft. Sem internet, ou se o serviço
    falhar, ele fala com a voz do próprio PC (Piper), sem ficar mudo.
  - Em **Configurações → Comportamento → Voz**: o estilo (*Natural*, o padrão,
    ou *F.E.A.R.*, mais grave e com um leve brilho metálico), *Voz neural
    online* (desligada, a voz é sempre feita no PC), *Ouvir assim que abrir*
    (desligado, você clica no núcleo ou segura Ctrl+Espaço para falar) e
    *Interface só de voz* — desligada, volta o chat escrito, que também aparece
    sozinho se não houver voz disponível.
  - Ele ouve tudo perto do microfone: com música alta nas caixas de som ou
    outras pessoas conversando, pause o microfone ou use fone.
  - O que você fala vira texto no próprio PC (Whisper): o áudio do seu
    microfone nunca sai dele.
  - O Windows precisa liberar o microfone em *Configurações → Privacidade →
    Microfone* para aplicativos da área de trabalho.
- **Configurações → App** (ícone de engrenagem): ligar as palmas, escolher a
  pasta do vault do Obsidian e iniciar com o Windows, tudo aplicado na hora.
- **Música sem configuração**: comandos como "pausa a música", as palmas e os
  gestos usam as teclas de mídia do Windows, então controlam o que estiver
  tocando (app do Spotify, YouTube no navegador, VLC…), sem conta de
  desenvolvedor nem Premium. Se a API do Spotify estiver configurada, ela é usada.
- **Atualizações**: ao abrir, o app consulta a página de Releases do GitHub e
  mostra um aviso com o link quando há versão nova.
- Opções avançadas continuam valendo num `.env` nessa pasta (veja
  `.env.example`).
- O instalador tem cerca de 720 MB porque já traz a voz (reconhecimento e
  fala), que funciona sem internet. A voz local usa o Piper, que é GPL-3.0; a
  lista de componentes e licenças vai junto, em `_internal\THIRD_PARTY_NOTICES.md`
  na pasta do app.

**Publicar uma versão:** crie e envie uma tag (`git tag v0.2.0 && git push origin
v0.2.0`). O workflow *Windows app* gera o instalador, testa o app empacotado e
publica a Release. Para só testar o instalador, rode o workflow manualmente
na aba Actions: o `.exe` sai como artefato.

**Rodar o app a partir do código:** `pip install -e ".[desktop,voice]"`,
`python packaging/fetch_voice_models.py` (baixa os modelos de voz, ~520 MB),
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
  (`FEAR_PERSONA_MODE`, `OPENROUTER_CHAT_MODEL`). Se o modelo sair do ar ou
  atingir o limite, ele responde com outro modelo grátis; quando nenhum consegue,
  diz o motivo (chave recusada, sem créditos, cota grátis do dia, privacidade da
  conta, sem internet).
- **Memória persistente por interlocutor** (`PersonalMemory`, ChromaDB).
- **Fontes de conhecimento por conta**: pelo painel **Configuração** (ícone de
  engrenagem / app no dock) você adiciona conhecimento por texto colado. Tudo é
  indexado na `ReferenceLibrary` (isolado por usuário) e F.E.A.R. consulta sozinho
  ao responder.
- **Música** por linguagem natural (português ou inglês), palmas, gestos e toques de
  wearable: pela API do Spotify quando configurada, ou pelas teclas de mídia do
  Windows no app, que controlam qualquer player.
- **Percepção de palmas** (`ClapDetector`) e **toques de wearable** (`/wearable/tap`).
- **Conversa por voz** na janela: com a janela aberta ele fica ouvindo (cada
  frase é separada no navegador e enviada como WAV) — ou, se preferir, pelo
  microfone do campo de texto (clique, segure, Ctrl+Espaço ou o gesto de
  apontar). O backend transcreve localmente com faster-whisper
  (`/voice/transcribe`) e a resposta é falada frase a frase (`/voice/speak`)
  pela voz neural da Microsoft (edge-tts) quando há internet, e pelo Piper no
  PC quando não há, natural ou no timbre do F.E.A.R. — com a voz do sistema
  como reserva. Sem os modelos, tudo continua por texto e pela voz do navegador.
- **Voz da máquina** (opcional, rodando do código): push-to-talk no microfone do
  servidor (Whisper) e **TTS** natural (ElevenLabs) com fallback offline
  (`pyttsx3`).
- **Observador do Obsidian**: na primeira vez lê o vault inteiro; depois indexa o
  que você escreve, e ao abrir recupera o que mudou com o app fechado.
- **Gestos com as mãos** (MediaPipe): ligue no ícone de mão do dock ou, na
  interface de voz, no cartão *Gestos com as mãos*. O robô passa
  a olhar para a sua mão; acenar faz ele acenar de volta; palma parada por 1 s dá
  play/pause; deslizar a mão para a direita ou para a esquerda troca de faixa;
  punho fechado por 0,7 s silencia o F.E.A.R.; apontar o indicador para cima por
  0,6 s faz ele parar de falar e ouvir você (se ele já está ouvindo, nada muda:
  o que você está dizendo não é cortado; com o microfone pausado ou desligado,
  abre para uma frase). Cada comando exige um gesto
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
- _Opcional_ — para **falar com o F.E.A.R. pela janela** (`pip install -e ".[voice]"`):
  os modelos de voz, baixados com `python packaging/fetch_voice_models.py` e
  apontados por `FEAR_STT_MODEL` e `FEAR_PIPER_VOICE` (veja `.env.example`). O app
  do Windows já vem com eles.
- _Opcional_ — só para a **voz da máquina** (microfone do servidor,
  `pip install -e ".[audio]"`): `portaudio` no sistema. No Debian/Ubuntu:
  `sudo apt-get install portaudio19-dev`. Sem isso, tudo funciona — só essa
  captura fica desligada.

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

Preencha `OPENROUTER_API_KEY` para respostas completas (`OPENROUTER_CHAT_MODEL`
só se quiser fixar um modelo seu).
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
| POST   | `/voice/transcribe`   | Áudio gravado (webm/opus, wav…) → `{text}`, transcrito no próprio PC. |
| POST   | `/voice/speak`        | `{text, style, online}` → a frase falada: MP3 da voz online (Microsoft) ou WAV do Piper (`natural` ou `fear`). |
| POST   | `/voice/{start,stop,capture-once}` | Captura push-to-talk no microfone do servidor (se habilitada). |
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
