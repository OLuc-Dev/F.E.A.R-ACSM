// Typed client for the F.E.A.R. backend: one place for endpoints, shapes and errors.

export const API_BASE = process.env.NEXT_PUBLIC_FEAR_API_BASE ?? "http://127.0.0.1:8765";

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
  text: string;
  source: string;
  timestamp: number;
}

export interface MemoryResponse {
  speaker: string;
  memories: MemoryItem[];
}

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return response;
}

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/health`);
    return response.ok;
  } catch {
    return false;
  }
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
    headers: { "content-type": "application/json" },
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

export async function getMemory(speaker: string): Promise<MemoryResponse> {
  const response = await fetch(`${API_BASE}/memory/${encodeURIComponent(speaker)}`);
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status);
  return (await response.json()) as MemoryResponse;
}

export async function resetConversation(speaker: string): Promise<void> {
  await postJson(`/conversation/reset?speaker=${encodeURIComponent(speaker)}`, {});
}

export async function captureVoiceOnce(): Promise<void> {
  await postJson("/voice/capture-once", {});
}
