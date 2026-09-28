"""Worker: python main.py [--once]

Every POLL_SECONDS: embed new/edited policies and check them against the recent
circulars that apply, mark circulars older than LOOKBACK_DAYS as 'skipped', then run
the pipeline on waiting circulars, newest first. If OCR or Gemini is down,
rate-limited or fails for a moment, it waits and tries again; nothing already done is
lost or done twice.

Several workers can run side by side (docker compose --scale worker=N). They share
the work through Postgres locks (locks.py): each circular is claimed by one worker,
one worker at a time reads PDFs on the GPU while the others run Gemini on circulars
already read, and one worker at a time updates the policy library."""

import argparse
import logging
import time
from collections import Counter
from datetime import UTC, datetime, timedelta

from sqlmodel import Session, col, select

import llm
import locks
import pipeline
from common.db import init_db, make_engine
from common.models import Circular
from config import settings
from failures import MAX_TRIES, gemini_status, service_crashed, service_down, temporary

log = logging.getLogger("worker")
engine = make_engine(settings.DATABASE_URL)
crashes: Counter[int] = Counter()
WAITING = ("new", "parsed")


def skip_old(session: Session) -> None:
    cutoff = datetime.now(UTC) - timedelta(days=settings.LOOKBACK_DAYS)
    old = session.exec(
        select(Circular).where(Circular.status == "new", Circular.published_at < cutoff)
    ).all()
    for c in old:
        c.status = "skipped"
    session.commit()
    if old:
        log.info("skipped %d circulars published before %s", len(old), cutoff.date())


def update_library(session: Session) -> None:
    """Mark old circulars skipped, embed new and edited policies, and check them against
    the recent circulars. One worker at a time; the others skip it. A temporary failure
    ends the round (it's retried); any other is logged, and circulars still get
    processed."""
    with locks.held(engine, locks.LIBRARY) as mine:
        if not mine:
            return
        skip_old(session)
        try:
            pipeline.embed_policies(session)
            pipeline.check_recent(session)
        except Exception as e:
            session.rollback()
            if temporary(e):
                raise
            log.exception("couldn't update the policy library's embeddings or checks")


def retry_later(c: Circular, e: Exception) -> bool:
    """A service that's down is waited for as long as it takes; one that crashed gets
    the circular retried up to MAX_TRIES times. Either way the circular keeps its
    status."""
    if service_down(e):
        return True
    if service_crashed(e):
        crashes[c.id] += 1
        return crashes[c.id] < MAX_TRIES
    return False


def waiting(session: Session) -> list[int]:
    return session.exec(
        select(Circular.id)
        .where(col(Circular.status).in_(WAITING))
        .order_by(col(Circular.published_at).desc().nulls_last())
    ).all()


def process(session: Session, c: Circular, wait_for_gpu: bool) -> bool:
    """Run the pipeline on a claimed circular. A new one needs the GPU first: without
    wait_for_gpu, it's left for later if another worker is using it. Returns whether
    the circular was worked on."""
    try:
        if c.status == "new":
            with locks.held(engine, locks.OCR, wait=wait_for_gpu) as gpu:
                if not gpu:
                    return False
                log.info("#%d %s: %s", c.id, c.source, c.title[:90])
                pipeline.parse(session, c)
        else:
            log.info("#%d %s: %s", c.id, c.source, c.title[:90])
        pipeline.analyze(session, c)
    except Exception as e:
        session.rollback()
        if retry_later(c, e):
            raise
        log.exception("#%d failed", c.id)
        c.status, c.error = "failed", f"{type(e).__name__}: {e}"
        session.commit()
    return True


def process_next(session: Session) -> bool:
    """Claim one waiting circular that no other worker holds, and process it. The first
    pass takes only what can start now; if nothing can, the second waits for the GPU.
    Returns False when every waiting circular belongs to another worker."""
    candidates = waiting(session)
    for wait_for_gpu in (False, True):
        for circular_id in candidates:
            with locks.held(engine, locks.CIRCULAR, circular_id) as mine:
                if not mine:
                    continue
                c = session.get(Circular, circular_id, populate_existing=True)
                if c is None or c.status not in WAITING:
                    continue
                if process(session, c, wait_for_gpu):
                    return True
    return False


def run_once() -> None:
    with Session(engine) as session:
        update_library(session)
        while process_next(session):
            pass


def check_gemini() -> None:
    """A 4xx at startup means a wrong key or model name, so nothing would work: stop
    with a clear message. A 429, a 5xx or no network is not a configuration problem."""
    try:
        llm.check()
    except Exception as e:
        status = gemini_status(e)
        if status is None or status == 429 or status >= 500:
            raise
        raise SystemExit(
            f"Gemini rejected the configuration (GEMINI_API_KEY / GEMINI_MODEL_NAME / "
            f"GEMINI_EMBEDDING_MODEL_NAME): {e}"
        ) from e


def setup_logging() -> None:
    """google-genai logs a line per call, and warns once that LangChain calls
    generate_content directly (with no tools, so the warning doesn't apply): only its
    errors are shown."""
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("google_genai").setLevel(logging.ERROR)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--once", action="store_true", help="work through the queue once and exit"
    )
    args = parser.parse_args()
    setup_logging()

    init_db(engine)
    check_gemini()
    log.info(
        "using %s and %s",
        settings.GEMINI_MODEL_NAME,
        settings.GEMINI_EMBEDDING_MODEL_NAME,
    )

    while True:
        try:
            run_once()
        except Exception as e:
            if not temporary(e):
                raise
            log.warning(
                "OCR or Gemini unavailable (%s); retrying in %ds",
                e,
                settings.POLL_SECONDS,
            )
        if args.once:
            break
        time.sleep(settings.POLL_SECONDS)


if __name__ == "__main__":
    main()
