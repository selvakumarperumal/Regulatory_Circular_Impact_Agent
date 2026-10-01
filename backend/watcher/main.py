"""Watcher: python main.py [--only RBI]

Saves each circular not seen before (the PDF in S3, a row with status new) and queues
a circular.read task for the workers. A circular is saved with its task or not at
all: if the download, S3 or the queue fails, nothing about it is kept, and the next
run tries it again."""

import argparse
import hashlib
import logging
import time

from sqlmodel import Session, select

import fetch
import storage
from common import queue
from common.db import init_db, make_engine
from common.models import Circular
from config import settings
from sources import SOURCES, Item, resolve_pdf_url

log = logging.getLogger("watcher")
engine = make_engine(settings.DATABASE_URL)
tasks = queue.connect(settings.REDIS_URL)


def fetch_new(item: Item) -> None:
    """Store the PDF in S3, then add the row. Sites sometimes answer 200 with an HTML
    error page, so the file must really be a PDF."""
    pdf_url = resolve_pdf_url(item)
    data = fetch.get(pdf_url).content
    if not data.startswith(b"%PDF"):
        raise ValueError(f"not a PDF: {pdf_url}")
    sha = hashlib.sha256(data).hexdigest()
    s3_key = f"{item.source.lower()}/{sha}.pdf"
    storage.put_pdf(s3_key, data)
    with Session(engine) as session:
        circular = Circular(
            source=item.source,
            source_key=item.source_key,
            title=item.title,
            detail_url=item.detail_url,
            pdf_url=pdf_url,
            published_at=item.published_at,
            sha256=sha,
            s3_key=s3_key,
        )
        session.add(circular)
        session.commit()
        try:
            queue.enqueue(tasks, "circular.read", circular_id=circular.id)
        except Exception:
            session.delete(circular)
            session.commit()
            raise


def run_source(name: str) -> None:
    """Fetch every circular in the listing that isn't in the database yet."""
    try:
        items = SOURCES[name]()
    except Exception as e:
        log.error("%s: listing failed: %s", name, e)
        return
    with Session(engine) as session:
        known = set(
            session.exec(select(Circular.source_key).where(Circular.source == name))
        )
    new = failed = 0
    for item in items:
        if item.source_key in known:
            continue
        try:
            fetch_new(item)
            known.add(item.source_key)
            new += 1
            log.info("%s new: %s", name, item.title[:80])
        except Exception as e:
            failed += 1
            log.warning("%s failed (%s): %s", name, item.detail_url, e)
    log.info("%s: seen=%d new=%d failed=%d", name, len(items), new, failed)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="run a single source, e.g. RBI")
    args = parser.parse_args()
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)

    init_db(engine)
    names = [args.only.upper()] if args.only else list(SOURCES)
    while True:
        for name in names:
            run_source(name)
        if settings.INTERVAL_MINUTES <= 0:
            break
        log.info("sleeping %d minutes", settings.INTERVAL_MINUTES)
        time.sleep(settings.INTERVAL_MINUTES * 60)


if __name__ == "__main__":
    main()
