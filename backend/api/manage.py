"""Admin commands, run beside the api:

    uv run python manage.py add-user EMAIL NAME [--company ID]
    uv run python manage.py companies

add-user gives a company a login, or a new password if the login exists. The password
is read from RCI_PASSWORD, or asked for."""

import argparse
import getpass
import os
import sys

from sqlmodel import Session, select

from auth import hash_password
from common.db import init_db
from common.models import Company, User
from database import engine


def add_user(session: Session, email: str, name: str, company_id: int) -> None:
    if session.get(Company, company_id) is None:
        sys.exit(f"no company {company_id}: see `manage.py companies`")
    password = os.environ.get("RCI_PASSWORD") or getpass.getpass("password: ")
    if len(password) < 8:
        sys.exit("the password needs at least 8 characters")
    email = email.strip().lower()
    user = session.exec(select(User).where(User.email == email)).first()
    user = user or User(company_id=company_id, email=email, name=name)
    user.password_hash = hash_password(password)
    session.add(user)
    session.commit()
    print(f"{email} can sign in to company {user.company_id}")


def companies(session: Session) -> None:
    for company in session.exec(select(Company).order_by(Company.id)):
        users = session.exec(select(User.email).where(User.company_id == company.id))
        print(f"{company.id:>4}  {company.name:<30} {', '.join(users) or '(no users)'}")


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    add = commands.add_parser("add-user", help="a login, or a new password")
    add.add_argument("email")
    add.add_argument("name")
    add.add_argument("--company", type=int, default=1)
    commands.add_parser("companies", help="every company and its users")
    args = parser.parse_args()
    init_db(engine)
    with Session(engine) as session:
        if args.command == "add-user":
            add_user(session, args.email, args.name, args.company)
        else:
            companies(session)


if __name__ == "__main__":
    main()
