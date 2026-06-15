from __future__ import annotations

import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKUP_DIR = ROOT / ".refactor_backup"

MAIN_PY = '''from __future__ import annotations

from fear.web.app import run


if __name__ == "__main__":
    run()
'''

UNIFIED_SERVER_PY = '''from __future__ import annotations

from fear.web.app import app, run

__all__ = ["app", "run"]


if __name__ == "__main__":
    run()
'''

WEB_API_PY = '''from __future__ import annotations

from fear.web.app import app

__all__ = ["app"]
'''


def backup(path: Path) -> None:
    if not path.exists():
        return

    backup_path = BACKUP_DIR / path.relative_to(ROOT)
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, backup_path)


def write(path: str, content: str) -> None:
    target = ROOT / path
    backup(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    print(f"updated {path}")


def remove(path: str) -> None:
    target = ROOT / path
    if not target.exists():
        return

    backup(target)
    target.unlink()
    print(f"removed {path}")


def main() -> None:
    BACKUP_DIR.mkdir(exist_ok=True)
    write("main.py", MAIN_PY)
    write("fear/web/unified_server.py", UNIFIED_SERVER_PY)
    write("fear/web/api.py", WEB_API_PY)
    remove("fear/web/unified_server_cors.py")
    remove("fear/assistant.py")
    remove("fear/memory/vector_store.py")
    print("runtime refactor applied")
    print(f"backups saved in {BACKUP_DIR}")


if __name__ == "__main__":
    main()
