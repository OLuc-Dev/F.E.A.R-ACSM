const API_BASE = window.location.origin;

const state = {
  mode: "idle",
  lastReply: "",
};

const elements = {
  commandForm: document.querySelector("#commandForm"),
  speakerInput: document.querySelector("#speakerInput"),
  commandInput: document.querySelector("#commandInput"),
  speakToggle: document.querySelector("#speakToggle"),
  assistantReply: document.querySelector("#assistantReply"),
  connectionStatus: document.querySelector("#connectionStatus"),
  apiStatus: document.querySelector("#apiStatus"),
  voiceStatus: document.querySelector("#voiceStatus"),
  presenceOrb: document.querySelector("#presenceOrb"),
  presenceState: document.querySelector("#presenceState"),
  presenceSubtitle: document.querySelector("#presenceSubtitle"),
  memoryList: document.querySelector("#memoryList"),
  eventTimeline: document.querySelector("#eventTimeline"),
  refreshMemoryButton: document.querySelector("#refreshMemoryButton"),
  captureOnceButton: document.querySelector("#captureOnceButton"),
  startVoiceButton: document.querySelector("#startVoiceButton"),
  stopVoiceButton: document.querySelector("#stopVoiceButton"),
};

function setMode(mode, subtitle) {
  state.mode = mode;
  elements.presenceOrb.classList.remove("idle", "listening", "thinking", "speaking", "error");
  elements.presenceOrb.classList.add(mode);

  const labels = {
    idle: "aguardando sinal",
    listening: "ouvindo",
    thinking: "processando",
    speaking: "respondendo",
    error: "atenção necessária",
  };

  elements.presenceState.textContent = labels[mode] || labels.idle;
  elements.presenceSubtitle.textContent = subtitle || "Silenciosa, atenta, pronta para responder.";
}

function addTimeline(label, text) {
  const entry = document.createElement("div");
  entry.className = "timeline-entry";
  entry.innerHTML = `<strong>${escapeHtml(label)}</strong> ${escapeHtml(text)}`;
  elements.eventTimeline.prepend(entry);

  while (elements.eventTimeline.children.length > 12) {
    elements.eventTimeline.removeChild(elements.eventTimeline.lastChild);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function checkHealth() {
  try {
    const response = await fetch(`${API_BASE}/health`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    elements.connectionStatus.textContent = "online";
    elements.connectionStatus.classList.add("online");
    elements.apiStatus.textContent = data.status || "online";
    setMode("idle");
    addTimeline("system", "API local conectada");
  } catch (error) {
    elements.connectionStatus.textContent = "offline";
    elements.connectionStatus.classList.remove("online");
    elements.apiStatus.textContent = "offline";
    setMode("error", "Não encontrei o servidor local da F.E.A.R.");
    addTimeline("error", "API local indisponível");
  }
}

async function sendCommand(event) {
  event.preventDefault();

  const text = elements.commandInput.value.trim();
  const speaker = elements.speakerInput.value.trim() || "user";
  const speak = elements.speakToggle.checked;

  if (!text) {
    setMode("error", "Digite um comando antes de enviar.");
    return;
  }

  setMode("thinking", "Consultando memória e processando resposta.");
  elements.assistantReply.textContent = "Processando...";
  addTimeline("command", `${speaker}: ${text}`);

  try {
    const response = await fetch(`${API_BASE}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, speaker, speak }),
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `HTTP ${response.status}`);
    }

    const data = await response.json();
    state.lastReply = data.reply || "";
    elements.assistantReply.textContent = state.lastReply || "Sem resposta.";
    elements.commandInput.value = "";

    setMode(speak ? "speaking" : "idle", speak ? "Resposta enviada para o TTS." : "Resposta pronta.");
    addTimeline("reply", state.lastReply.slice(0, 140) || "sem texto");

    setTimeout(() => setMode("idle"), 1600);
    await refreshMemory();
  } catch (error) {
    elements.assistantReply.textContent = `Erro: ${error.message}`;
    setMode("error", "Falha ao enviar comando.");
    addTimeline("error", error.message);
  }
}

async function refreshMemory() {
  const speaker = elements.speakerInput.value.trim() || "user";

  try {
    const response = await fetch(`${API_BASE}/memory/${encodeURIComponent(speaker)}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    renderMemories(data.memories || []);
    addTimeline("memory", `memórias carregadas para ${speaker}`);
  } catch (error) {
    elements.memoryList.innerHTML = `<p class="muted">Não consegui carregar memórias: ${escapeHtml(error.message)}</p>`;
  }
}

function renderMemories(memories) {
  if (!memories.length) {
    elements.memoryList.innerHTML = `<p class="muted">Nenhuma memória recente para este speaker.</p>`;
    return;
  }

  elements.memoryList.innerHTML = "";

  memories.slice(0, 8).forEach((memory) => {
    const item = document.createElement("article");
    item.className = "memory-item";

    const date = memory.timestamp ? new Date(memory.timestamp * 1000).toLocaleString() : "sem data";

    item.innerHTML = `
      <p>${escapeHtml(memory.text || "")}</p>
      <span>${escapeHtml(memory.source || "unknown")} · ${escapeHtml(date)}</span>
    `;

    elements.memoryList.appendChild(item);
  });
}

async function postSimple(endpoint, label, successMode = "idle") {
  try {
    setMode("thinking", "Enviando sinal para o backend local.");
    const response = await fetch(`${API_BASE}${endpoint}`, { method: "POST" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    addTimeline(label, data.status || "ok");
    setMode(successMode);
  } catch (error) {
    addTimeline("error", error.message);
    setMode("error", "Falha ao conversar com o backend local.");
  }
}

elements.commandForm.addEventListener("submit", sendCommand);
elements.refreshMemoryButton.addEventListener("click", refreshMemory);
elements.captureOnceButton.addEventListener("click", () => postSimple("/voice/capture-once", "voice", "listening"));
elements.startVoiceButton.addEventListener("click", () => {
  elements.voiceStatus.textContent = "capturing";
  postSimple("/voice/start", "voice", "listening");
});
elements.stopVoiceButton.addEventListener("click", () => {
  elements.voiceStatus.textContent = "manual";
  postSimple("/voice/stop", "voice", "idle");
});

checkHealth();
setInterval(checkHealth, 30000);
