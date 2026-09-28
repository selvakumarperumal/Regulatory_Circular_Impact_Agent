"""Worker: python main.py [--once]

Reads tasks from the Redis stream as one consumer of the group "workers" (XREADGROUP),
so each task goes to exactly one worker, however many run (WORKERS=3). There's no
polling: a worker blocks until a task arrives. The task types are in common/queue.py,
and what each does is in pipeline.py.

- A finished task is acknowledged (XACK).
- OCR or Gemini down or rate-limited: the task stays unacknowledged; the worker waits
  RETRY_SECONDS and tries it again.
- A hiccup (a timeout, a 5xx, an answer in the wrong shape): the task is retried up to
  MAX_TRIES times, then treated as below.
- Anything else: the circular or the assessment is marked failed with the error, and
  the task is copied to the dead-letter stream rci:dead.
- A task left unfinished by a worker that died is taken over by another after
  CLAIM_IDLE_SECONDS (XAUTOCLAIM).
- Every RECONCILE_MINUTES (and at startup, unless another worker just did it), one
  worker queues any work Postgres shows as unfinished, in case its task went missing
  (Redis lost it, or was down)."""

import argparse
import logging
import os
import socket
import time
from collections import Counter

import redis
from sqlmodel import Session, select

import llm
import locks
import pipeline
from common import queue
from common.db import init_db, make_engine
from common.models import Assessment, Circular
from config import settings
from failures import MAX_TRIES, gemini_status, service_crashed, service_down

log = logging.getLogger("worker")
engine = make_engine(settings.DATABASE_URL)
tries: Counter[str] = Counter()
BLOCK_MS = 5000


def join_group(r: redis.Redis) -> None:
    """Create the consumer group (and the stream) unless they exist. It starts from
    the beginning of the stream, so tasks queued before any worker ran are kept."""
    try:
        r.xgroup_create(queue.STREAM, queue.GROUP, id="0", mkstream=True)
    except redis.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def next_task(r: redis.Redis, me: str) -> tuple[str, dict[str, str]] | None:
    """The next task for this worker: first its own unfinished ones (a retry), then
    one abandoned by a worker that died, then a new one, waiting up to 5 seconds."""
    for _, entries in r.xreadgroup(queue.GROUP, me, {queue.STREAM: "0"}, count=1):
        for task_id, fields in entries:
            if fields:
                return task_id, fields
            r.xack(queue.STREAM, queue.GROUP, task_id)
    claimed = r.xautoclaim(
        queue.STREAM,
        queue.GROUP,
        me,
        min_idle_time=settings.CLAIM_IDLE_SECONDS * 1000,
        count=1,
    )[1]
    for task_id, fields in claimed:
        if fields:
            log.info("took over task %s from a worker that stopped", task_id)
            return task_id, fields
        r.xack(queue.STREAM, queue.GROUP, task_id)
    new = r.xreadgroup(queue.GROUP, me, {queue.STREAM: ">"}, count=1, block=BLOCK_MS)
    for _, entries in new or []:
        for task_id, fields in entries:
            return task_id, fields
    return None


def handle(session: Session, r: redis.Redis, task: dict[str, str]) -> None:
    """Do one task. The work itself is locked, so a task queued twice (a retry, the
    reconciler) is done once: a second worker sees the lock and lets it go. A policy
    or a company can change again while its task runs, so those tasks wait for the
    lock instead, and then pick up the latest change."""
    kind = task["type"]
    ids = {name: int(value) for name, value in task.items() if name != "type"}
    if kind == "circular.read":
        circular_id = ids["circular_id"]
        with locks.held(engine, locks.CIRCULAR, circular_id) as mine:
            companies = pipeline.read_circular(session, circular_id) if mine else []
        for company_id in companies:
            queue.enqueue(
                r, "circular.assess", company_id=company_id, circular_id=circular_id
            )
    elif kind == "circular.assess":
        pair = f"{ids['company_id']}/{ids['circular_id']}"
        with locks.held(engine, locks.ASSESS, pair) as mine:
            if mine:
                pipeline.assess(session, ids["company_id"], ids["circular_id"])
    elif kind == "policy.check":
        with locks.held(engine, locks.POLICY, ids["policy_id"], wait=True):
            pipeline.check_new_policy(session, ids["company_id"], ids["policy_id"])
    elif kind == "company.refresh":
        company_id = ids["company_id"]
        with locks.held(engine, locks.COMPANY, company_id, wait=True):
            circulars = pipeline.refresh_company(session, company_id)
        for circular_id in circulars:
            queue.enqueue(
                r, "circular.assess", company_id=company_id, circular_id=circular_id
            )
    else:
        log.warning("unknown task %s: dropped", task)


