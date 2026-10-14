// The microphone side of talking to F.E.A.R.: records what you say (as compact
// opus audio) and measures how loud the room is right now, for the speech
// detector. The recording goes only to this app's own backend, which
// transcribes it on this machine.

export interface Capture {
  /** Loudness right now (RMS, 0–1). */
  level(): number;
  /** False when loudness can't be measured; listening then runs for a fixed time. */
  readonly measurable: boolean;
  /** Stop recording; resolves with everything recorded. */
  finish(): Promise<Blob>;
  /** Stop and throw the recording away. */
  cancel(): void;
}

export type CaptureFactory = () => Promise<Capture>;

// Opus in WebM is what Chromium (and so WebView2) records; the rest are fallbacks.
const MIME_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/mp4"];

// How long to wait for the level meter to start before recording without it.
const METER_START_MS = 400;

export const startMicrophoneCapture: CaptureFactory = async () => {
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
    const mimeType = MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };

    context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    // Started without a click, a browser may keep the audio graph paused, and
    // resume() then waits for one indefinitely. Recording works regardless:
    // without the meter, listening runs for a fixed time.
    await Promise.race([
      context.resume().catch(() => undefined),
      new Promise((resolve) => setTimeout(resolve, METER_START_MS)),
    ]);
    const measurable = context.state === "running";

    let released = false;
    const finishWith = () => {
      if (released) return;
      released = true;
      source.disconnect();
      release();
    };

    recorder.start(250);
    return {
      measurable,
      level() {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const value of samples) sum += value * value;
        return Math.sqrt(sum / samples.length);
      },
      finish() {
        return new Promise<Blob>((resolve) => {
          recorder.onstop = () => {
            finishWith();
            resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
          };
          if (recorder.state === "inactive") recorder.onstop(new Event("stop"));
          else recorder.stop();
        });
      },
      cancel() {
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        finishWith();
      },
    };
  } catch (error) {
    release(); // never leave the microphone on after a failed start
    throw error;
  }
};
