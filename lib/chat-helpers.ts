// Pure, DOM-free helpers for the conversation flow — kept here so the tricky
// bits (what blocks a send, how an error reads to a human) are unit-testable
// without a browser, and the hook stays focused on wiring.

import { ApiError } from "@/lib/api";

// Friendly copy for the thread. The user never sees a raw stack trace, an
// "HTTP 500", or a silent empty bubble.
export const EMPTY_REPLY_NOTICE = "Fiquei sem resposta dessa vez. Tenta perguntar de outro jeito?";
export const TIMEOUT_NOTICE =
  "Demorei demais pra responder — pode ser a conexão ou o backend. Tenta de novo?";

/** A message that must NOT be sent: empty, or only spaces/tabs/newlines. */
export function isBlankMessage(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Human, non-technical text for a failed turn. Maps status codes to plain
 * language, surfaces a meaningful backend detail as-is, and never leaks a bare
 * "HTTP nnn" to the user.
 */
export function humanizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403)
      return "Sua sessão expirou. Entra de novo pra continuar.";
    if (error.status === 429) return "Muita coisa de uma vez. Espera um segundo e tenta de novo.";
    if (typeof error.status === "number" && error.status >= 500)
      return "O servidor tropeçou aqui. Tenta de novo em instantes.";
    // A real backend detail (e.g. "Configure sua chave do OpenRouter") is
    // already human — show it. A bare "HTTP 404" is not — fall through.
    if (error.message && !/^HTTP \d+$/.test(error.message)) return error.message;
  }
  return "Não consegui falar com o F.E.A.R. agora. Confere se o backend está no ar e tenta de novo.";
}
