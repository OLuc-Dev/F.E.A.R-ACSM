"""Attach pre-account (un-owned) memories in the local store to an account.

Before accounts existed, F.E.A.R. stored everything in one shared memory. Run
this once, on the machine that holds your existing ``data/chroma``, AFTER you
have created your account in the app, to move that history onto your account:

    python scripts/claim_memories.py you@example.com

Requires FEAR_SECRET_KEY to be set to the same value the app uses (so the
account can be found). Existing memories are only re-tagged, never deleted.
"""

from __future__ import annotations

import argparse

from fear.auth import Security, UserStore
from fear.config import Settings
from fear.memory.personal_memory import PersonalMemory


def main() -> None:
    parser = argparse.ArgumentParser(description="Claim un-owned memories for an account.")
    parser.add_argument("email", help="the email you registered with in the app")
    args = parser.parse_args()

    settings = Settings.from_env()
    if not settings.secret_key:
        raise SystemExit("Set FEAR_SECRET_KEY (the same value the app uses) before running this.")

    store = UserStore(path=settings.users_db_path, security=Security(settings.secret_key))
    user = store.get_by_email(args.email)
    if user is None:
        raise SystemExit(f"No account found for {args.email}. Create it in the app first.")

    # The web runtime stores personal memory under the "personal_memory" collection.
    memory = PersonalMemory(path=settings.chroma_path, collection_name="personal_memory")
    claimed = memory.claim_unowned(user.id)
    print(f"Claimed {claimed} memory(ies) for {args.email}.")


if __name__ == "__main__":
    main()
