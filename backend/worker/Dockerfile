# syntax=docker/dockerfile:1

FROM python:3.14-slim AS builder
COPY --from=ghcr.io/astral-sh/uv:0.9 /uv /bin/uv
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never

WORKDIR /app/worker
COPY common/ /app/common/
COPY worker/pyproject.toml worker/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --no-editable

FROM python:3.14-slim
ENV PYTHONUNBUFFERED=1 PATH="/app/worker/.venv/bin:$PATH"
RUN useradd --system --home-dir /app --no-create-home app

WORKDIR /app/worker
COPY --from=builder /app/worker/.venv .venv
COPY worker/ .

USER app
CMD ["python", "main.py"]
