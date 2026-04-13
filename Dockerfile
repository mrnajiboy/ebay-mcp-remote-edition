# ──────────────────────────────────────────────────────────────
# Base image
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

# ──────────────────────────────────────────────────────────────
# Dependency stage
# ──────────────────────────────────────────────────────────────
FROM base AS deps

WORKDIR /app

COPY package.json pnpm-lock.yaml .npmrc ./

RUN pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────
# Build stage
# ──────────────────────────────────────────────────────────────
FROM base AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN pnpm run build

# ──────────────────────────────────────────────────────────────
# Production stage
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN corepack enable

COPY package.json pnpm-lock.yaml .npmrc ./

RUN pnpm install --prod --frozen-lockfile

# Install Chromium required by the Playwright runtime used by the hosted server.
RUN npx -y playwright@1.59.1 install --with-deps chromium

# Copy runtime assets.
COPY --from=builder /app/build ./build
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["pnpm", "run", "start:http"]
