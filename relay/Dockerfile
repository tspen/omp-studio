# Stateless self-hosted relay. Build from the repository root after the PWA build:
#   npm run build:mobile
#   docker build -f relay/Dockerfile -t omp-relay .
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    RELAY_HOST=0.0.0.0 \
    RELAY_PORT=43150

COPY relay/server.mjs relay/server.mjs
COPY out/mobile out/mobile
RUN npm install ws@8.18.0 --omit=dev --no-audit --no-fund

EXPOSE 43150
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:43150/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "relay/server.mjs"]
