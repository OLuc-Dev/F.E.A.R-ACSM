from __future__ import annotations

import sqlite3
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from fear.auth.security import Security, hash_password, verify_password


@dataclass(slots=True)
class User:
    """A registered user. Never carries the raw password or the raw API key."""

    id: str
    email: str
    created_at: float
    chat_model: str = ""
    persona_mode: str = ""
    has_openrouter_key: bool = False
    # Bumped to revoke every existing session for this user (logout-everywhere).
    token_version: int = 1


class EmailTaken(Exception):
    """Raised when registering an email that already exists."""


class UserStore:
    """SQLite-backed user store. OpenRouter keys are encrypted at rest.

    One connection is shared across FastAPI's worker threads (store calls run via
    asyncio.to_thread), so every access is serialized behind a lock — correct and
    more than fast enough at this scale.
    """

    def __init__(self, *, path: str, security: Security) -> None:
        self.path = path
        self._security = security
        self._lock = threading.Lock()
        if path != ":memory:":
            Path(path).expanduser().parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        if path != ":memory:":
            self._conn.execute("PRAGMA journal_mode=WAL")
        self._create_schema()

    def _create_schema(self) -> None:
        with self._lock:
            self._conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY,
                    email TEXT NOT NULL UNIQUE,
                    password_hash TEXT NOT NULL,
                    openrouter_key TEXT NOT NULL DEFAULT '',
                    chat_model TEXT NOT NULL DEFAULT '',
                    persona_mode TEXT NOT NULL DEFAULT '',
                    created_at REAL NOT NULL,
                    token_version INTEGER NOT NULL DEFAULT 1
                )
                """
            )
            # Migrate databases created before token_version existed (additive).
            columns = {row["name"] for row in self._conn.execute("PRAGMA table_info(users)")}
            if "token_version" not in columns:
                self._conn.execute(
                    "ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 1"
                )
            self._conn.commit()

    def create_user(self, email: str, password: str) -> User:
        """Create a user; raises EmailTaken if the email already exists."""
        normalized = email.strip().lower()
        user_id = uuid.uuid4().hex
        created_at = time.time()
        with self._lock:
            existing = self._conn.execute(
                "SELECT 1 FROM users WHERE email = ?", (normalized,)
            ).fetchone()
            if existing is not None:
                raise EmailTaken(normalized)
            self._conn.execute(
                "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (user_id, normalized, hash_password(password), created_at),
            )
            self._conn.commit()
        return User(id=user_id, email=normalized, created_at=created_at)

    def verify_credentials(self, email: str, password: str) -> User | None:
        """Return the user when the password matches, otherwise None."""
        normalized = email.strip().lower()
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE email = ?", (normalized,)
            ).fetchone()
        if row is None or not verify_password(password, row["password_hash"]):
            return None
        return self._row_to_user(row)

    def get_by_id(self, user_id: str) -> User | None:
        with self._lock:
            row = self._conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()
        return self._row_to_user(row) if row is not None else None

    def get_by_email(self, email: str) -> User | None:
        with self._lock:
            row = self._conn.execute(
                "SELECT * FROM users WHERE email = ?", (email.strip().lower(),)
            ).fetchone()
        return self._row_to_user(row) if row is not None else None

    def set_openrouter_key(self, user_id: str, api_key: str) -> None:
        """Store (encrypted) or clear a user's OpenRouter key."""
        encrypted = self._security.encrypt(api_key) if api_key else ""
        with self._lock:
            self._conn.execute(
                "UPDATE users SET openrouter_key = ? WHERE id = ?", (encrypted, user_id)
            )
            self._conn.commit()

    def get_openrouter_key(self, user_id: str) -> str:
        """Return the decrypted OpenRouter key, or "" if unset/unreadable."""
        with self._lock:
            row = self._conn.execute(
                "SELECT openrouter_key FROM users WHERE id = ?", (user_id,)
            ).fetchone()
        if row is None or not row["openrouter_key"]:
            return ""
        try:
            return self._security.decrypt(row["openrouter_key"])
        except Exception:
            # A key encrypted under a now-rotated secret is unreadable; treat it
            # as absent so the user is simply asked to re-enter it.
            return ""

    def set_preferences(
        self, user_id: str, *, chat_model: str | None = None, persona_mode: str | None = None
    ) -> None:
        """Persist a user's model / persona-mode choices (skips None fields)."""
        fields: list[str] = []
        values: list[object] = []
        if chat_model is not None:
            fields.append("chat_model = ?")
            values.append(chat_model)
        if persona_mode is not None:
            fields.append("persona_mode = ?")
            values.append(persona_mode)
        if not fields:
            return
        values.append(user_id)
        with self._lock:
            self._conn.execute(f"UPDATE users SET {', '.join(fields)} WHERE id = ?", values)
            self._conn.commit()

    def bump_token_version(self, user_id: str) -> None:
        """Invalidate every existing session for a user (logout-everywhere)."""
        with self._lock:
            self._conn.execute(
                "UPDATE users SET token_version = token_version + 1 WHERE id = ?", (user_id,)
            )
            self._conn.commit()

    def close(self) -> None:
        with self._lock:
            self._conn.close()

    @staticmethod
    def _row_to_user(row: sqlite3.Row) -> User:
        return User(
            id=row["id"],
            email=row["email"],
            created_at=float(row["created_at"]),
            chat_model=row["chat_model"],
            persona_mode=row["persona_mode"],
            has_openrouter_key=bool(row["openrouter_key"]),
            token_version=int(row["token_version"]),
        )
