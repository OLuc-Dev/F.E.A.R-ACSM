"""The Windows app's own preferences: the switches its settings panel flips.

Kept apart from ``.env`` (which stays for advanced overrides) so the app can
change them live and remember them, without anyone editing a hidden file.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

logger = logging.getLogger(__name__)

APP_NAME = "F.E.A.R."
RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"


@dataclass(slots=True)
class DesktopPrefs:
    claps: bool = False
    obsidian_vault: str = ""


def load_prefs(path: str | Path) -> DesktopPrefs:
    """The saved preferences, or the defaults when there are none (or they're unreadable)."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return DesktopPrefs()
    if not isinstance(raw, dict):
        return DesktopPrefs()
    return DesktopPrefs(
        claps=bool(raw.get("claps", False)),
        obsidian_vault=str(raw.get("obsidian_vault", "") or ""),
    )


def save_prefs(path: str | Path, prefs: DesktopPrefs) -> None:
    """Write atomically: a crash mid-write must not leave a half file behind."""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(asdict(prefs), ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, target)


# --- "Iniciar com o Windows" (the same Run entry the installer writes) ------------


def autostart_available() -> bool:
    return sys.platform == "win32"


def autostart_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}" --minimized'
    return f'"{sys.executable}" -m fear.desktop --minimized'


def autostart_enabled() -> bool:
    if sys.platform != "win32":
        return False
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as key:
            winreg.QueryValueEx(key, APP_NAME)
        return True
    except OSError:
        return False


def set_autostart(enabled: bool) -> None:
    if sys.platform != "win32":
        return
    import winreg

    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as key:
        if enabled:
            winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, autostart_command())
        else:
            try:
                winreg.DeleteValue(key, APP_NAME)
            except FileNotFoundError:
                pass
