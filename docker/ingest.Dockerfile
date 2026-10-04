# MQTT ingest worker: one bundled file plus the SQL migrations (~60 MB RSS).

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY lib ./lib
COPY ingest ./ingest
COPY db ./db
RUN npm run build:ingest

FROM node:24-alpine
LABEL org.opencontainers.image.source=https://github.com/AniruddhaGhodke/battery_iot
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/dist/ingest.mjs ./ingest.mjs
COPY db/migrations ./db/migrations
USER node
EXPOSE 3101
# --no-deprecation: silences a url.parse() warning from inside the mqtt library.
CMD ["node", "--max-old-space-size=96", "--no-deprecation", "ingest.mjs"]
