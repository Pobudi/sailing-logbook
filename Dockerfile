# ── Build stage ───────────────────────────────────────────────────
FROM python:3.12-slim AS builder

WORKDIR /app

# Install dependencies into a separate prefix so we can copy them cleanly
COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Runtime stage ─────────────────────────────────────────────────
FROM python:3.12-slim

# Non-root user for security
RUN useradd --create-home --shell /bin/bash sailor
WORKDIR /app

# Copy installed packages from builder
COPY --from=builder /install /usr/local

# Copy application code
COPY --chown=sailor:sailor app.py .
COPY --chown=sailor:sailor templates/ templates/
COPY --chown=sailor:sailor static/    static/

# Persistent data lives in a volume — create mount points owned by the app user
RUN mkdir -p /app/data /app/uploads \
    && chown sailor:sailor /app/data /app/uploads

USER sailor

# Uvicorn listens on all interfaces so Docker can forward the port
EXPOSE 8000

# data/ and uploads/ should be mounted as volumes in production
VOLUME ["/app/data", "/app/uploads"]

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
