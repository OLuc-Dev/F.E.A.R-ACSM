from __future__ import annotations

import array
import logging
import sys
import threading
import time
from queue import Empty, Queue
from typing import Any, Callable, Optional

import pyaudio


class ClapDetector:
    """
    Background double-clap detector using PyAudio.

    The detector continuously reads microphone chunks, calculates normalized
    RMS amplitude, detects short loud bursts as claps, and fires a callback
    when two valid claps happen close together.

    Default audio format:
    - 16 kHz
    - mono
    - 1024 samples per chunk
    - signed 16-bit PCM

    Default clap rules:
    - RMS threshold: 0.1
    - valid clap duration: 50 ms to 200 ms
    - double-clap window: 1000 ms

    Threading model:
    - Audio thread: reads microphone chunks and identifies individual claps.
    - Processor thread: consumes valid clap timestamps through a Queue and
      detects double-clap pairs.
    """

    def __init__(
        self,
        on_double_clap: Callable[[], None],
        *,
        threshold: float = 0.1,
        sample_rate: int = 16_000,
        chunk_size: int = 1_024,
        min_clap_ms: int = 50,
        max_clap_ms: int = 200,
        double_clap_window_ms: int = 1_000,
        input_device_index: Optional[int] = None,
    ) -> None:
        """
        Create a ClapDetector.

        Args:
            on_double_clap: Callback fired when a double clap is detected.
            threshold: Normalized RMS threshold between 0.0 and 1.0.
            sample_rate: Microphone sample rate in Hz.
            chunk_size: Number of samples read per chunk.
            min_clap_ms: Minimum duration for a valid clap.
            max_clap_ms: Maximum duration for a valid clap.
            double_clap_window_ms: Maximum time between first and second clap.
            input_device_index: Optional PyAudio input device index.
        """
        if not 0.0 < threshold < 1.0:
            raise ValueError("threshold must be between 0.0 and 1.0")
        if sample_rate <= 0:
            raise ValueError("sample_rate must be positive")
        if chunk_size <= 0:
            raise ValueError("chunk_size must be positive")
        if min_clap_ms <= 0:
            raise ValueError("min_clap_ms must be positive")
        if max_clap_ms <= min_clap_ms:
            raise ValueError("max_clap_ms must be greater than min_clap_ms")
        if double_clap_window_ms <= 0:
            raise ValueError("double_clap_window_ms must be positive")

        self.on_double_clap = on_double_clap
        self.threshold = threshold
        self.sample_rate = sample_rate
        self.chunk_size = chunk_size
        self.min_clap_ms = min_clap_ms
        self.max_clap_ms = max_clap_ms
        self.double_clap_window_ms = double_clap_window_ms
        self.input_device_index = input_device_index

        # Allows any thread to request shutdown safely.
        self._stop_event = threading.Event()

        # Carries valid single-clap timestamps from the audio thread to the
        # processor thread. Queue is thread-safe by design.
        self._clap_queue: Queue[float] = Queue()

        self._audio_thread: Optional[threading.Thread] = None
        self._processor_thread: Optional[threading.Thread] = None

        self._pa: Optional[pyaudio.PyAudio] = None
        self._stream: Optional[Any] = None

        # Prevents concurrent start/stop calls from racing.
        self._lock = threading.Lock()
        self._logger = logging.getLogger(self.__class__.__name__)

    @property
    def is_running(self) -> bool:
        """Return True when the audio listener thread is alive."""
        return self._audio_thread is not None and self._audio_thread.is_alive()

    def start(self) -> None:
        """
        Start the clap listener in background threads.

        Calling start() more than once is safe; duplicate threads are not
        created when the detector is already running.
        """
        with self._lock:
            if self.is_running:
                return

            self._stop_event.clear()
            self._clear_queue()

            self._audio_thread = threading.Thread(
                target=self._audio_loop,
                name="ClapDetectorAudioThread",
                daemon=True,
            )
            self._processor_thread = threading.Thread(
                target=self._clap_processor_loop,
                name="ClapDetectorProcessorThread",
                daemon=True,
            )

            self._audio_thread.start()
            self._processor_thread.start()

    def stop(self, timeout: float = 2.0) -> None:
        """
        Stop the clap listener and wait briefly for threads to exit.

        Args:
            timeout: Maximum seconds to wait for each background thread.
        """
        with self._lock:
            self._stop_event.set()
            current_thread = threading.current_thread()

            # Avoid joining the current thread if stop() is called from a
            # detector thread or from inside the callback.
            if self._audio_thread and self._audio_thread is not current_thread:
                self._audio_thread.join(timeout=timeout)
            if self._processor_thread and self._processor_thread is not current_thread:
                self._processor_thread.join(timeout=timeout)

            self._audio_thread = None
            self._processor_thread = None

    def _audio_loop(self) -> None:
        """
        Read microphone audio and detect individual valid claps.

        This loop does not fire the double-clap callback directly. It only
        pushes valid single-clap timestamps to `_clap_queue`.
        """
        chunk_duration_s = self.chunk_size / self.sample_rate
        in_potential_clap = False
        clap_start_time: Optional[float] = None

        try:
            self._pa = pyaudio.PyAudio()
            self._stream = self._pa.open(
                format=pyaudio.paInt16,
                channels=1,
                rate=self.sample_rate,
                input=True,
                frames_per_buffer=self.chunk_size,
                input_device_index=self.input_device_index,
            )

            while not self._stop_event.is_set():
                try:
                    raw_audio = self._stream.read(
                        self.chunk_size,
                        exception_on_overflow=False,
                    )
                except OSError as exc:
                    self._logger.warning("Failed to read audio chunk: %s", exc)
                    continue

                rms = self._calculate_rms(raw_audio)

                # time.monotonic() is stable even if the system clock changes.
                # The timestamp is roughly the end of the chunk, so we subtract
                # the chunk duration to estimate the chunk start.
                chunk_end_time = time.monotonic()
                chunk_start_time = chunk_end_time - chunk_duration_s

                if not in_potential_clap:
                    # Rising edge: quiet/background audio -> loud audio.
                    if rms >= self.threshold:
                        in_potential_clap = True
                        clap_start_time = chunk_start_time
                else:
                    # Falling edge: loud audio -> quiet/background audio.
                    if rms < self.threshold:
                        if clap_start_time is not None:
                            clap_end_time = chunk_start_time
                            duration_ms = (clap_end_time - clap_start_time) * 1000.0

                            if self.min_clap_ms <= duration_ms <= self.max_clap_ms:
                                self._clap_queue.put(clap_start_time)

                        in_potential_clap = False
                        clap_start_time = None

        except Exception:
            self._logger.exception("Audio loop crashed")
        finally:
            self._close_audio_resources()

    def _clap_processor_loop(self) -> None:
        """Consume valid clap timestamps and detect double-clap pairs."""
        first_clap_time: Optional[float] = None
        double_clap_window_s = self.double_clap_window_ms / 1000.0

        while not self._stop_event.is_set():
            try:
                clap_time = self._clap_queue.get(timeout=0.1)
            except Empty:
                continue

            try:
                if first_clap_time is None:
                    first_clap_time = clap_time
                    continue

                elapsed_s = clap_time - first_clap_time

                if 0.0 <= elapsed_s <= double_clap_window_s:
                    self._fire_double_clap_callback()
                    first_clap_time = None
                else:
                    # The second clap arrived too late. Treat it as the first
                    # clap of a new possible pair.
                    first_clap_time = clap_time
            finally:
                self._clap_queue.task_done()

    def _fire_double_clap_callback(self) -> None:
        """Fire the callback without letting callback errors kill the thread."""
        try:
            self.on_double_clap()
        except Exception:
            self._logger.exception("on_double_clap callback failed")

    def _calculate_rms(self, raw_audio: bytes) -> float:
        """
        Calculate normalized RMS amplitude for signed 16-bit PCM audio.

        Args:
            raw_audio: Bytes returned by PyAudio with format=pyaudio.paInt16.

        Returns:
            RMS amplitude normalized to approximately 0.0 through 1.0.
        """
        samples = array.array("h")
        samples.frombytes(raw_audio)

        # PyAudio int16 data is little-endian on common desktop systems.
        # array("h") uses native endianness, so swap on big-endian systems.
        if sys.byteorder == "big":
            samples.byteswap()

        if not samples:
            return 0.0

        square_sum = 0.0
        for sample in samples:
            square_sum += float(sample) * float(sample)

        mean_square = square_sum / len(samples)
        rms = (mean_square ** 0.5) / 32768.0
        return min(rms, 1.0)

    def _close_audio_resources(self) -> None:
        """Close PyAudio resources when the audio loop exits."""
        if self._stream is not None:
            try:
                if self._stream.is_active():
                    self._stream.stop_stream()
                self._stream.close()
            except Exception:
                self._logger.exception("Failed to close PyAudio stream")
            finally:
                self._stream = None

        if self._pa is not None:
            try:
                self._pa.terminate()
            except Exception:
                self._logger.exception("Failed to terminate PyAudio")
            finally:
                self._pa = None

    def _clear_queue(self) -> None:
        """Remove stale clap events before starting a new listener session."""
        while True:
            try:
                self._clap_queue.get_nowait()
            except Empty:
                break
            else:
                self._clap_queue.task_done()
