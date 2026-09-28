"""The task queue: one Redis stream. The watcher, the api and the workers add tasks
(XADD); workers read them as the consumer group "workers" (XREADGROUP), so each task
goes to one worker. A task only carries ids: Postgres holds the data.

A task is queued at most once at a time: enqueue sets a key per task (SET NX) and the
worker deletes it when the task is done, so the same work is never queued twice.

circular.read    circular_id              read the PDF once, for every company
circular.assess  company_id, circular_id  does it apply to the company? check its policies
policy.check     company_id, policy_id    embed a saved policy, check it against circulars
company.refresh  company_id               queue the company's recent circulars to judge
"""

import logging
from contextlib import suppress

import redis

STREAM, GROUP, DEAD, RECONCILED = "rci:tasks", "workers", "rci:dead", "rci:reconciled"

log = logging.getLogger("queue")


def connect(url: str) -> redis.Redis:
    """socket_timeout outlasts the workers' 5-second blocking read."""
    return redis.Redis.from_url(url, decode_responses=True, socket_timeout=30)


def key(task: dict) -> str:
    """The dedupe key of a task, e.g. rci:queued:circular_id=98:type=circular.read.
    It expires after a day, in case a worker dies before deleting it."""
    return "rci:queued:" + ":".join(f"{k}={v}" for k, v in sorted(task.items()))


def enqueue(client: redis.Redis, kind: str, **ids: int) -> None:
    """Add a task, unless the same task is already queued or running. Called after
    the change it's about is committed; if Redis is down it only logs, and the
    workers' reconciler finds the work in Postgres later."""
    task = {"type": kind, **ids}
    try:
        if client.set(key(task), 1, nx=True, ex=86_400):
            client.xadd(STREAM, task, maxlen=100_000, approximate=True)
    except redis.RedisError as e:
        log.warning("couldn't queue %s: %s", task, e)
        with suppress(redis.RedisError):
            client.delete(key(task))
