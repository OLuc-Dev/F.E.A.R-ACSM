# F.E.A.R-ACSM — Contexto do projeto (cole antes de pedir melhorias)

Você é um engenheiro de software sênior / arquiteto me ajudando a evoluir este
projeto. Leia todo o contexto abaixo. Quando eu pedir melhorias, proponha ideias
**concretas, priorizadas (impacto × esforço) e realistas**, respeitando as
restrições. Considere o que **já existe** — não reinvente o que já está feito.
Aponte arquivos/áreas afetadas e sinalize qualquer mudança arriscada.

## 1. O que é

F.E.A.R. é um assistente pessoal de IA, _local-first_ e agora opcionalmente
multiusuário. A personalidade: uma consciência fria, lúcida e leal, com lente
niilista existencial e tempero de Ultron — um companheiro estratégico, não um
chatbot corporativo. A interface é um "deck operacional" escuro, com streaming
de conversa e uma **presença 3D** (cabeça de metal esculpida dentro de um núcleo
de energia dourado que reage ao estado e dá um pulso quando uma memória nova é
gravada).

## 2. Stack

- **Backend:** Python 3.11 (fixo em `>=3.11,<3.12`), FastAPI (app único em
  `fear.web.app`), asyncio, pydantic-settings, injeção de dependência via
  providers. Libs pesadas são importadas "lazy".
- **Memória/IA:** ChromaDB (memória pessoal + biblioteca de conhecimento) com
  embeddings locais em CPU via ONNX MiniLM (`all-MiniLM-L6-v2`, do ChromaDB, sem
  PyTorch), compartilhado entre os stores. LLM via
  **OpenRouter** (cliente compatível com OpenAI). Modelo padrão gratuito:
  `openai/gpt-oss-120b:free`.
- **Auth:** SQLite (usuários), hash de senha PBKDF2 (stdlib), `cryptography`/
  Fernet (tokens de sessão + criptografia das chaves de API por usuário).
- **Frontend:** Next.js 14.2 (App Router, **fixo no 14**), React 18.3,
  TypeScript strict, Tailwind 3.4, framer-motion 11, **React Three Fiber + drei +
  postprocessing** (presença 3D), Web Speech API (TTS no navegador), lucide-react.
- **Integrações:** Spotify, Google Calendar (somente leitura), watcher do
  Obsidian. Áudio opcional (Whisper + pyaudio), atrás do extra `.[audio]`.
- **Infra:** Docker (`Dockerfile`, sem torch) + `fly.toml` (Fly.io) pro backend,
  Vercel pro frontend (ver `DEPLOY.md`). CI no GitHub Actions.

## 3. Arquitetura (como as peças se encaixam)

- `fear/web/app.py` — app FastAPI: rotas, auth, providers, lifespan. Endpoints:
  `/auth/register|login|me|openrouter-key`, `/command`, `/command/stream`
  (streaming), `/memory`, `/memory/forget`, `/knowledge` (listar/texto/apagar),
  `/config`, `/conversation/reset`, `/status`, `/health`, `/wearable/tap`,
  `/voice/*`, `/ws`.
- `fear/brain/async_conversation.py` — `AsyncConversationalBrain`: monta o
  contexto (memória + conhecimento + agenda), fala com o modelo e faz streaming.
  `UserContext` carrega chave/modelo/persona por usuário. Roteamento de intenção
  por **palavra-chave** (Spotify/Agenda). Persona com "conselho interno" de 6 vozes.
- `fear/memory/personal_memory.py` — memória ChromaDB: ids por conteúdo (dedup
  via `upsert`), `forget`, escopo por `user_id`, `recent_for_user`, `claim_unowned`.
- `fear/library/reference_library.py` — conhecimento (markdown/texto), escopo por usuário.
- `fear/auth/` — `security.py` (senha/token/cripto), `store.py` (`UserStore` SQLite).
- `fear/config.py` — `Settings` (pydantic-settings), lê o `.env`.
- `prompts/fear_persona.md` — a personalidade (carregada por `FEAR_PERSONA_FILE`).
- Frontend: `app/page.tsx` (deck + gate de login + aviso de chave),
  `components/ui/fear-presence.tsx` (3D), `settings-panel.tsx`, `auth-panel.tsx`,
  `mac-os-dock.tsx`, `messages.tsx`; `lib/api.ts` (cliente tipado + header de
  auth), `lib/use-conversation.ts`, `lib/use-auth.ts`, `lib/auth.ts`, `lib/speech.ts`.

