# syntax=docker/dockerfile:1

FROM python:3.14-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app/watcher
COPY common/ /app/common/
COPY watcher/pyproject.toml watcher/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --no-editable

FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 PATH="/app/watcher/.venv/bin:$PATH"
RUN useradd --system --home-dir /app --no-create-home app

WORKDIR /app/watcher
COPY --from=builder /app/watcher/.venv .venv
COPY watcher/ .

USER app
CMD ["python", "main.py"]
