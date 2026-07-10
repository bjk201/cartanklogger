# Alpine-basiertes Image für CarTankLogger
FROM python:3.12-alpine

WORKDIR /app

# Build-Tools für evtl. native Abhängigkeiten (psycopg2 nicht nötig, hier nur std)
RUN apk add --no-cache \
    gcc musl-dev libffi-dev

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY . /app

# Rechte vorbereiten (Entrypoint korrigiert Bind-Mount-Rechte zur Laufzeit)
RUN mkdir -p /app/data && chmod +x /app/entrypoint.sh

ENV CONFIG_PATH=/app/config.yaml
ENV DB_PATH=/app/data/cartanklogger.db
ENV MOCK_MODE=false
EXPOSE 5000

ENTRYPOINT ["/app/entrypoint.sh"]
