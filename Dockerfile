# Alpine-basiertes Image für CarTankLogger
FROM python:3.12-alpine

WORKDIR /app

# Build-Tools für evtl. native Abhängigkeiten (psycopg2 nicht nötig, hier nur std)
RUN apk add --no-cache \
    gcc musl-dev libffi-dev

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# WICHTIG: keinen Bytecode-Cache schreiben -> verhindert stale .pyc.
# Ohne das wird beim Build ein alter app.cpython-*.pyc mitkopiert, der
# die neue app.py ueberschattet und ALTE Logik laedt (selbst wenn das
# Image neu gebaut wurde).
ENV PYTHONDONTWRITEBYTECODE=1
RUN find /app -name "*.pyc" -delete 2>/dev/null || true

# Rechte vorbereiten (Entrypoint korrigiert Bind-Mount-Rechte zur Laufzeit)
RUN mkdir -p /app/data && chmod +x /app/entrypoint.sh

ENV CONFIG_PATH=/app/config.yaml
ENV DB_PATH=/app/data/cartanklogger.db
ENV MOCK_MODE=false
EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
