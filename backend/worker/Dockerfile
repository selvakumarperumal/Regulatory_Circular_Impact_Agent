# syntax=docker/dockerfile:1
# Worker image. Build context is backend/ (not this folder) so the shared
# common/ package can be installed into the virtualenv.

# ── Stage 1: dependencies, into /app/worker/.venv ───────────────────────────
FROM python:3.14-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app/worker
COPY common/ /app/common/
COPY worker/pyproject.toml worker/uv.lock ./
# --frozen: fail if uv.lock is out of date; --no-editable: copy common/ into the venv
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --no-editable

# ── Stage 2: runtime ─────────────────────────────────────────────────────────
FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 PATH="/app/worker/.venv/bin:$PATH"
RUN useradd --system --home-dir /app --no-create-home app

WORKDIR /app/worker
COPY --from=builder /app/worker/.venv .venv
COPY worker/ .

USER app
CMD ["python", "main.py"]
