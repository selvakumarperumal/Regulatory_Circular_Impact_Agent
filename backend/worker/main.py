"""Worker: python main.py [--once]

Takes tasks off the Redis streams of the lanes in LANES ("pdf" for reading PDFs, "main"
for the rest), as one consumer of each lane's group "workers" (XREADGROUP), so each task
goes to one worker however many run. Each lane has its own loop, in its own thread,
taking one task at a time: a PDF being read never holds up a quick task. When a task is
done its dedupe key is deleted (so it can be queued again), its follow-up tasks are
queued, and it's acknowledged (XACK). While it runs, the worker claims it again every
minute, so however long the OCR takes no other worker takes it over.

The streams are the worker's only source of work: it never looks in Postgres for things
to do. A failing task waits while OCR or Gemini is down, is retried after a hiccup (up
to MAX_TRIES), and is otherwise given up: marked failed and copied to rci:dead. A dead
worker's task is taken over after CLAIM_IDLE_SECONDS."""

import argparse
import logging
import os
import socket
import threading
import time
from collections import Counter
from collections.abc import Iterator
from contextlib import contextmanager, suppress

import redis
from sqlalchemy import update
from sqlmodel import Session

import llm
import pipeline
from common import queue
from common.db import init_db, make_engine
from common.models import Assessment, Circular
from config import settings
from failures import MAX_TRIES, gemini_status, should_retry, should_wait

log = logging.getLogger("worker")
engine = make_engine(settings.DATABASE_URL)
tries: Counter[tuple[str, str]] = Counter()
HEARTBEAT_SECONDS = 60

TASKS = {
    "circular.read": pipeline.read_circular,
    "circular.assess": pipeline.assess,
    "policy.check": pipeline.check_policy,
    "company.refresh": pipeline.refresh_company,
}


def next_task(
    r: redis.Redis, me: str, stream: str
) -> tuple[str, dict[str, str]] | None:
    """This worker's own unacknowledged task first (a retry), then one a dead worker
    left, then a new one, waiting up to 5 seconds."""
    idle_ms = settings.CLAIM_IDLE_SECONDS * 1000
    for read in (
        lambda: r.xreadgroup(queue.GROUP, me, {stream: "0"}, count=1),
        lambda: [(stream, r.xautoclaim(stream, queue.GROUP, me, idle_ms, count=1)[1])],
        lambda: r.xreadgroup(queue.GROUP, me, {stream: ">"}, count=1, block=5000),
    ):
        for _, entries in read() or []:
            for task_id, task in entries:
                if task:
                    return task_id, task
                r.xack(stream, queue.GROUP, task_id)
    return None


@contextmanager
def keep_claimed(r: redis.Redis, me: str, stream: str, task_id: str) -> Iterator[None]:
    """Claim the task again every HEARTBEAT_SECONDS (XCLAIM resets its idle time), so
    only a dead worker's task is ever idle long enough to be taken over."""
    stop = threading.Event()

    def beat() -> None:
        while not stop.wait(HEARTBEAT_SECONDS):
            with suppress(redis.RedisError):
                r.xclaim(stream, queue.GROUP, me, 0, [task_id], justid=True)

    threading.Thread(target=beat, daemon=True).start()
    try:
        yield
    finally:
        stop.set()


def run_task(
    r: redis.Redis, me: str, stream: str, task_id: str, task: dict[str, str]
) -> None:
    """Do the task; then, unless it's to be retried, finish it. If Redis fails while
    the next tasks are queued, the task isn't acknowledged, so it runs again and
    none is lost."""
    ids = {name: int(value) for name, value in task.items() if name != "type"}
    follow_ups: pipeline.Tasks = []
    with Session(engine) as session, keep_claimed(r, me, stream, task_id):
        try:
            follow_ups = TASKS[task["type"]](session, **ids)
        except Exception as e:
            session.rollback()
            if should_wait(e):
                log.warning("OCR or Gemini unavailable (%s); retrying", e)
                time.sleep(settings.RETRY_SECONDS)
                return
            tries[stream, task_id] += 1
            if should_retry(e) and tries[stream, task_id] < MAX_TRIES:
                log.warning("%s failed (%s); trying again", task, e)
                return
            log.exception("%s failed for good", task)
            give_up(session, r, stream, task_id, task, e)
    tries.pop((stream, task_id), None)
    r.delete(queue.key(task))
    for kind, next_ids in follow_ups:
        queue.enqueue(r, kind, **next_ids)
    r.xack(stream, queue.GROUP, task_id)


