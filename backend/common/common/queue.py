"""The task queue: two Redis streams, the workers' only source of work. Every change
that needs a worker queues its task (XADD): the watcher for a new circular, the api for
a company description added or changed, a policy added or saved, or a Reprocess, the
worker for the next steps. A sign-up queues nothing: there's nothing to judge yet. A task
only carries ids: Postgres holds the data.

Each task type has a lane, a stream of its own. Reading a PDF takes minutes on the GPU,
so circular.read has the "pdf" lane (rci:tasks:pdf) and everything else, a few Gemini
calls each, has the "main" lane (rci:tasks): a quick task never waits behind a PDF.
Workers read each lane as the consumer group "workers" (XREADGROUP), so each task goes
to one worker.

A task is queued at most once at a time: enqueue sets a key per task (SET NX) and the
worker deletes it when the task is done, so the same work is never queued twice.

circular.read    circular_id              read the PDF once, for every company     pdf
circular.assess  company_id, circular_id  does it apply to the company? check its  main
                                          policies
policy.check     company_id, policy_id    embed a saved policy, check it against   main
                                          circulars
company.refresh  company_id               its description changed: judge its       main
                                          circulars again
"""

from contextlib import suppress

import redis

LANES = {"pdf": "rci:tasks:pdf", "main": "rci:tasks"}
GROUP, DEAD = "workers", "rci:dead"


def lane(kind: str) -> str:
    """The lane a task type goes to: only reading a PDF is slow."""
    return "pdf" if kind == "circular.read" else "main"


def connect(url: str) -> redis.Redis:
    """socket_timeout outlasts the workers' 5-second blocking read."""
    return redis.Redis.from_url(url, decode_responses=True, socket_timeout=30)


def key(task: dict) -> str:
    """The dedupe key of a task, e.g. rci:queued:circular_id=98:type=circular.read.
    It expires after a day, in case a worker dies before deleting it."""
    return "rci:queued:" + ":".join(f"{k}={v}" for k, v in sorted(task.items()))


def enqueue(client: redis.Redis, kind: str, **ids: int) -> bool:
    """Add a task to its lane, unless the same task is already queued or running; True
    if it was added. Called after the change it's about is committed. If Redis can't
    take it, the error is raised (and the key removed), so the caller undoes its change
    or fails: no task is ever lost quietly."""
    task = {"type": kind, **ids}
    try:
        if not client.set(key(task), 1, nx=True, ex=86_400):
            return False
        client.xadd(LANES[lane(kind)], task, maxlen=100_000, approximate=True)
        return True
    except redis.RedisError:
        with suppress(redis.RedisError):
            client.delete(key(task))
        raise
