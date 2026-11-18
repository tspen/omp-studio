# Headless Perch runner: the same app, served from a user-owned host.
# Build from the repository root:  docker build -f runner/Dockerfile -t perch-runner .
FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive \
    ELECTRON_DISABLE_SECURITY_WARNINGS=1 \
    PERCH_USER_DATA=/data \
    PERCH_HEADLESS=1 \
    PERCH_REMOTE_HOST=0.0.0.0 \
    PERCH_REMOTE_PORT=43120

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git xvfb xauth \
      libnss3 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libxtst6 libdrm2 \
      fonts-dejavu-core python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first so source edits do not invalidate the install layer.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && node node_modules/electron/install.js \
 && (npm rebuild node-pty --no-audit --no-fund || echo "node-pty unavailable; terminals disabled")

COPY . .
RUN npm run build \
 && chmod +x runner/entrypoint.sh

EXPOSE 43120
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD curl -fsS http://127.0.0.1:43120/ >/dev/null || exit 1

# Xvfb keeps Electron's window server available without a desktop.
CMD ["/app/runner/entrypoint.sh"]



