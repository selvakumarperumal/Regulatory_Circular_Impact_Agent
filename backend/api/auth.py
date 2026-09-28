"""Passwords (salted scrypt), login tokens (a JWT naming the user, signed with
JWT_SECRET or a key made on first start and kept in app_secrets), and CurrentUser:
who is calling. Every route but sign-up, login and /health needs it."""

import hashlib
import hmac
import secrets
from contextlib import suppress
from datetime import timedelta
from functools import cache
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.dialects.postgresql import insert
from sqlmodel import Session

from common.models import AppSecret, User, now
from config import settings
from database import SessionDep, engine


def hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=2**14, r=8, p=1, dklen=32)
    return f"scrypt${salt.hex()}${digest.hex()}"


def password_ok(password: str, stored: str) -> bool:
    salt = bytes.fromhex(stored.split("$")[1])
    return hmac.compare_digest(hash_password(password, salt), stored)


@cache
def signing_key() -> str:
    if settings.JWT_SECRET:
        return settings.JWT_SECRET
    with Session(engine) as session:
        new = secrets.token_urlsafe(48)
        session.execute(
            insert(AppSecret).values(name="jwt", value=new).on_conflict_do_nothing()
        )
        session.commit()
        return session.get(AppSecret, "jwt").value


def issue_token(user: User) -> str:
    expires = now() + timedelta(hours=settings.TOKEN_HOURS)
    return jwt.encode({"sub": str(user.id), "exp": expires}, signing_key(), "HS256")


def current_user(
    session: SessionDep,
    credentials: Annotated[
        HTTPAuthorizationCredentials | None, Depends(HTTPBearer(auto_error=False))
    ],
) -> User:
    user = None
    if credentials:
        with suppress(jwt.PyJWTError):
            claims = jwt.decode(credentials.credentials, signing_key(), ["HS256"])
            user = session.get(User, int(claims["sub"]))
    if user is None:
        raise HTTPException(401, "please sign in", {"WWW-Authenticate": "Bearer"})
    return user


CurrentUser = Annotated[User, Depends(current_user)]
