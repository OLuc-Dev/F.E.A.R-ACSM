// Whether the app's page is on screen. A browser says so itself
// (document.visibilityState); the Windows app also tells the page, because
// WebView2 kept reporting "visible" for a window hidden in the tray — which left
// the microphone listening and the camera on while nobody could see either.

import { useSyncExternalStore } from "react";

type AppWindow = Window & { __fearHidden?: boolean };

/** The page is on screen: not a hidden tab, not minimized to the tray. */
export function isPageShown(): boolean {
  if (typeof document === "undefined") return true;
  return document.visibilityState === "visible" && !(window as AppWindow).__fearHidden;
}

/** Called whenever that changes. */
export function onPageShownChange(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  window.addEventListener("fear:window", listener);
  return () => {
    document.removeEventListener("visibilitychange", listener);
    window.removeEventListener("fear:window", listener);
  };
}

export function usePageShown(): boolean {
  return useSyncExternalStore(onPageShownChange, isPageShown, () => true);
}
