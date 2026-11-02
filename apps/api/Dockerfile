FROM python:3.12-slim

# Pango and HarfBuzz are what WeasyPrint uses to shape Arabic in the invoice PDF (SPEC section 11).
# tzdata is the time-zone rules: Palestine announces its daylight-saving dates each year, so the
# image must be rebuilt (docs/DEPLOY.md, "Updates") to carry the latest ones.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 tzdata \
 && rm -rf /var/lib/apt/lists/*

# The font and the shared stylesheet are mounted by docker-compose from the repo, so the PDF and the
# app use the very same files.
ENV FONTS_DIR=/app/fonts SHARED_DIR=/app/shared

# An unprivileged user for production (docker-compose.prod.yml runs the container as 10001). The
# media folder is made here, owned by that user, so a fresh volume mounted on it is writable.
RUN useradd --create-home --uid 10001 app \
 && mkdir -p /data/media \
 && chown app:app /data/media

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY alembic.ini .
COPY alembic ./alembic
COPY app ./app
COPY scripts ./scripts

# One worker: the login rate limiter lives in memory. Caddy is the only client, so its
# X-Forwarded-For can be trusted.
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --proxy-headers --forwarded-allow-ips='*'"]
