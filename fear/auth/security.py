from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from cryptography.fernet import Fernet, InvalidToken

# PBKDF2 cost. High enough to be expensive to brute-force, low enough to stay
# imperceptible on a login request. Stored alongside each hash so it can rise
# over time without invalidating older hashes.
_PBKDF2_ITERATIONS = 240_000
_SALT_BYTES = 16


class TokenError(Exception):
    """Raised when a session token is missing, malformed, or expired."""


def hash_password(password: str) -> str:
    """Hash a password with PBKDF2-HMAC-SHA256 and a fresh random salt.

    Returns a self-describing string ("pbkdf2_sha256$iterations$salt$hash"), so
    verification needs nothing but the stored value.
    """
    if not password:
        raise ValueError("password cannot be empty")
    salt = secrets.token_bytes(_SALT_BYTES)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, _PBKDF2_ITERATIONS)
    return "$".join(
        [
            "pbkdf2_sha256",
            str(_PBKDF2_ITERATIONS),
            base64.b64encode(salt).decode("ascii"),
            base64.b64encode(digest).decode("ascii"),
        ]
    )


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of a password against a stored PBKDF2 hash."""
    try:
        algorithm, iterations_text, salt_b64, hash_b64 = stored.split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iterations_text)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(hash_b64)
    except (ValueError, TypeError):
        return False
    candidate = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(candidate, expected)


class Security:
    """Symmetric encryption + session tokens, both bound to one server secret.

    The secret comes from FEAR_SECRET_KEY. The same secret encrypts stored
    OpenRouter keys and signs session tokens, so rotating it simply invalidates
    both — every user logs in again and re-enters their key. Keep it stable and
    private in production.
    """

    def __init__(self, secret_key: str) -> None:
        if not secret_key:
            raise ValueError("secret_key cannot be empty")
        # Fernet wants a urlsafe-base64 32-byte key; derive one deterministically
        # from the (arbitrary-length) secret so any passphrase works as input.
        material = hashlib.sha256(secret_key.encode("utf-8")).digest()
        self._fernet = Fernet(base64.urlsafe_b64encode(material))

    def encrypt(self, plaintext: str) -> str:
        """Encrypt a short secret (e.g. an API key) for storage at rest."""
        return self._fernet.encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, token: str) -> str:
        """Reverse :meth:`encrypt`; raises TokenError if the value is corrupt."""
        try:
            return self._fernet.decrypt(token.encode("utf-8")).decode("utf-8")
        except InvalidToken as exc:
            raise TokenError("could not decrypt value") from exc

    def make_session_token(self, user_id: str) -> str:
        """Mint an opaque, tamper-proof session token carrying a user id."""
        return self._fernet.encrypt(user_id.encode("utf-8")).decode("ascii")

    def read_session_token(self, token: str, max_age_seconds: int) -> str:
        """Return the user id from a session token, or raise TokenError.

        Fernet embeds a timestamp, so ``max_age_seconds`` enforces expiry without
        any server-side session table.
        """
        try:
            raw = self._fernet.decrypt(token.encode("utf-8"), ttl=max_age_seconds)
        except InvalidToken as exc:
            raise TokenError("invalid or expired session token") from exc
        return raw.decode("utf-8")
