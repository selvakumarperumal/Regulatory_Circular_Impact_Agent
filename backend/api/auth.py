"""Accounts: passwords, login tokens, and who is calling.

A password is stored as a scrypt hash (Python's hashlib) with its own random salt,
never as itself. A login token is a JWT signed with HS256 that names the user and
their company, valid for TOKEN_HOURS. The signing key is JWT_SECRET, or else a random
key made on first start and kept in the database, so tokens survive restarts.

Every route except sign-up, login and /health takes `CurrentUser`, and only ever reads
or writes that user's company's rows."""

import hashlib
import hmac
import secrets
from datetime import timedelta
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session

from common.models import AppSecret, User, now
from config import settings
from database import SessionDep, engine

SCRYPT = {"n": 2**14, "r": 8, "p": 1, "dklen": 32}
bearer = HTTPBearer(auto_error=False)
cached_key: list[str] = []


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, **SCRYPT)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_ok(password: str, stored: str) -> bool:
    try:
        _, salt, digest = stored.split("$")
    except ValueError:
        return False
    check = hashlib.scrypt(password.encode(), salt=bytes.fromhex(salt), **SCRYPT)
    return hmac.compare_digest(check.hex(), digest)


def signing_key() -> str:
    """JWT_SECRET, or the key made on first start. Two api processes starting at once
    may both try to make it; the second one keeps the first one's."""
    if settings.JWT_SECRET:
        return settings.JWT_SECRET
    if not cached_key:
        with Session(engine) as session:
            row = session.get(AppSecret, "jwt")
            if row is None:
                session.add(AppSecret(name="jwt", value=secrets.token_urlsafe(48)))
                try:
                    session.commit()
                except IntegrityError:
                    session.rollback()
                row = session.get(AppSecret, "jwt")
            cached_key.append(row.value)
    return cached_key[0]


def issue_token(user: User) -> str:
    payload = {
        "sub": str(user.id),
        "cid": user.company_id,
        "exp": now() + timedelta(hours=settings.TOKEN_HOURS),
    }
    return jwt.encode(payload, signing_key(), algorithm="HS256")


def current_user(
    session: SessionDep,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
) -> User:
    if credentials is None:
        raise HTTPException(401, "sign in first", {"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(
            credentials.credentials, signing_key(), algorithms=["HS256"]
        )
    except jwt.PyJWTError:
        raise HTTPException(
            401, "your session has ended: sign in again", {"WWW-Authenticate": "Bearer"}
        ) from None
    user = session.get(User, int(payload["sub"]))
    if user is None:
        raise HTTPException(401, "this account no longer exists")
    return user


CurrentUser = Annotated[User, Depends(current_user)]