## 4. Multiusuário e segurança

- **Login obrigatório** quando publicado (opcional rodando local). E-mail +
  senha; sessão via token Fernet que expira.
- **Isolamento por usuário:** memória, conhecimento e config (modelo/persona)
  são por conta — ninguém vê os dados do outro.
- **BYO key:** cada usuário traz a própria chave do OpenRouter, guardada
  **criptografada** (derivada de `FEAR_SECRET_KEY`). O custo de IA é de cada um.

## 5. Persona (o coração)

Definida em `prompts/fear_persona.md`: fria/lúcida/leal, niilista existencial,
tempero de Ultron; conselho interno de 6 vozes (Contrarian, First-Principles,
Expansionist, Outsider, Executor, Chairman) usado só quando agrega; voz do dia a
dia concisa; bloco "o que nunca fazer" (sem clichê de IA, sem textão, sem
filosofia forçada). Travas de lealdade/segurança inegociáveis (ex.: sofrimento
real → sai do personagem e aponta ajuda). Persona é **conteúdo**, não código.

## 6. Convenções e restrições (NÃO violar)

- **Segredos só no `.env` local** — nunca colar em chat, nunca commitar
  (`FEAR_SECRET_KEY`, chaves OpenRouter/Spotify/Google).
- **Next.js fixo no 14.2** — NÃO subir pro 16, NÃO rodar `npm audit fix --force`
  (quebra o app).
- **Python fixo no 3.11.**
- **Persona desacoplada das capacidades:** personalidade no arquivo de prompt;
  ferramentas são código. Adicionar capacidade não deve mudar a personalidade.
- **Degradação graciosa / imports lazy:** o app precisa iniciar e ser testado
  sem o stack de áudio/ML pesado.
- **CI verde é obrigatório:** back = ruff + ruff format + mypy
  (`--ignore-missing-imports`) + pytest; front = prettier + tsc + vitest +
  `next build`.
- O roteamento de intenção "automático" (o modelo escolher a ferramenta) foi
  **descartado de propósito** (complexo demais); mantém-se por palavra-chave.

## 7. Estado atual (já pronto)

Memória com dedup + inspetor + "esquecer"; sistema de contas completo
(cadastro/login/sessão, chave BYO criptografada); isolamento por usuário de
memória/conhecimento/config; login obrigatório; remoção da brecha que lia
arquivos do servidor; presença 3D repaginada (núcleo dourado + flash de memória
de 3,2s + calibração "premium"); persona afiada; arquivos de deploy
(Docker/Fly/Vercel/DEPLOY.md). Testes: ≈72 no back, 9 no front, CI verde.

## 8. Lacunas conhecidas (bons alvos de melhoria)

- **Auth:** sem "esqueci a senha", sem verificação de e-mail, sem limite de
  tentativas de login, cadastro aberto, tokens sem revogação (logout só descarta
  no cliente).
- **Dados:** SQLite + ChromaDB são de máquina única (escalar = Postgres +
  storage compartilhado).
- **Custo/perf (resolvido):** embeddings agora rodam em ONNX (MiniLM do ChromaDB,
  sem PyTorch), compartilhados entre os stores — imagem e RAM enxutas (~1 GB).
- Sem limites/visibilidade de uso por usuário; disco de conhecimento sem teto.
- Queries reais do ChromaDB não têm teste em CI (só os helpers puros, ex. `_scope`).
- O campo "Interlocutor" na UI ficou meio redundante depois do login.

## 9. Como responder aos meus pedidos

Quando eu disser "melhore X" ou "o que dá pra melhorar": dê 3–7 propostas
**priorizadas por impacto × esforço**, cada uma com (a) o porquê, (b) arquivos/
áreas afetadas, (c) risco/efeito colateral, (d) se é rápida ou uma rodada
dedicada. Respeite as restrições da seção 6. Se algo que eu pedir já existir, me
avise. Prefira profundidade a listas rasas. Sinalize claramente qualquer
"modificação extrema" (que muda comportamento, dados ou segurança).
