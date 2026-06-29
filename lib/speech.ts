// Browser text-to-speech (Web Speech API). Lets F.E.A.R. speak its replies on
// the user's own device — no server audio, no API key, no pyaudio, and it works
// on phones too. Everything here is a no-op when the browser has no speech API.

export function speechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

let cachedVoice: SpeechSynthesisVoice | null = null;

function pickVoice(): SpeechSynthesisVoice | null {
  if (!speechSupported()) return null;
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return cachedVoice;
  // Prefer Brazilian Portuguese, then any Portuguese, then the default voice.
  cachedVoice =
    voices.find((v) => /pt[-_]br/i.test(v.lang)) ?? voices.find((v) => /^pt/i.test(v.lang)) ?? voices[0];
  return cachedVoice;
}

// Spoken form: drop **bold** markers and leading bullets so it reads naturally.
function toSpeech(text: string): string {
  return text
    .replace(/\*\*/g, "")
    .replace(/^[\s>]*[-*]\s+/gm, "")
    .trim();
}

export function speak(text: string): void {
  if (!speechSupported()) return;
  const clean = toSpeech(text);
  if (!clean) return;

  const synth = window.speechSynthesis;
  synth.cancel(); // never overlap utterances

  const utterance = new SpeechSynthesisUtterance(clean);
  const voice = pickVoice();
  if (voice) {
    utterance.voice = voice;
    utterance.lang = voice.lang;
  } else {
    utterance.lang = "pt-BR";
  }
  utterance.rate = 1.0;
  utterance.pitch = 0.85; // a shade lower — cold and even, in character
  synth.speak(utterance);
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

// Call from a user gesture (e.g. toggling voice on): loads the async voice list
// and unlocks audio on iOS/Safari, which require the first utterance to follow
// a user interaction.
export function primeSpeech(): void {
  if (!speechSupported()) return;
  pickVoice();
  window.speechSynthesis.onvoiceschanged = () => pickVoice();
  const warm = new SpeechSynthesisUtterance(" ");
  warm.volume = 0;
  window.speechSynthesis.speak(warm);
}
