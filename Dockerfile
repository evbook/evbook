# The VPS build: the same app the Cloudflare Worker serves, assembled by
# src/platform/node onto one Bun process and one SQLite file.
#
# Debian rather than Alpine: the build installs native packages (tailwind's
# oxide, workerd) that ship glibc binaries.

FROM oven/bun:1.4.4-slim AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build:app && bun run build:server

FROM oven/bun:1.4.4-slim
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
# uid/gid 1000, as the `node` user of the earlier node:24-slim image was, so a
# /data volume created by an older release stays writable.
RUN mkdir -p /data && chown bun:bun /data
USER bun
VOLUME /data
EXPOSE 3000
# Migrations run at boot; SIGTERM drains in-flight actor work before exit.
CMD ["bun", "dist/server/main.js"]
