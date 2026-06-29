"""One-time Google authorization (read-only Calendar) for F.E.A.R.

Setup (all local, nothing committed):
  1. Create a project at https://console.cloud.google.com
  2. Enable the "Google Calendar API".
  3. Create an OAuth client of type "Desktop app" and download it as
     credentials.json into the project root (path = GOOGLE_CREDENTIALS_FILE).
  4. Add yourself as a test user on the OAuth consent screen.
  5. Run this once:

         python scripts/google_login.py

It opens a browser to authorize read-only calendar access, then caches the token
(GOOGLE_TOKEN_FILE) so F.E.A.R. can read your agenda. You never share credentials.
"""

from __future__ import annotations

import sys
from pathlib import Path

from dotenv import load_dotenv

from fear.config import Settings


def main() -> int:
    load_dotenv()
    settings = Settings.from_env()

    creds_path = Path(settings.google_credentials_file).expanduser()
    if not creds_path.exists():
        print(f"Não encontrei {creds_path}.")
        print(
            "Baixe o credentials.json (OAuth 'Desktop') do Google Cloud e salve nesse caminho "
            "(ou ajuste GOOGLE_CREDENTIALS_FILE no .env)."
        )
        return 1

    # Imported here so the script gives a clean error if the libs are not installed.
    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(
        str(creds_path), [settings.google_calendar_scope]
    )
    creds = flow.run_local_server(port=0)

    token_path = Path(settings.google_token_file).expanduser()
    token_path.parent.mkdir(parents=True, exist_ok=True)
    token_path.write_text(creds.to_json(), encoding="utf-8")

    print(f"Autorizado. Token salvo em {token_path}. F.E.A.R. já lê sua agenda (somente leitura).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
