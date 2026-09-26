"""Worker: python main.py [--once]

Every POLL_SECONDS: embed new/edited policies and check them against the recent circulars
that apply, mark circulars older than LOOKBACK_DAYS as 'skipped', then run the pipeline on
waiting circulars one by one, newest first. If OCR or Gemini is down, rate-limited or fails
for a moment, it waits and tries again; nothing already done is lost or done twice."""
import argparse
import logging
import time
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, col, select

import llm
import pipeline
from common.db import init_db, make_engine
from common.models import Circular
from config import settings
from failures import MAX_TRIES, gemini_status, service_crashed, service_down, temporary

log = logging.getLogger("worker")
engine = make_engine(settings.DATABASE_URL)

crashes: Counter[int] = Counter()     # temporary failures per circular; MAX_TRIES and it's marked failed


def skip_old(session: Session) -> None:
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.LOOKBACK_DAYS)
    old = session.exec(select(Circular).where(Circular.status == "new", Circular.published_at < cutoff)).all()
    for c in old:
        c.status = "skipped"
    session.commit()
    if old:
        log.info("skipped %d circulars published before %s", len(old), cutoff.date())


def next_circular(session: Session) -> Circular | None:
    return session.exec(
        select(Circular)
        .where(col(Circular.status).in_(["new", "parsed"]))
        .order_by(col(Circular.published_at).desc().nulls_last())
    ).first()


def update_library(session: Session) -> None:
    """New and edited policies: embed them, then check them against the recent circulars.
    A temporary failure ends the round (it's retried); any other is logged, and the
    circulars still get processed."""
    try:
        pipeline.embed_policies(session)
        pipeline.check_recent(session)
    except Exception as e:
        session.rollback()
        if temporary(e):
            raise
        log.exception("couldn't update the policy library's embeddings or checks")


def run_once() -> None:
    with Session(engine) as session:
        update_library(session)
        skip_old(session)
        while c := next_circular(session):
            log.info("#%d %s: %s", c.id, c.source, c.title[:90])
            try:
                pipeline.process(session, c)
            except Exception as e:
                session.rollback()
                if service_down(e):
                    raise                 # stop this round; the circular stays waiting
                if service_crashed(e):
                    crashes[c.id] += 1
                    if crashes[c.id] < MAX_TRIES:
                        raise
                log.exception("#%d failed", c.id)
                c.status, c.error = "failed", f"{type(e).__name__}: {e}"
                session.commit()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="work through the queue once and exit")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    # google-genai logs a line per call, and warns once that LangChain calls generate_content
    # directly (with no tools, so the warning doesn't apply)
    logging.getLogger("google_genai").setLevel(logging.ERROR)

    init_db(engine)
    try:
        llm.check()
    except Exception as e:
        status = gemini_status(e)
        if status is None or status == 429 or status >= 500:
            raise                         # not a configuration problem
        # 4xx: a bad key or model name, so nothing would work
        raise SystemExit(f"Gemini rejected the configuration (GEMINI_API_KEY / GEMINI_MODEL_NAME / "
                         f"GEMINI_EMBEDDING_MODEL_NAME): {e}") from e
    log.info("using %s and %s", settings.GEMINI_MODEL_NAME, settings.GEMINI_EMBEDDING_MODEL_NAME)

    while True:
        try:
            run_once()
        except Exception as e:
            if not temporary(e):
                raise
            log.warning("OCR or Gemini unavailable (%s); retrying in %ds", e, settings.POLL_SECONDS)
        if args.once:
            break
        time.sleep(settings.POLL_SECONDS)


if __name__ == "__main__":
    main()