def give_up(
    session: Session, r: redis.Redis, task_id: str, task: dict[str, str], e: Exception
) -> None:
    """Mark the work failed, so it shows in the console with the error, and keep the
    task in the dead-letter stream."""
    error = f"{type(e).__name__}: {e}"
    if task["type"] == "circular.read":
        c = session.get(Circular, int(task["circular_id"]))
        if c:
            c.status, c.error = "failed", error
    elif task["type"] == "circular.assess":
        a = session.exec(
            select(Assessment).where(
                Assessment.company_id == int(task["company_id"]),
                Assessment.circular_id == int(task["circular_id"]),
            )
        ).first()
        if a:
            a.status, a.error = "failed", error
    session.commit()
    r.xadd(queue.DEAD, {**task, "task_id": task_id, "error": error[:2000]})


def run_task(r: redis.Redis, task_id: str, task: dict[str, str]) -> None:
    """Do the task, and acknowledge it unless it's to be retried."""
    with Session(engine) as session:
        try:
            handle(session, r, task)
        except Exception as e:
            session.rollback()
            if service_down(e):
                log.warning(
                    "OCR or Gemini unavailable (%s); retrying %s in %ds",
                    e,
                    task["type"],
                    settings.RETRY_SECONDS,
                )
                time.sleep(settings.RETRY_SECONDS)
                return
            tries[task_id] += 1
            if service_crashed(e) and tries[task_id] < MAX_TRIES:
                log.warning("%s failed (%s); trying again", task, e)
                return
            log.exception("%s failed for good", task)
            give_up(session, r, task_id, task, e)
    r.xack(queue.STREAM, queue.GROUP, task_id)
    tries.pop(task_id, None)


def reconcile(r: redis.Redis, me: str) -> None:
    """Queue every piece of unfinished work Postgres shows, in case its task went
    missing. Once per RECONCILE_MINUTES across all workers: the first to set the key
    does it, and the key expires when the next one is due."""
    period = settings.RECONCILE_MINUTES * 60
    if not r.set(queue.RECONCILED, me, nx=True, ex=period):
        return
    with Session(engine) as session:
        tasks = pipeline.missing_work(session)
    for kind, ids in tasks:
        queue.enqueue(r, kind, **ids)
    if tasks:
        log.info("reconciler: queued %d tasks for unfinished work", len(tasks))
    forget_stopped_workers(r)


def forget_stopped_workers(r: redis.Redis) -> None:
    """Every container restart joins the group under a new name. Drop the names that
    hold no task and haven't read anything for a day: workers long gone."""
    for consumer in r.xinfo_consumers(queue.STREAM, queue.GROUP):
        if consumer["pending"] == 0 and consumer["idle"] > 86_400_000:
            r.xgroup_delconsumer(queue.STREAM, queue.GROUP, consumer["name"])


def check_gemini() -> None:
    """A 4xx at startup means a wrong key or model name, so nothing would work: stop
    with a clear message. A 429, a 5xx or no network is not a configuration problem:
    start anyway, and let each task wait for Gemini as usual."""
    try:
        llm.check()
    except Exception as e:
        status = gemini_status(e)
        if status is None or status == 429 or status >= 500:
            log.warning("Gemini unavailable at startup (%s); starting anyway", e)
            return
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
        "--once", action="store_true", help="work until the queue is empty, then exit"
    )
    args = parser.parse_args()
    setup_logging()

    init_db(engine)
    check_gemini()
    r = queue.connect(settings.REDIS_URL)
    me = f"{socket.gethostname()}-{os.getpid()}"
    log.info(
        "worker %s: using %s and %s, waiting for tasks",
        me,
        settings.GEMINI_MODEL_NAME,
        settings.GEMINI_EMBEDDING_MODEL_NAME,
    )

    next_reconcile = 0.0
    while True:
        try:
            join_group(r)
            if time.monotonic() >= next_reconcile:
                reconcile(r, me)
                next_reconcile = time.monotonic() + 60
            task = next_task(r, me)
            if task:
                run_task(r, *task)
            elif args.once:
                break
        except (redis.ConnectionError, redis.TimeoutError) as e:
            log.warning(
                "Redis unavailable (%s); retrying in %ds", e, settings.RETRY_SECONDS
            )
            time.sleep(settings.RETRY_SECONDS)


if __name__ == "__main__":
    main()
