# syntax=docker/dockerfile:1

# Debian rather than Alpine: both Prisma's engines and the Kafka client's native librdkafka
# ship prebuilt binaries for glibc, and musl would mean building them from source.
FROM node:22.19.0-bookworm-slim AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Dependencies, and the Prisma client that `postinstall` generates from the schema.
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
RUN npm ci

FROM deps AS build
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=development
# Dev dependencies are kept on purpose: the migration step runs the Prisma CLI from this same
# image, and the helper scripts below are what make the stack explorable.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json prisma.config.ts ./
COPY prisma ./prisma
COPY scripts ./scripts

USER node
EXPOSE 3000
# Nest's shutdown hooks handle SIGTERM, so `docker compose down` drains in-flight work and
# closes the database pool rather than killing the process.
CMD ["node", "dist/main.js"]