def give_up(
    session: Session,
    r: redis.Redis,
    stream: str,
    task_id: str,
    task: dict,
    e: Exception,
) -> None:
    """Show the error on the circular or the assessment, and keep the task in the
    dead-letter stream."""
    error = f"{type(e).__name__}: {e}"
    failed = {"status": "failed", "error": error}
    if task["type"] == "circular.read":
        where = [Circular.id == int(task["circular_id"])]
        session.execute(update(Circular).where(*where).values(failed))
    if task["type"] == "circular.assess":
        where = [
            Assessment.company_id == int(task["company_id"]),
            Assessment.circular_id == int(task["circular_id"]),
        ]
        session.execute(update(Assessment).where(*where).values(failed))
    session.commit()
    dead = {**task, "stream": stream, "task_id": task_id, "error": error[:2000]}
    r.xadd(queue.DEAD, dead)


def serve(r: redis.Redis, me: str, lane: str, once: bool = False) -> int:
    """Take one lane's tasks, one at a time, for good; with once, until the lane is
    empty, returning how many were taken."""
    stream, taken = queue.LANES[lane], 0
    while True:
        try:
            with suppress(redis.ResponseError):
                r.xgroup_create(stream, queue.GROUP, id="0", mkstream=True)
            task = next_task(r, me, stream)
            if task:
                taken += 1
                run_task(r, me, stream, *task)
            elif once:
                return taken
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning("Redis unavailable (%s); retrying", e)
            time.sleep(settings.RETRY_SECONDS)
        except redis.ResponseError as e:
            if "NOGROUP" not in str(e):
                raise
            log.warning("Redis lost %s (%s); making it again", stream, e)


def lanes() -> list[str]:
    """LANES, checked: a typo would leave a lane with no worker."""
    names = [name.strip() for name in settings.LANES.split(",") if name.strip()]
    if not names or set(names) - set(queue.LANES):
        raise SystemExit(f"LANES must name some of {', '.join(queue.LANES)}")
    return list(dict.fromkeys(names))


def check_gemini() -> None:
    """A 4xx at startup means a wrong key or model name: stop with a clear message.
    A 429, a 5xx or no network only warns: tasks wait for Gemini themselves."""
    try:
        llm.check()
    except Exception as e:
        status = gemini_status(e) or 0
        if 400 <= status < 500 and status != 429:
            raise SystemExit(f"Gemini rejected the key or model name: {e}") from e
        log.warning("Gemini unavailable at startup (%s); starting anyway", e)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="stop when queue is empty")
    once = parser.parse_args().once
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s"
    )
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("google_genai").setLevel(logging.ERROR)

    names = lanes()
    init_db(engine)
    check_gemini()
    r = queue.connect(settings.REDIS_URL)
    me = f"{socket.gethostname()}-{os.getpid()}"
    log.info(
        "worker %s: lanes %s, using %s, waiting for tasks",
        me,
        ", ".join(names),
        settings.GEMINI_MODEL_NAME,
    )
    if once:  # each lane in turn, until a round finds nothing (a read queues assesses)
        while sum([serve(r, me, lane, once=True) for lane in names]):
            pass
        return
    loops = [
        threading.Thread(target=serve, args=(r, me, lane), name=lane, daemon=True)
        for lane in names
    ]
    for loop in loops:
        loop.start()
    while all(loop.is_alive() for loop in loops):
        time.sleep(1)
    raise SystemExit("a lane's loop stopped (see the error above): exiting")


if __name__ == "__main__":
    main()
