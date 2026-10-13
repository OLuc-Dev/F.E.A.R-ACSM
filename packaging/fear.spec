# PyInstaller recipe for the F.E.A.R. Windows app. Build from the repo root:
#   NEXT_PUBLIC_FEAR_DESKTOP=1 npm run build      (the UI, into out/)
#   python packaging/fetch_model.py               (the embedding model)
#   pyinstaller packaging/fear.spec
from pathlib import Path

from PyInstaller.utils.hooks import collect_all, collect_submodules

ROOT = Path(SPECPATH).parent
PACKAGING = ROOT / "packaging"

datas = [
    (str(ROOT / "out"), "ui"),
    (str(ROOT / "prompts"), "prompts"),
    (str(PACKAGING / "fear.ico"), "packaging"),
]
model = PACKAGING / "build" / "onnx_models"
if model.exists():
    datas.append((str(model), "onnx_models"))
# Speech: Whisper (recognition) + Piper (F.E.A.R.'s voice), from fetch_voice_models.py.
voice = PACKAGING / "build" / "voice"
if voice.exists():
    datas.append((str(voice), "voice"))
datas.append((str(PACKAGING / "THIRD_PARTY_NOTICES.md"), "."))

binaries = []
hiddenimports = collect_submodules("fear")
# These load parts of themselves dynamically (drivers, providers, platform
# backends), which static analysis alone misses.
for package in (
    "chromadb",
    "onnxruntime",
    "tokenizers",
    "uvicorn",
    "pyttsx3",
    "webview",
    "pystray",
    # Speech: faster-whisper loads its VAD model from package data, CTranslate2
    # and PyAV ship native libraries, and Piper carries espeak-ng's data.
    "faster_whisper",
    "ctranslate2",
    "av",
    "piper",
):
    package_datas, package_binaries, package_hidden = collect_all(package)
    datas += package_datas
    binaries += package_binaries
    hiddenimports += package_hidden

a = Analysis(
    [str(PACKAGING / "launch.py")],
    pathex=[str(ROOT)],
    datas=datas,
    binaries=binaries,
    hiddenimports=hiddenimports,
    # Whisper/torch are the optional voice stack (gigabytes); the app ships without it.
    excludes=["torch", "whisper", "tkinter", "matplotlib", "IPython", "pytest"],
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="FEAR",
    console=False,
    icon=str(PACKAGING / "fear.ico"),
)
coll = COLLECT(exe, a.binaries, a.datas, name="FEAR")
