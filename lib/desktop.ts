// The Windows app build (NEXT_PUBLIC_FEAR_DESKTOP=1): the backend serves this UI
// itself and hands the window a session in the URL, so there is no login.

import { setToken } from "@/lib/auth";

export const IS_DESKTOP = process.env.NEXT_PUBLIC_FEAR_DESKTOP === "1";

/** This build's version (set by the release workflow), or "" in development. */
export const APP_VERSION = process.env.NEXT_PUBLIC_FEAR_VERSION ?? "";

interface DesktopBridge {
  pick_folder?: () => Promise<string>;
}

function bridge(): DesktopBridge | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as { pywebview?: { api?: DesktopBridge } }).pywebview?.api ?? null;
}

/** Whether the app window can open Windows' own folder picker. */
export function canPickFolder(): boolean {
  return typeof bridge()?.pick_folder === "function";
}

/** Open Windows' folder picker: the folder chosen, or "" if cancelled or unavailable. */
export async function pickFolder(): Promise<string> {
  const pick = bridge()?.pick_folder;
  if (!pick) return "";
  try {
    return (await pick()) || "";
  } catch {
    return "";
  }
}

/** Take the session the desktop launcher put in `#token=…`, then scrub it from the URL. */
export function adoptLaunchToken(): void {
  if (typeof window === "undefined") return;
  const match = /(?:^#|&)token=([^&]+)/.exec(window.location.hash);
  if (!match) return;
  setToken(decodeURIComponent(match[1]));
  window.history.replaceState(null, "", window.location.pathname + window.location.search);
}
