# Frontend Dockerfile for CarTankLogger 2.0 (React + Vite)
FROM node:20-alpine

WORKDIR /app

# Install dependencies first (cached layer)
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build for production -> /app/dist
RUN npm run build

# Sanity-Check: dist MUSS im finalen Image existieren
RUN test -f dist/index.html || (echo "FEHLER: dist/index.html fehlt nach Build" && exit 1)

EXPOSE 5173

# SPA-Server mit /app/dist-Root + API-Proxy
CMD ["node", "serve-static.mjs"]
