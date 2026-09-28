"""The task queue: one Redis stream. The watcher, the api and the worker add tasks to it
(XADD); the workers read it as one consumer group (XREADGROUP), so each task goes to
exactly one worker, however many run.

Postgres stays the source of truth. A task only says what to look at, and every task
checks the database before doing anything, so a task delivered twice is harmless, and
one lost with Redis is found again by the worker's reconciler.

| type             | fields                   | added by                 | the worker…
| circular.read    | circular_id              | watcher, api (Reprocess) | OCRs and summarises it, once for every company
| circular.assess  | company_id, circular_id  | worker, api (Reprocess)  | decides if it applies to the company, checks its policies
| policy.check     | company_id, policy_id    | api (policy saved)       | embeds the policy, checks it against recent circulars
| company.refresh  | company_id               | api (sign-up, new description) | (re)judges the company's recent circulars
"""

import logging

import redis

log = logging.getLogger("queue")

STREAM = "rci:tasks"
GROUP = "workers"
DEAD = "rci:dead"
RECONCILED = "rci:reconciled"
MAXLEN = 100_000


def connect(url: str) -> redis.Redis:
    """socket_timeout must outlast the workers' blocking read (5 s), or an empty
    queue would look like a dead Redis."""
    return redis.Redis.from_url(
        url,
        decode_responses=True,
        socket_timeout=30,
        socket_connect_timeout=5,
        health_check_interval=30,
    )


def enqueue(client: redis.Redis, kind: str, **ids: int) -> str | None:
    """Add a task. Redis being down never fails the caller: the change is already in
    Postgres, and the worker's reconciler queues it again later."""
    fields = {"type": kind, **{name: str(value) for name, value in ids.items()}}
    try:
        return client.xadd(STREAM, fields, maxlen=MAXLEN, approximate=True)
    except redis.RedisError as e:
        log.warning("couldn't queue %s %s: %s", kind, ids, e)
        return None
