# Multi-stage production build for ImageHost MCP
FROM node:22-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy manifest and lockfiles
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/

# Install build dependencies
RUN pnpm install --frozen-lockfile

# Copy sources and configurations
COPY tsconfig.json drizzle.config.ts ./
COPY src ./src
COPY docs ./docs
COPY web ./web

# Compile TypeScript backend and React PWA
RUN pnpm build && pnpm build:web

# Runtime stage
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@latest --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install production dependencies only
RUN pnpm install --prod --frozen-lockfile

# Copy compiled backend, PWA bundle, and docs
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/docs ./docs

# Copy SQL migrations (read by dist/db/migrate.js)
COPY --from=builder /app/src/db/migrations ./dist/db/migrations
COPY --from=builder /app/src/db/migrations ./src/db/migrations

# Copy entrypoint script
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
