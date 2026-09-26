"""Watcher: python main.py [--only RBI]

Finds circulars not seen before, stores the PDF in S3 and adds a row with status 'new'
for the worker. With INTERVAL_MINUTES > 0 it keeps running (as in Docker); 0 runs once."""
import argparse
import hashlib
import logging
import time

from sqlmodel import Session, select

import fetch
import storage
from common.db import init_db, make_engine
from common.models import Circular
from config import settings
from sources import SOURCES, Item, resolve_pdf_url

log = logging.getLogger("watcher")
engine = make_engine(settings.DATABASE_URL)


def known_keys(source: str) -> set[str]:
    """The source_keys already in the database for this regulator (one query per run)."""
    with Session(engine) as session:
        return set(session.exec(select(Circular.source_key).where(Circular.source == source)).all())


def fetch_new(item: Item) -> None:
    pdf_url = resolve_pdf_url(item)
    data = fetch.get(pdf_url).content
    if not data.startswith(b"%PDF"):   # gov sites sometimes return an HTML error page with 200
        raise ValueError(f"not a PDF: {pdf_url}")
    sha = hashlib.sha256(data).hexdigest()
    s3_key = f"{item.source.lower()}/{sha}.pdf"
    storage.put_pdf(s3_key, data)
    with Session(engine) as session:
        session.add(Circular(
            source=item.source, source_key=item.source_key, title=item.title,
            detail_url=item.detail_url, pdf_url=pdf_url, published_at=item.published_at,
            sha256=sha, s3_key=s3_key,
        ))
        session.commit()


def run_source(name: str) -> None:
    try:
        items = SOURCES[name]()
    except Exception as e:
        log.error("%s: listing failed: %s", name, e)
        return
    known = known_keys(name)
    new = failed = 0
    for item in items:
        if item.source_key in known:
            continue
        try:
            fetch_new(item)
            known.add(item.source_key)    # a listing can show the same circular twice
            new += 1
            log.info("%s new: %s", name, item.title[:80])
        except Exception as e:          # skip it; retried next run since nothing was saved
            failed += 1
            log.warning("%s failed (%s): %s", name, item.detail_url, e)
    log.info("%s: seen=%d new=%d failed=%d", name, len(items), new, failed)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="run a single source, e.g. RBI")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
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
