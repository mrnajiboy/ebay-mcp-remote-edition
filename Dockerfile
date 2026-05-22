# ──────────────────────────────────────────────────────────────
# Base image
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

# ──────────────────────────────────────────────────────────────
# Playwright browser stage — uses pre-built image to avoid
# 20+ min Chromium download on every uncached build.
# Chromium + all system deps already included.
# ──────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/playwright:v1.59.1-noble AS playwright

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Pre-installed image has Chromium at /ms-playwright/chromium-*/chrome-linux/
# System deps, fonts, and libraries are already present.

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

RUN corepack enable && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl && \
    rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml .npmrc ./

RUN pnpm install --prod --frozen-lockfile

# Copy pre-built Chromium + system deps from playwright stage
COPY --from=playwright /ms-playwright /ms-playwright
COPY --from=playwright /usr/lib /usr/lib
COPY --from=playwright /usr/share/fonts /usr/share/fonts
COPY --from=playwright /etc/fonts /etc/fonts

# Copy runtime assets.
COPY --from=builder /app/build ./build
COPY --from=builder /app/docs ./docs
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["pnpm", "run", "start:http"]
