// The Windows app build (NEXT_PUBLIC_FEAR_DESKTOP=1): the backend serves this UI
// itself and hands the window a session in the URL, so there is no login.

import { setToken } from "@/lib/auth";

export const IS_DESKTOP = process.env.NEXT_PUBLIC_FEAR_DESKTOP === "1";

/** Take the session the desktop launcher put in `#token=…`, then scrub it from the URL. */
export function adoptLaunchToken(): void {
  if (typeof window === "undefined") return;
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (!match) return;
  setToken(decodeURIComponent(match[1]));
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
