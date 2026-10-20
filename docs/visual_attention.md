# Visual Attention — primeira integração experimental

Análise e implementação local em 20/10/2026, a partir do ramo `main` de
[OLuc-Dev/F.E.A.R-ACSM](https://github.com/OLuc-Dev/F.E.A.R-ACSM).
O código foi obtido pelo arquivo público do GitHub. A instalação de Git disponível
não tinha o auxiliar HTTPS; a cópia de trabalho tem um histórico local de referência,
sem o histórico original. A integração deve ser revisada em um pull request em
rascunho antes de entrar no ramo principal.

## O que já existia e onde a visão entra

| Parte | Implementação existente | Integração preparada |
| --- | --- | --- |
| Interface | Next.js 14, React 18, TypeScript, presença 3D | Novo laboratório `/attention`, acessível pelo ícone “Olhar (experimental)” |
| Câmera | MediaPipe para gestos em Web Worker | FaceLandmarker no mesmo pacote, em um worker próprio e carregado sob demanda |
| Conversa | `lib/api.ts`, FastAPI, comandos normais e streaming | Campo opcional `visual_attention` nos dois endpoints |
| Cérebro | `fear/brain/async_conversation.py`, OpenRouter/Ollama e fallback | Observação textual apenas no contexto do turno atual |
| Memória | ChromaDB/ONNX e histórico por usuário | Snapshot fora da memória; resposta de turno visual sem gravação automática em `assistant_reply` |
| Desktop | Python 3.11, pywebview/WebView2 e exportação estática | Entrada `/attention.html` no build do Windows |

As dependências canônicas continuam em `pyproject.toml` e `package-lock.json`.
Não foi adicionada dependência npm/Python nem alterada a versão de Next/Python.
Foi acrescentado o modelo oficial FaceLandmarker, com origem, licença e SHA-256 em
`public/mediapipe/NOTICE.txt`. O runtime WASM continua vindo do script já existente.

O `gazeRef` que existia em `app/page.tsx` é a posição da **mão**, usada para
animar os olhos do robô. Ele não era rastreamento do olhar humano.

## O que foi implementado

```text
Webcam, mediante botão Iniciar câmera
  → FaceLandmarker local, em Web Worker, até 10 frames/s
  → posições relativas de íris + geometria aproximada nariz/olhos
  → regressão calibrada pelo usuário em 9 alvos
  → validação com amostras de 4 alvos diferentes
  → estimativa (x, y) em pixels CSS do viewport
  → cartão explicitamente marcado nesta página
  → tecla G / botão Perguntar
  → coordenada + texto limitado no comando
  → resposta do F.E.A.R.
```

O ajuste usa a mediana de pelo menos 10 frames por alvo, depois de 500 ms para
estabilizar o olhar. A validação mede o erro RMS das predições individuais em
quatro posições novas. O laboratório exige erro de no máximo 12% da menor
dimensão da janela. Esse é um limite experimental do produto, sem garantia
científica de precisão. O erro de validação é mostrado na interface.

Sem validação aceita, o botão de pergunta pelo olhar não fica disponível.
Frames sem olhos visíveis, blinks, extrapolação e pontos antigos são descartados.
Mudanças no tamanho, posição ou escala da janela invalidam a calibração. Perda
de foco também exige recalibrar. Ocultar a página ou sair dela desliga a câmera;
retomar exige uma ação explícita. Uma inferência por vez evita acumular frames.

O laboratório é uma página separada. Abrir essa página encerra o fluxo anterior
de gestos/voz pela desmontagem da tela principal. Ainda não há dois consumidores
simultâneos nem compartilhamento de câmera entre gestos e atenção.

## Limites que precisam ficar claros

- **Somente a própria página do laboratório.** Não lê YouTube, outros sites,
  documentos, janelas do Windows ou outro monitor. Os cartões são exemplos
  controlados; o modelo de conversa recebe texto, sem imagem da webcam/tela.
- **Ainda precisa de teste com sua webcam.** Iluminação, óculos, câmera e postura
  podem impedir a calibração. O protótipo não promete indicar um botão pequeno.
- Mantenha cabeça, distância e câmera nas mesmas posições. As features normalizadas
  não detectam todo deslocamento da cabeça; recalibre se mudar de postura.
- A coordenada usa o viewport em pixels CSS, sem conversão para coordenadas
  físicas/globais do Windows. O layout pode rolar: o alvo DOM é resolvido no
  instante da pergunta, usando o conteúdo que está visível naquele momento.
- O assistente não conclui “tédio” ou outro estado emocional a partir do olhar.
  Ações e intervenções proativas ficam para etapas posteriores.

MediaPipe fornece landmarks, **não** coordenadas de olhar no monitor. A regressão
calibrada é o experimento acrescentado aqui. Gaze-LLE estima alvos na imagem de
uma cena; não é uma conversão direta webcam → ponto no monitor.
Fontes primárias: [FaceLandmarker Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker/web_js),
[MediaPipe Iris](https://chuoling.github.io/mediapipe/solutions/iris.html) e
[Gaze-LLE](https://github.com/fkryan/gazelle).

## Dados e conversa

O contrato em `fear/attention.py` valida coordenadas finitas, limites do viewport,
origem, horário, erro de calibração e tamanho do texto. Observações com mais de
10 segundos ou relógio mais de 10 segundos à frente são ignoradas, inclusive
depois das consultas assíncronas do cérebro.

Texto de um cartão é dado não confiável, em uma mensagem separada. Ele não é
acrescentado à persona e não autoriza ferramentas/ações. O roteamento atual de
música/agenda continua recebendo apenas a pergunta original.

O snapshot bruto não é colocado em memória ou histórico. A resposta pode citar o
cartão e continua no histórico temporário da conversa; a gravação automática
dessa resposta no ChromaDB é suprimida no turno visual. A pergunta original
continua sendo registrada como antes. O contexto pode ir ao provedor escolhido
para a conversa: usar OpenRouter envia o texto selecionado à nuvem; usar Ollama
mantém esse processamento no computador.

## Como experimentar

Use uma cópia do projeto com as mudanças aplicadas, Python 3.11 e o ambiente de
desenvolvimento que o projeto já utiliza. O instalador antigo não recebe esses
arquivos automaticamente.

1. Instale as dependências existentes: `pip install -e ".[dev]"` e `npm ci`.
2. Inicie o backend e a interface conforme `docs/setup.md`. O script anterior ao
   `npm run dev` copia o WASM do MediaPipe automaticamente.
3. Entre no F.E.A.R. e configure um modelo de conversa, na nuvem ou no Ollama.
4. Abra **Olhar (experimental)** no dock, ou `/attention` na interface em desenvolvimento.
5. Clique em **Iniciar câmera**, depois **Calibrar 9 pontos**.
6. Fixe o olhar no círculo. Ao completar as amostras, pressione **Espaço** sem
   desviar o olhar. Repita a calibração e os quatro pontos de validação.
7. Se aceita, olhe para um dos cartões e pressione **G** para perguntar.

No build estático do Windows, o arquivo é `/attention.html`. Voltar ao F.E.A.R.
fecha a câmera do laboratório. O modo experimental não ativa câmera sozinho.

## Validação realizada

- Matemática executada em Node: ajuste com amostras sintéticas, predição em
  posições novas, erro de validação, entradas inválidas, extrapolação e blinks.
- Contrato executado com Pydantic real: limites, NaN/infinito, viewport,
  frescor e serialização do contexto; 14 entradas inválidas rejeitadas.
- Fluxo da interface executado em React 18/Edge sem interface visível, com tracker
  e API simulados: opt-in, calibração 9+4, pergunta G com conteúdo correto,
  invalidação por resize e encerramento quando a página fica oculta.
- Parse sintático de TypeScript/TSX, compilação sintática Python, formatação dos
  arquivos TypeScript alterados com Prettier 3.8.4 e verificação de whitespace.

**Não executados:** suíte pytest/Vitest, checagem de tipos, Ruff/Mypy e builds
Next.js normal/Windows. Os registros de pacotes estavam bloqueados nesta rede.
O Python autorizado disponível é 3.12; a execução de outro Python foi bloqueada
por política do Windows. O projeto permanece declarado para Python 3.11.
Não foi acionada webcam/microfone nem usado um modelo de conversa real.

Os testes do projeto foram ampliados para contrato/API/cérebro, matemática/DOM,
worker, ciclo de câmera e fluxo do laboratório. Antes de integrar no ramo
principal, rode os checks já definidos na CI, incluindo os dois builds da interface.

## Evolução recomendada

1. **Medir com seu equipamento:** confirmar taxa de calibrações aceitas, erro e
   estabilidade em cartões grandes; ajustar o estimador com dados reais.
2. **Levar à interface principal:** compartilhar a fonte de câmera com gestos,
   conectar ao envio de voz e congelar a observação no início do comando.
   Manter coleta opt-in e observações limitadas ao turno.
3. **Autorizar contexto externo:** escolher captura de uma janela/monitor ou
   extensão do navegador. Mapear DPI, escala, origem do monitor e área capturada;
   só então recortar a região e resolver texto/elementos/OCR ou visão.
4. **Adicionar diálogo proativo:** trabalhar com sinais observáveis e perguntar
   ao usuário se quer ajuda, com limites de frequência. Não tratar expressão
   facial ou fixação como diagnóstico emocional.

A etapa 1 desta lista é a próxima verificação necessária. A funcionalidade externa
do exemplo “olhar para um vídeo e o JARVIS entender o conteúdo” ainda depende
das etapas 2 e 3. A captura de outra superfície é uma integração separada:
[elementFromPoint](https://drafts.csswg.org/cssom-view/#dom-document-elementfrompoint)
opera no documento atual; [Screen Capture](https://w3c.github.io/mediacapture-screen-share/)
fornece imagem de uma superfície selecionada pelo usuário.
