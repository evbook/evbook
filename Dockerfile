# The VPS build: the same app the Cloudflare Worker serves, assembled by
# src/platform/node onto one Node process and one SQLite file.

FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:app && npm run build:server

FROM node:24-slim
# Links the GHCR package to the repository, so the image page shows the README
# and the package can follow the repo's visibility.
LABEL org.opencontainers.image.source="https://github.com/evbook/evbook"
WORKDIR /app
ENV NODE_ENV=production \
    DATABASE_PATH=/data/evbook.sqlite \
    BLOBS_DIR=/data/blobs \
    ASSETS_DIR=/app/dist/client \
    MIGRATIONS_DIR=/app/migrations \
    PORT=3000
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# Migrations run at boot; SIGTERM drains in-flight actor work before exit.
CMD ["node", "dist/server/main.js"]
