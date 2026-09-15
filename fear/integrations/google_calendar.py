from __future__ import annotations

import asyncio
import logging
import os
import stat
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# Read-only Google Calendar access for F.E.A.R. The google libraries are imported
# lazily (inside methods) so the conversational core can be imported and tested
# without them, mirroring how ChromaDB is handled.

# The token file holds a long-lived refresh token plus the client secret, so it
# must never be readable by other local users.
_OWNER_ONLY = stat.S_IRUSR | stat.S_IWUSR


def write_token_securely(path: Path, payload: str) -> None:
    """Write an OAuth token file readable only by its owner (0600).

    A plain ``write_text`` uses the process umask (typically 0644), leaving the
    refresh token world-readable — enough for any other local account to mint
    access tokens for the user's calendar indefinitely.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    try:
        os.chmod(path, _OWNER_ONLY)
    except OSError:
        # Filesystems without POSIX permissions (some Windows/mounted volumes).
        logger.warning("Could not restrict permissions on %s", path)


class GoogleCalendarClient:
    """Async-friendly, read-only wrapper around the Google Calendar API."""

    def __init__(
        self,
        *,
        credentials_file: str,
        token_file: str,
        calendar_id: str = "primary",
        scope: str = "https://www.googleapis.com/auth/calendar.readonly",
    ) -> None:
        self.credentials_file = credentials_file
        self.token_file = token_file
        self.calendar_id = calendar_id
        self.scope = scope
        self._service: Any = None

    @property
    def is_configured(self) -> bool:
        """True once a cached token has been loaded into a live service."""
        return self._service is not None

    async def load(self) -> None:
        """Build the Calendar service from the cached token, if one exists."""
        if self._service is not None:
            return
        if not self._token_path().exists():
            return  # not authorized yet — run scripts/google_login.py
        try:
            self._service = await asyncio.to_thread(self._build_service)
        except Exception:
            logger.exception("Could not initialize Google Calendar; staying inert")

    def _token_path(self) -> Path:
        """The token file with `~` expanded.

        Every access must go through here: `Credentials.from_authorized_user_file`
        opens the path literally, so mixing expanded and raw forms made a
        GOOGLE_TOKEN_FILE like "~/.fear/token.json" pass the existence check and
        then fail to open, leaving the calendar permanently inert.
        """
        return Path(self.token_file).expanduser()

    def _build_service(self) -> Any:
        from google.auth.transport.requests import Request
        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build

        token_path = self._token_path()
        creds = Credentials.from_authorized_user_file(str(token_path), [self.scope])
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
            write_token_securely(token_path, creds.to_json())
        return build("calendar", "v3", credentials=creds, cache_discovery=False)

    async def upcoming(self, max_results: int = 8) -> str:
        """Return a short, human summary of the next events (empty when inert)."""
        if self._service is None:
            return ""
        events = await asyncio.to_thread(self._fetch, max_results)
        return self._format(events)

    def _fetch(self, max_results: int) -> list[dict[str, Any]]:
        now = datetime.now(UTC).isoformat()
        result = (
            self._service.events()
            .list(
                calendarId=self.calendar_id,
                timeMin=now,
                maxResults=max_results,
                singleEvents=True,
                orderBy="startTime",
            )
            .execute()
        )
        return result.get("items", []) or []

    @staticmethod
    def _format(events: list[dict[str, Any]]) -> str:
        if not events:
            return "Sua agenda está limpa — nada nos próximos compromissos."

        lines = []
        for event in events:
            start = event.get("start", {})
            title = (event.get("summary") or "(sem título)").strip()
            when = GoogleCalendarClient._format_when(start)
            lines.append(f"• {when} — {title}")
        return "Seus próximos compromissos:\n" + "\n".join(lines)

    @staticmethod
    def _format_when(start: dict[str, Any]) -> str:
        raw = start.get("dateTime")
        if raw:
            try:
                moment = datetime.fromisoformat(raw)
                return moment.strftime("%d/%m %H:%M")
            except ValueError:
                return str(raw)
        day = start.get("date")
        if day:
            try:
                return datetime.fromisoformat(day).strftime("%d/%m (dia inteiro)")
            except ValueError:
                return f"{day} (dia inteiro)"
        return "sem horário"

    async def handle_intent(self, text: str) -> str:
        """For now, any calendar question returns the upcoming agenda (read-only)."""
        return await self.upcoming()
