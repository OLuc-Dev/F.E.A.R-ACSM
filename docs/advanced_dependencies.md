# Dependencies

All runtime and dev dependencies live in `pyproject.toml`. Install with:

```bash
python -m pip install -e ".[dev]"
```

`requirements.txt` mirrors the runtime dependencies for tools that expect it,
but `pyproject.toml` is the canonical source.

The audio features (`pyaudio`, `openai-whisper`) need `portaudio` on the system,
e.g. `sudo apt-get install portaudio19-dev` on Debian/Ubuntu.
