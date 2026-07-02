// Typed client for the F.E.A.R. backend: one place for endpoints, shapes and errors.

import { authHeaders } from "@/lib/auth";

// Resolve the backend base URL. An explicit NEXT_PUBLIC_FEAR_API_BASE always
// wins; otherwise, in the browser, talk to the same host that served the page —
// so opening the app from a phone at http://<pc-ip>:3000 just reaches the
// backend at http://<pc-ip>:8765 with no config. Falls back to localhost (SSR).
function resolveApiBase(): string {
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

export interface StatusResponse {
  assistant: string;
  openrouter: boolean;
  memory: boolean;
  voice: boolean;
  spotify: boolean;
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
  persona_mode: string;
  persona_modes: string[];
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
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new ApiError(await errorDetail(response), response.status);
  return response;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`, { headers: authHeaders() });
    return response.ok;
  } catch {
    return false;
  }
}

export async function getStatus(): Promise<StatusResponse> {
  const response = await fetch(`${API_BASE}/status`, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as StatusResponse;
}

export async function sendCommand(request: CommandRequest): Promise<CommandResponse> {
  const response = await postJson("/command", { speak: false, ...request });
  return (await response.json()) as CommandResponse;
}

// Streams the reply chunk-by-chunk via fetch + ReadableStream. Pass an
// AbortSignal to cancel an in-flight stream (e.g. on unmount).
export async function streamCommand(
  request: CommandRequest,
  onChunk: (chunk: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${API_BASE}/command/stream`, {
    method: "POST",
    headers: { "content-type": "application/json", ...authHeaders() },
    body: JSON.stringify({ speak: false, ...request }),
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError(`HTTP ${response.status}`, response.status);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });
    if (chunk) onChunk(chunk);
  }
}

export async function getMemory(): Promise<MemoryResponse> {
  const response = await fetch(`${API_BASE}/memory`, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as MemoryResponse;
}

export async function forgetMemory(memoryId: string): Promise<void> {
  await postJson("/memory/forget", { memory_id: memoryId });
}

export async function resetConversation(): Promise<void> {
  await postJson("/conversation/reset", {});
}

export async function captureVoiceOnce(): Promise<void> {
  await postJson("/voice/capture-once", {});
}

// --- Knowledge sources (the settings panel) ---

export async function listKnowledge(): Promise<KnowledgeListResponse> {
  const response = await fetch(`${API_BASE}/knowledge`, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as KnowledgeListResponse;
}

export async function addKnowledgeText(name: string, content: string): Promise<KnowledgeSource> {
  const response = await postJson("/knowledge/text", { name, content });
  return (await response.json()) as KnowledgeSource;
}

export async function deleteKnowledge(source: string): Promise<void> {
  const response = await fetch(`${API_BASE}/knowledge/${encodeURIComponent(source)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
}

// --- Runtime behaviour config (model + persona mode; never secrets) ---

export async function getConfig(): Promise<ConfigResponse> {
  const response = await fetch(`${API_BASE}/config`, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as ConfigResponse;
}

export async function updateConfig(update: ConfigUpdate): Promise<ConfigResponse> {
  const response = await postJson("/config", update);
  return (await response.json()) as ConfigResponse;
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
  const response = await fetch(`${API_BASE}/auth/me`, { headers: authHeaders() });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as AuthUser;
}

export async function setOpenRouterKey(apiKey: string): Promise<AuthUser> {
  const response = await postJson("/auth/openrouter-key", { api_key: apiKey });
  return (await response.json()) as AuthUser;
}
