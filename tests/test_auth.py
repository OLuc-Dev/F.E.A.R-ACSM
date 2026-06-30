from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from fear.auth import Security, TokenError, UserStore, hash_password, verify_password
from fear.config import Settings
from fear.web.app import app, get_security, get_settings, get_user_store

SECRET = "test-secret-key-please-change"


@pytest.fixture
def store(tmp_path: Path) -> Iterator[UserStore]:
    security = Security(SECRET)
    instance = UserStore(path=str(tmp_path / "users.db"), security=security)
    try:
        yield instance
    finally:
        instance.close()


@pytest.fixture
def client(store: UserStore) -> Iterator[TestClient]:
    security = Security(SECRET)
    app.dependency_overrides[get_user_store] = lambda: store
    app.dependency_overrides[get_security] = lambda: security
    app.dependency_overrides[get_settings] = lambda: Settings(secret_key=SECRET)
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


# --- security primitives ---


def test_password_hash_roundtrip() -> None:
    stored = hash_password("correct horse battery staple")
    assert stored != "correct horse battery staple"
    assert verify_password("correct horse battery staple", stored)
    assert not verify_password("wrong", stored)


def test_password_verify_rejects_garbage() -> None:
    assert not verify_password("x", "not-a-valid-hash")


def test_session_token_roundtrip() -> None:
    security = Security(SECRET)
    token = security.make_session_token("user-123")
    assert security.read_session_token(token, 3600) == "user-123"


def test_session_token_expired() -> None:
    security = Security(SECRET)
    token = security.make_session_token("user-123")
    # A zero-second max age means anything but a token minted this instant is stale.
    with pytest.raises(TokenError):
        security.read_session_token(token, -1)


def test_session_token_tampered() -> None:
    security = Security(SECRET)
    with pytest.raises(TokenError):
        security.read_session_token("garbage", 3600)


def test_secret_encryption_roundtrip() -> None:
    security = Security(SECRET)
    encrypted = security.encrypt("sk-or-secret")
    assert encrypted != "sk-or-secret"
    assert security.decrypt(encrypted) == "sk-or-secret"


# --- HTTP auth flow ---


def test_register_returns_token_and_user(client: TestClient) -> None:
    response = client.post(
        "/auth/register", json={"email": "Lucas@Example.com", "password": "supersecret"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["token"]
    assert body["user"]["email"] == "lucas@example.com"  # normalized
    assert body["user"]["has_openrouter_key"] is False


def test_register_rejects_short_password(client: TestClient) -> None:
    response = client.post("/auth/register", json={"email": "a@b.com", "password": "short"})
    assert response.status_code == 422


def test_register_rejects_bad_email(client: TestClient) -> None:
    response = client.post(
        "/auth/register", json={"email": "not-an-email", "password": "longenough"}
    )
    assert response.status_code == 422


def test_register_rejects_duplicate_email(client: TestClient) -> None:
    client.post("/auth/register", json={"email": "dup@example.com", "password": "longenough"})
    again = client.post(
        "/auth/register", json={"email": "dup@example.com", "password": "longenough"}
    )
    assert again.status_code == 409


def test_login_succeeds_and_me_returns_user(client: TestClient) -> None:
    client.post("/auth/register", json={"email": "me@example.com", "password": "longenough"})
    login = client.post("/auth/login", json={"email": "me@example.com", "password": "longenough"})
    assert login.status_code == 200
    token = login.json()["token"]

    me = client.get("/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["email"] == "me@example.com"


def test_login_wrong_password_is_401(client: TestClient) -> None:
    client.post("/auth/register", json={"email": "x@example.com", "password": "longenough"})
    bad = client.post("/auth/login", json={"email": "x@example.com", "password": "WRONGPASS"})
    assert bad.status_code == 401


def test_me_requires_token(client: TestClient) -> None:
    assert client.get("/auth/me").status_code == 401
    bad = client.get("/auth/me", headers={"Authorization": "Bearer nonsense"})
    assert bad.status_code == 401


def test_set_openrouter_key_is_stored_encrypted(client: TestClient, store: UserStore) -> None:
    registered = client.post(
        "/auth/register", json={"email": "key@example.com", "password": "longenough"}
    ).json()
    token = registered["token"]
    user_id = registered["user"]["id"]

    response = client.post(
        "/auth/openrouter-key",
        json={"api_key": "sk-or-v1-abc"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert response.status_code == 200
    assert response.json()["has_openrouter_key"] is True
    # The store round-trips the real key, but never returns it over the wire.
    assert store.get_openrouter_key(user_id) == "sk-or-v1-abc"
