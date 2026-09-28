"""Admin commands, run beside the api (or in its container):

    uv run python manage.py add-user EMAIL NAME [--company ID]
    uv run python manage.py set-password EMAIL
    uv run python manage.py companies

A company that existed before logins (your data, moved into company 1) has no user
yet: add-user gives it one. The password is read from RCI_PASSWORD if set, or asked
for; with --generate a random one is made and printed once."""

import argparse
import getpass
import os
import secrets
import sys

from sqlmodel import Session, select

from auth import hash_password
from common.db import init_db
from common.models import Company, User
from database import engine


def ask_password(generate: bool) -> str:
    if generate:
        password = secrets.token_urlsafe(12)
        print(f"password: {password}   (change it in the console: Company > Password)")
        return password
    password = os.environ.get("RCI_PASSWORD") or getpass.getpass("password: ")
    if len(password) < 8:
        sys.exit("the password needs at least 8 characters")
    return password


def add_user(session: Session, args: argparse.Namespace) -> None:
    company = session.get(Company, args.company)
    if company is None:
        sys.exit(f"no company {args.company}: see `manage.py companies`")
    email = args.email.strip().lower()
    if session.exec(select(User).where(User.email == email)).first():
        sys.exit(f"{email} already has an account")
    session.add(
        User(
            company_id=company.id,
            email=email,
            name=args.name,
            password_hash=hash_password(ask_password(args.generate)),
        )
    )
    session.commit()
    print(f"{email} can now sign in to {company.name} (company {company.id})")


def set_password(session: Session, args: argparse.Namespace) -> None:
    user = session.exec(select(User).where(User.email == args.email.lower())).first()
    if user is None:
        sys.exit(f"no account for {args.email}")
    user.password_hash = hash_password(ask_password(args.generate))
    session.commit()
    print(f"password changed for {user.email}")


def companies(session: Session, _: argparse.Namespace) -> None:
    for company in session.exec(select(Company).order_by(Company.id)):
        users = session.exec(select(User.email).where(User.company_id == company.id))
        print(f"{company.id:>4}  {company.name:<30} {', '.join(users) or '(no users)'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add-user", help="give a company a login")
    add.add_argument("email")
    add.add_argument("name")
    add.add_argument("--company", type=int, default=1)
    add.add_argument("--generate", action="store_true")
    add.set_defaults(run=add_user)
    reset = commands.add_parser("set-password", help="set a user's password")
    reset.add_argument("email")
    reset.add_argument("--generate", action="store_true")
    reset.set_defaults(run=set_password)
    commands.add_parser("companies", help="list companies and their users").set_defaults(
        run=companies
    )
    args = parser.parse_args()
    init_db(engine)
    with Session(engine) as session:
        args.run(session, args)


if __name__ == "__main__":
    main()
