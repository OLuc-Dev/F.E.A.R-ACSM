from __future__ import annotations

import tempfile
import wave
from pathlib import Path
from typing import Optional

import pyaudio


class MicrophoneRecorder:
    """Small blocking microphone recorder for mono 16-bit PCM WAV files."""

    def __init__(
        self,
        *,
        sample_rate: int = 16_000,
        chunk_size: int = 1_024,
        input_device_index: Optional[int] = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        self.input_device_index = input_device_index

    def record_wav_file(self, seconds: float) -> Path:
        """
        Record a fixed-duration WAV file and return its temporary path.

        This method blocks, so call it with asyncio.to_thread from async code.
        """
        pa = pyaudio.PyAudio()
        stream = None

        try:
            stream = pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                input_device_index=self.input_device_index,
            )

            frame_count = int(self.sample_rate / self.chunk_size * seconds)
            frames: list[bytes] = []

            for _ in range(frame_count):
                frames.append(
                    stream.read(
                        self.chunk_size,
                        exception_on_overflow=False,
                    )
                )

            _, raw_path = tempfile.mkstemp(prefix="fear_audio_", suffix=".wav")
            output_path = Path(raw_path)

            with wave.open(str(output_path), "wb") as wav_file:
                wav_file.setnchannels(1)
                wav_file.setsampwidth(pa.get_sample_size(pyaudio.paInt16))
                wav_file.setframerate(self.sample_rate)
                wav_file.writeframes(b"".join(frames))

            return output_path

        finally:
            if stream is not None:
                stream.stop_stream()
                stream.close()
            pa.terminate()
