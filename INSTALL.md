# Instalação do F.E.A.R.

Guia completo pra rodar localmente em **macOS, Linux e Windows**.

## Pré-requisitos

- **Python 3.11**
- **Node 18+** (vem com o npm)
- **portaudio** — o pacote `pyaudio` compila em cima dele, então é necessário mesmo com o áudio desligado:
  - macOS: `brew install portaudio`
  - Ubuntu/Debian: `sudo apt-get install -y portaudio19-dev`
  - Windows: normalmente instala via wheel; se falhar, `pip install pipwin && pipwin install pyaudio`

## 1. Baixar o projeto

Clone numa pasta **nova/vazia** (se a pasta já existir, o `git clone` falha com _"destination path already exists"_):

```bash
git clone <URL-do-seu-repo> F.E.A.R-ACSM
cd F.E.A.R-ACSM
```

## 2. Backend (ambiente virtual + dependências)

**macOS / Linux:**

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e .
```

**Windows (PowerShell):**

```powershell
py -3.11 -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -e .
```

> Se o PowerShell bloquear a ativação (_"execução de scripts desabilitada"_):
> `Set-ExecutionPolicy -Scope Process Bypass -Force` e rode o `Activate` de novo.
>
> Para também rodar testes/lint: `pip install -e ".[dev]"`.

## 3. Frontend

```bash
npm ci
```

> ⚠️ **Não rode `npm audit fix --force`.** Ele sobe o Next para a v16 e **quebra o projeto** (que é fixado no Next 14 — o erro típico é _"Couldn't find a pages directory"_). Os ~95 avisos do `npm audit` são de dependências de build e **não atrapalham**.

## 4. Configurar

```bash
cp .env.example .env          # Windows: copy .env.example .env
```

Edite o `.env` e preencha a chave do OpenRouter (https://openrouter.ai/keys):

```
OPENROUTER_API_KEY=sk-or-...
```

A chave fica **só no seu `.env` local — nunca faça commit dela.** O modelo já vem no padrão gratuito (`openai/gpt-oss-120b:free`). Sem chave, o F.E.A.R. ainda escuta e lembra, mas responde em modo de fallback.

Recursos avançados (Obsidian, Spotify, ElevenLabs):

```bash
cat .env.advanced.example >> .env    # Windows: type .env.advanced.example >> .env
```

## 5. Rodar

**Tudo junto** (macOS/Linux/WSL/Git Bash, com a venv ativa):

```bash
./scripts/dev.sh
```

**Ou separado** (e o jeito do Windows) — dois terminais:

```bash
python main.py    # backend  → http://127.0.0.1:8765
npm run dev       # frontend → http://localhost:3000
```

Abra **http://localhost:3000**. O painel **Sistema** fica verde conforme as integrações estão configuradas.

## Integrações opcionais

- **OpenRouter** — `OPENROUTER_API_KEY` no `.env`. Trocar o modelo ao vivo: painel **Configuração → Comportamento**.
- **Obsidian** — `OBSIDIAN_VAULT_PATH` no `.env` apontando para a **pasta do vault** (no Windows use barras `/`). Reinicie o backend.
- **Spotify** — `SPOTIPY_*` no `.env` e depois `python scripts/spotify_login.py` (uma vez). Passo a passo: [`docs/setup.md`](docs/setup.md).

## Solução de problemas

- **Falha ao instalar `pyaudio`** → faltou o `portaudio` (veja Pré-requisitos).
- **`npm run dev` dá _"Couldn't find a pages directory"_** → cópia incompleta do repo **ou** o Next foi quebrado por `npm audit fix --force`. Conserto:
  ```powershell
  git checkout -- package.json package-lock.json
  Remove-Item -Recurse -Force node_modules   # macOS/Linux: rm -rf node_modules
  npm ci
  ```
- **A venv não ativa no PowerShell** → `Set-ExecutionPolicy -Scope Process Bypass -Force`.
- **`./scripts/dev.sh` não roda no Windows** → use os dois comandos separados do passo 5.
- **O rosto 3D não aparece** → é WebGL; use um navegador recente (Chrome/Edge/Firefox) com aceleração de hardware ligada.
- **Frontend não fala com o backend** → confira que `python main.py` está na porta 8765 e que `NEXT_PUBLIC_FEAR_API_BASE` no `.env` aponta para `http://127.0.0.1:8765`.
