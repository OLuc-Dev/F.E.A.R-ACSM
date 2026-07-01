// Client-side session token: stored in localStorage and attached as a Bearer
// header to API calls. Guarded so it is inert during SSR / in the test runner
// (no window), where it simply behaves as "logged out".

const TOKEN_KEY = "fear.token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Storage unavailable (e.g. private mode); the session stays in memory only.
  }
}

export function clearToken(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear if storage is unavailable.
  }
}

// Authorization header for the current session, or {} when logged out — safe to
// spread into any request's headers.
export function authHeaders(): Record<string, string> {
  const token = getToken();
  return token ? { authorization: `Bearer ${token}` } : {};
}
