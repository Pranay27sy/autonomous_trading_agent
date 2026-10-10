# --- build the web frontend -----------------------------------------------------
FROM node:22-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# --- API + built frontend ---------------------------------------------------------
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PROMOTER_DB=/data/promoter.db \
    PROMOTER_FRONTEND_DIST=/app/web

RUN useradd --create-home --uid 10001 app \
    && mkdir /data && chown app /data

WORKDIR /app
COPY pyproject.toml README.md ./
COPY promoter_tracker ./promoter_tracker
RUN pip install .
COPY --from=web /web/dist ./web

USER app
VOLUME /data
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/api/health', timeout=4)"

CMD ["uvicorn", "promoter_tracker.api:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
