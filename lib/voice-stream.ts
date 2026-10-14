// The microphone when F.E.A.R. is always listening: open while the window is,
// it hands over each sentence as soon as it's said, as WAV, together with the
// moment just before it was noticed (so the first syllable is kept). Nothing
// is kept except while someone talks, and sentences go only to this app's own
// backend, which transcribes them on this machine.

import { LISTEN_TUNING, SpeechSegmenter } from "@/lib/voice-activity";

export interface ContinuousMicrophone {
  /** Loudness right now (RMS, 0–1). */
  level(): number;
  /** Stop listening for now (F.E.A.R. is talking); a sentence in progress is dropped. */
  pause(): void;
  resume(): void;
  /** Turn the microphone off. */
  close(): void;
}

export interface MicrophoneHandlers {
  /** Someone started talking. */
  onSpeech(): void;
  /** They finished: what they said, as WAV. */
  onSentence(audio: Blob): void;
}

export type ContinuousMicrophoneFactory = (handlers: MicrophoneHandlers) => Promise<ContinuousMicrophone>;

/** The page may not play or capture audio until it's clicked (a browser's autoplay rule). */
export class AudioNeedsGesture extends Error {
  constructor() {
    super("audio is waiting for a click");
    this.name = "AudioNeedsGesture";
  }
}

const METER_START_MS = 400;

// Runs on the audio thread: hands the samples over ~32 ms at a time.
const TAP = `
class FearTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate * 0.032));
    this.block = new Float32Array(this.size);
    this.filled = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      for (let i = 0; i < channel.length; i++) {
        this.block[this.filled++] = channel[i];
        if (this.filled === this.size) {
          this.port.postMessage(this.block, [this.block.buffer]);
          this.block = new Float32Array(this.size);
          this.filled = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor("fear-tap", FearTap);
`;

/** Mono 16-bit PCM WAV of these samples. */
export function encodeWav(chunks: Float32Array[], sampleRate: number): Blob {
  const samples = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const view = new DataView(new ArrayBuffer(44 + samples * 2));
  const text = (offset: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(offset + i, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes per second
  view.setUint16(32, 2, true); // bytes per frame
  view.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const value of chunk) {
      const clipped = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, clipped < 0 ? clipped * 0x8000 : clipped * 0x7fff, true);
      offset += 2;
    }
  }
  return new Blob([view.buffer], { type: "audio/wav" });
}

function loudness(block: Float32Array): number {
  let sum = 0;
  for (const value of block) sum += value * value;
  return Math.sqrt(sum / block.length);
}

export const openContinuousMicrophone: ContinuousMicrophoneFactory = async ({ onSpeech, onSentence }) => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  let context: AudioContext | null = null;
  const release = () => {
    stream.getTracks().forEach((track) => track.stop());
    void context?.close().catch(() => undefined);
    context = null;
  };
  try {
    context = new AudioContext();
    const tapUrl = URL.createObjectURL(new Blob([TAP], { type: "text/javascript" }));
    try {
      await context.audioWorklet.addModule(tapUrl);
    } finally {
      URL.revokeObjectURL(tapUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(context, "fear-tap");
    // The graph only runs what reaches the speakers: a silent path keeps the tap fed.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(context.destination);
    // Started without a click, a browser keeps audio paused and resume() waits for one.
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, METER_START_MS)),
    ]);
    if (context.state !== "running") throw new AudioNeedsGesture();

    const rate = context.sampleRate;
    const prerollSamples = (rate * LISTEN_TUNING.prerollMs) / 1000;
    const segmenter = new SpeechSegmenter();
    let preroll: Float32Array[] = [];
    let sentence: Float32Array[] | null = null;
    let paused = false;
    let level = 0;
    let t = 0;

    tap.port.onmessage = (event: MessageEvent<Float32Array>) => {
      const block = event.data;
      t += (block.length / rate) * 1000;
      level = loudness(block);
      if (paused) return;
      const outcome = segmenter.update(t, level);
      if (sentence) {
        sentence.push(block);
      } else {
        preroll.push(block);
        let kept = preroll.reduce((total, chunk) => total + chunk.length, 0);
        while (preroll.length > 1 && kept - preroll[0].length >= prerollSamples) {
          kept -= preroll[0].length;
          preroll.shift();
        }
      }
      if (outcome === "start") {
        sentence = preroll;
        preroll = [];
        onSpeech();
      } else if (outcome === "end" && sentence) {
        const said = sentence;
        sentence = null;
        if (segmenter.speechMs >= LISTEN_TUNING.minSpeechMs) onSentence(encodeWav(said, rate));
      }
    };

    let closed = false;
    return {
      level: () => level,
      pause() {
        paused = true;
        sentence = null;
        preroll = [];
        segmenter.reset();
      },
      resume() {
        paused = false;
      },
      close() {
        if (closed) return;
        closed = true;
        tap.port.onmessage = null;
        source.disconnect();
        tap.disconnect();
        release();
      },
    };
  } catch (error) {
    release(); // never leave the microphone on after a failed start
    throw error;
  }
};
