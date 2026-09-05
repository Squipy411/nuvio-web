FROM node:24-trixie-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app/companion
COPY companion/package.json companion/package-lock.json ./

FROM base AS test
RUN npm ci
COPY companion/src ./src
COPY companion/tests ./tests
COPY companion/tsconfig.json ./
COPY src/lib/companionPolicy.ts /app/src/lib/companionPolicy.ts
COPY deployment/defaults.json /app/deployment/defaults.json
COPY scripts/media-fixtures.mjs /app/scripts/media-fixtures.mjs
RUN npm run check && NUVIO_MEDIA_TEST=1 npm test

FROM base AS runtime
RUN npm ci --omit=dev && npm cache clean --force
COPY --chown=node:node companion/src ./src
COPY --chown=node:node src/lib/companionPolicy.ts /app/src/lib/companionPolicy.ts
COPY --chown=node:node deployment/defaults.json /app/deployment/defaults.json
ENV NODE_ENV=production PORT=3101
USER node
EXPOSE 3101
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3101/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.ts"]
