# Colocar a F.E.A.R. no ar (para seus amigos usarem)

Guia direto pra subir a F.E.A.R. como um site com login. São **duas partes**:

- **API (o cérebro)** → Fly.io (roda o Python, guarda memória e contas).
- **Tela (o site)** → Vercel (o Next.js; de graça).

> Não precisa decorar nada. Faz na ordem. Onde tiver `<...>`, troque pelo seu valor.
> Se travar em algum passo, me chama que a gente resolve junto.

---

## Antes de começar

- Uma conta no [Fly.io](https://fly.io) e o `flyctl` instalado (`fly` no terminal).
- Uma conta no [Vercel](https://vercel.com) (dá pra logar com o GitHub).
- O repositório no GitHub (já está).
- Uma chave secreta longa. Gere uma com:
  ```
  python -c "import secrets; print(secrets.token_urlsafe(48))"
  ```
  Guarde — é o `FEAR_SECRET_KEY`. Ela assina os logins e criptografa as chaves dos usuários.
  Em produção (`FEAR_ENV=production`) o backend **recusa subir sem ela** — de propósito, pra
  não gerar uma chave efêmera que deslogaria todo mundo a cada reinício.

---

## Passo 1 — API no Fly.io

Na raiz do projeto:

```bash
fly launch --no-deploy          # escolha um nome (ex: fear-luc) e a região gru (São Paulo)
fly volumes create fear_data -s 1   # disco de 1 GB pra memória + contas
fly secrets set FEAR_ENV=production FEAR_SECRET_KEY="<a chave que você gerou>"
fly deploy
```

O `fly launch` vai ler o `Dockerfile` e o `fly.toml` que já estão no projeto.
Se ele reescrever o `app = "..."` no `fly.toml` com o nome que você escolheu, ótimo.

No fim, sua API fica em algo como `https://fear-luc.fly.dev`. Teste:

```bash
curl https://<seu-app>.fly.dev/health      # deve responder {"status":"ok"}
```

## Passo 2 — Tela no Vercel

1. No Vercel: **Add New → Project** e importe este repositório.
2. Em **Environment Variables**, adicione:
   - `NEXT_PUBLIC_FEAR_API_BASE` = `https://<seu-app>.fly.dev`
3. **Deploy**. A tela sobe em algo como `https://fear-luc.vercel.app`.

## Passo 3 — Ligar os dois (importante)

A API só aceita a tela se você liberar o endereço dela. Volte ao terminal:

```bash
fly secrets set FEAR_CORS_ORIGINS="https://<seu-front>.vercel.app"
```

(Isso reinicia a API sozinho.) Pronto — tela e cérebro conversando.

## Passo 4 — Primeiro acesso

1. Abra `https://<seu-front>.vercel.app`.
2. Clique no ícone de pessoa (canto superior direito) → **Criar conta**.
3. Depois de entrar, cole **sua chave do OpenRouter** ([pegue aqui](https://openrouter.ai/keys)).
4. Manda ver. Cada amigo faz o mesmo: própria conta, própria chave, própria memória.

---

## Quanto custa

- **Vercel (tela):** grátis pra esse uso.
- **Fly.io (API):** uns **US$ 5–10/mês**. Com `auto_stop_machines` ligado (já está no
  `fly.toml`), a máquina dorme quando ninguém usa e acorda no primeiro acesso — então
  em grupo pequeno, tende ao piso. O disco de 1 GB é uns centavos.
- **IA:** cada usuário paga a própria (traz a própria chave do OpenRouter). Custo seu: zero.

## Observações

- **Suas memórias antigas:** rodando localmente, depois de criar sua conta, dá pra trazê-las
  pra ela com `python scripts/claim_memories.py <seu-email>` (precisa do mesmo `FEAR_SECRET_KEY`).
  No servidor novo a memória começa limpa de qualquer forma.
- **Deixar mais barato depois:** dá pra trocar o motor de embeddings (hoje usa PyTorch, que
  pesa) por uma versão leve e rodar numa máquina menor. É uma otimização que a gente faz
  junto quando quiser cortar custo — não é necessária pra funcionar.
- **A primeira subida** costuma pedir um ajuste ou outro (é normal). Me chama que eu acompanho.
