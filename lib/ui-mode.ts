// Which face F.E.A.R. shows: the voice interface (talk, no written chat — the
// default) or the written chat, kept for when there's no voice to talk with.

const KEY = "fear.ui.mode";

export function loadVoiceInterface(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "text";
  } catch {
    return true;
  }
}

export function saveVoiceInterface(on: boolean): void {
  try {
    window.localStorage.setItem(KEY, on ? "voice" : "text");
  } catch {
    // Storage unavailable: the choice lasts for this session.
  }
}
