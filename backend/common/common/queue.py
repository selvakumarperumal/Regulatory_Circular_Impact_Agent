"""The task queue: one Redis stream, the workers' only source of work. Every change
that needs a worker queues its task here (XADD): the watcher for a new circular, the api
for a company description added or changed, a policy added or saved, or a Reprocess, the
worker for the next steps. A sign-up queues nothing: there's nothing to judge yet. Workers read it as the consumer group "workers" (XREADGROUP), so each task goes
to one worker. A task only carries ids: Postgres holds the data.

A task is queued at most once at a time: enqueue sets a key per task (SET NX) and the
worker deletes it when the task is done, so the same work is never queued twice.

circular.read    circular_id              read the PDF once, for every company
circular.assess  company_id, circular_id  does it apply to the company? check its policies
policy.check     company_id, policy_id    embed a saved policy, check it against circulars
company.refresh  company_id               its description changed: judge its circulars again
"""

from contextlib import suppress

import redis

STREAM, GROUP, DEAD = "rci:tasks", "workers", "rci:dead"


def connect(url: str) -> redis.Redis:
    """socket_timeout outlasts the workers' 5-second blocking read."""
    return redis.Redis.from_url(url, decode_responses=True, socket_timeout=30)


def key(task: dict) -> str:
    """The dedupe key of a task, e.g. rci:queued:circular_id=98:type=circular.read.
    It expires after a day, in case a worker dies before deleting it."""
    return "rci:queued:" + ":".join(f"{k}={v}" for k, v in sorted(task.items()))


def enqueue(client: redis.Redis, kind: str, **ids: int) -> bool:
    """Add a task, unless the same task is already queued or running; True if it was
    added. Called after the change it's about is committed. If Redis can't take it,
    the error is raised (and the key removed), so the caller undoes its change or
    fails: no task is ever lost quietly."""
    task = {"type": kind, **ids}
    try:
        if not client.set(key(task), 1, nx=True, ex=86_400):
            return False
        client.xadd(STREAM, task, maxlen=100_000, approximate=True)
        return True
    except redis.RedisError:
        with suppress(redis.RedisError):
            client.delete(key(task))
        raise
