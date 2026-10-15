// Typed client for the F.E.A.R. backend: one place for endpoints, shapes and errors.

import { authHeaders } from "@/lib/auth";
import { IS_DESKTOP } from "@/lib/desktop";

// Resolve the backend base URL. An explicit NEXT_PUBLIC_FEAR_API_BASE always
// wins; otherwise, in the browser, talk to the same host that served the page —
// so opening the app from a phone at http://<pc-ip>:3000 just reaches the
// backend at http://<pc-ip>:8765 with no config. Falls back to localhost (SSR).
function resolveApiBase(): string {
  // The desktop app's backend serves this page, so the API is same-origin.
  if (IS_DESKTOP) return "";
  const explicit = process.env.NEXT_PUBLIC_FEAR_API_BASE;
  if (explicit) return explicit;
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:8765`;
  }
  return "http://127.0.0.1:8765";
}

export const API_BASE = resolveApiBase();

export interface CommandRequest {
  text: string;
  speaker: string;
  speak?: boolean;
}

export interface CommandResponse {
  reply: string;
  speaker: string;
  audio_file: string | null;
}

export interface MemoryItem {
  id: string;
  text: string;
  source: string;
  timestamp: number;
}

export interface MemoryResponse {
  speaker: string;
  memories: MemoryItem[];
}

export interface ForgetResult {
  forgotten: boolean;
  id: string;
}

export interface StatusResponse {
  assistant: string;
  openrouter: boolean;
  memory: boolean;
  voice: boolean;
  spotify: boolean;
  /** Some way to control music here: Spotify's API or the system media keys. */
  music: boolean;
  /** Talking to F.E.A.R.: local speech recognition, and its voice (online, or Piper). */
  voice_input: boolean;
  voice_output: boolean;
  /** Its voice can come from Microsoft's neural voices (with internet). */
  voice_online: boolean;
  /** It can think with a model on this computer (Ollama), no key needed. */
  local_models: boolean;
  obsidian: boolean;
  calendar: boolean;
}

export interface KnowledgeSource {
  source: string;
  chunks: number;
}

export interface KnowledgeListResponse {
  available: boolean;
  sources: KnowledgeSource[];
}

export interface ConfigResponse {
  model: string;
  model_default: string;
  /** Whether OpenRouter still offers `model` (null: its list couldn't be read). */
  model_available?: boolean | null;
  persona_mode: string;
  persona_modes: string[];
}

/** A model F.E.A.R. can talk with, as OpenRouter lists it now. */
export interface ModelOption {
  id: string;
  name: string;
  description: string;
  free: boolean;
  context_length: number;
  /** Roughly what 100 of F.E.A.R.'s replies cost with it, in US dollars (null: it varies). */
  cost_per_100_replies: number | null;
}

export interface ModelsResponse {
  /** The default and fallbacks first, then the other free models, then the paid ones. */
  models: ModelOption[];
  default: string;
  /** Tried in this order whenever the chosen model fails. */
  fallbacks: string[];
}

/** A model downloaded into Ollama on this computer. */
export interface LocalModelOption {
  /** "ollama/<tag>", as the model setting stores it. */
  id: string;
  tag: string;
  /** Bytes on disk. */
  size: number;
  parameter_size: string;
}

/** A model the settings offer to download into Ollama. */
export interface LocalDownload {
  id: string;
  tag: string;
  name: string;
  /** Bytes to download, roughly. */
  size: number;
  note: string;
  installed: boolean;
}

export interface LocalModelsResponse {
  /** Ollama answers: installed and open. */
  running: boolean;
  models: LocalModelOption[];
  downloads: LocalDownload[];
  recommended: string;
}

/** How a model's download is going (bytes, all its parts together). */
export interface PullProgress {
  status: string;
  completed: number;
  total: number;
}

export interface ConfigUpdate {
  model?: string;
  persona_mode?: string;
}

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// The stream response carries the ids of the memories *consulted* to build the
// reply's context (never content, never a claim of what the model "used") in
// this header: percent-encoded ids, comma-separated, absent when none.
export const CONSULTED_MEMORY_IDS_HEADER = "X-Fear-Consulted-Memory-Ids";

/**
 * Parse the consulted-memory header into a clean list of ids.
 *
 * Defensive on purpose — a missing/empty header, malformed percent-encoding,
 * blank entries or duplicates must never break a reply: bad entries are
 * dropped, order of first appearance is kept, and the worst case is [].
 */
export function parseConsultedMemoryIdsHeader(value: string | null): string[] {
  if (!value || !value.trim()) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const entry of value.split(",")) {
    const raw = entry.trim();
    if (!raw) continue;
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      continue; // malformed encoding — skip the entry, never throw mid-stream
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

// Fired when the backend rejects the session token, so the app can sign out
// instead of failing every call with "session expired" while looking logged in.
export const UNAUTHORIZED_EVENT = "fear:unauthorized";

// Every backend call goes through here: attaches the session and reports a
// rejected one.
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), ...authHeaders() },
  });
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  }
  return response;
}

// Pull FastAPI's `{ detail }` out of an error body so the UI can show why.
async function errorDetail(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data?.detail === "string") return data.detail;
  } catch {
    // Non-JSON body; fall through to the generic message.
  }
  return `HTTP ${response.status}`;
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await apiFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return response;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await apiFetch("/health");
    return response.ok;
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<StatusResponse> {
  const response = await apiFetch("/status");
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as StatusResponse;
}

export async function sendCommand(request: CommandRequest): Promise<CommandResponse> {
  const response = await postJson("/command", { speak: false, ...request });
  return (await response.json()) as CommandResponse;
}

// Streams the reply chunk-by-chunk via fetch + ReadableStream. Pass an
// AbortSignal to cancel an in-flight stream (e.g. on unmount).
// `onConsultedMemoryIds` (optional) fires once — after the headers arrive,
// before the first chunk — with the ids of the memories consulted for this
// reply; it is not called when the header is absent/empty. The body handling
// is untouched either way.
export async function streamCommand(
  request: CommandRequest,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
  onConsultedMemoryIds?: (ids: string[]) => void,
): Promise<void> {
  const response = await apiFetch("/command/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ speak: false, ...request }),
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError(`HTTP ${response.status}`, response.status);

  if (onConsultedMemoryIds) {
    const ids = parseConsultedMemoryIdsHeader(response.headers.get(CONSULTED_MEMORY_IDS_HEADER));
    if (ids.length > 0) onConsultedMemoryIds(ids);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) onChunk(chunk);
  }
  // Flush bytes held back mid-character, or a split final accent is lost.
  const tail = decoder.decode();
  if (tail) onChunk(tail);
}

export async function getMemory(): Promise<MemoryResponse> {
  const response = await apiFetch("/memory");
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as MemoryResponse;
}

// Returns the backend's verdict: `forgotten` is false when the server refused
// (e.g. a claimed memory whose id predates accounts), so the UI can surface a
// recoverable failure instead of a silent success.
export async function forgetMemory(memoryId: string): Promise<ForgetResult> {
  const response = await postJson("/memory/forget", { memory_id: memoryId });
  return (await response.json()) as ForgetResult;
}

export async function resetConversation(): Promise<void> {
  await postJson("/conversation/reset", {});
}

// "queued" once the clip is recorded; "disabled" when the backend has no mic.
/** What was said in a recording from the microphone (transcribed on this machine). */
export async function transcribeAudio(audio: Blob, signal?: AbortSignal): Promise<string> {
  const response = await apiFetch("/voice/transcribe", {
    method: "POST",
    headers: { "content-type": audio.type || "application/octet-stream" },
    body: audio,
    signal,
  });
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

/** One sentence in F.E.A.R.'s own voice, as audio (synthesized on this machine). */
export async function fetchVoice(
  text: string,
  style: "fear" | "natural" | "system",
  signal: AbortSignal,
  online = true,
): Promise<Blob> {
  const response = await apiFetch("/voice/speak", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, style: style === "fear" ? "fear" : "natural", online }),
    signal,
  });
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return response.blob();
}

export async function captureVoiceOnce(): Promise<"queued" | "disabled"> {
  const response = await postJson("/voice/capture-once", {});
  const data = (await response.json()) as { status?: string };
  return data.status === "disabled" ? "disabled" : "queued";
}

// --- Knowledge sources (the settings panel) ---

export async function listKnowledge(): Promise<KnowledgeListResponse> {
  const response = await apiFetch("/knowledge");
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as KnowledgeListResponse;
}

export async function addKnowledgeText(name: string, content: string): Promise<KnowledgeSource> {
  const response = await postJson("/knowledge/text", { name, content });
  return (await response.json()) as KnowledgeSource;
}

export async function deleteKnowledge(source: string): Promise<void> {
  const response = await apiFetch(`/knowledge/${encodeURIComponent(source)}`, { method: "DELETE" });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
}

// --- Runtime behaviour config (model + persona mode; never secrets) ---

export async function getConfig(): Promise<ConfigResponse> {
  const response = await apiFetch("/config");
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as ConfigResponse;
}

export async function getModels(): Promise<ModelsResponse> {
  const response = await apiFetch("/models");
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return (await response.json()) as ModelsResponse;
}

export async function getLocalModels(): Promise<LocalModelsResponse> {
  const response = await apiFetch("/models/local");
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return (await response.json()) as LocalModelsResponse;
}

/** Download a model into Ollama, reporting progress until it's done (or throwing why not). */
export async function pullLocalModel(
  tag: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await apiFetch("/models/local/pull", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tag }),
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError(await errorDetail(response), response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let done = false;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const event = JSON.parse(line) as Partial<PullProgress> & { error?: string };
    if (event.error) throw new ApiError(event.error, 502);
    if (event.status === "success") done = true;
    onProgress({ status: event.status ?? "", completed: event.completed ?? 0, total: event.total ?? 0 });
  };
  for (;;) {
    const { done: ended, value } = await reader.read();
    if (ended) break;
    buffered += decoder.decode(value, { stream: true });
    const lines = buffered.split("\n");
    buffered = lines.pop() ?? "";
    lines.forEach(handle);
  }
  handle(buffered + decoder.decode());
  if (!done) throw new ApiError("O download parou antes de terminar.", 502);
}

export async function updateConfig(update: ConfigUpdate): Promise<ConfigResponse> {
  const response = await postJson("/config", update);
  return (await response.json()) as ConfigResponse;
}

// --- The Windows app's own switches (its settings panel) ---

export interface DesktopSettings {
  claps: boolean;
  claps_available: boolean;
  /** False when claps are on but the microphone could not be opened. */
  claps_listening: boolean;
  obsidian_vault: string;
  obsidian_watching: boolean;
  autostart: boolean;
  autostart_available: boolean;
}

export type DesktopSettingsUpdate = Partial<Pick<DesktopSettings, "claps" | "obsidian_vault" | "autostart">>;

export async function getDesktopSettings(): Promise<DesktopSettings> {
  const response = await apiFetch("/desktop/settings");
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return (await response.json()) as DesktopSettings;
}

export async function updateDesktopSettings(update: DesktopSettingsUpdate): Promise<DesktopSettings> {
  const response = await postJson("/desktop/settings", update);
  return (await response.json()) as DesktopSettings;
}

// --- Accounts (multi-user; the session token is attached automatically) ---

export interface AuthUser {
  id: string;
  email: string;
  has_openrouter_key: boolean;
  chat_model: string;
  persona_mode: string;
}

export interface AuthResponse {
  token: string;
  user: AuthUser;
}

export async function register(email: string, password: string, inviteCode = ""): Promise<AuthResponse> {
  const response = await postJson("/auth/register", {
    email,
    password,
    invite_code: inviteCode,
  });
  return (await response.json()) as AuthResponse;
}

export async function login(email: string, password: string): Promise<AuthResponse> {
  const response = await postJson("/auth/login", { email, password });
  return (await response.json()) as AuthResponse;
}

export async function fetchMe(): Promise<AuthUser> {
  const response = await apiFetch("/auth/me");
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as AuthUser;
}

export async function setOpenRouterKey(apiKey: string): Promise<AuthUser> {
  const response = await postJson("/auth/openrouter-key", { api_key: apiKey });
  return (await response.json()) as AuthUser;
}
