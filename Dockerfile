# ──────────────────────────────────────────────────────────────
# Base image
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN corepack enable

# ──────────────────────────────────────────────────────────────
# Playwright browser stage — cached across builds
# System deps + Chromium binary installed once, reused unless
# the package.json / pnpm-lock.yaml change.
# ──────────────────────────────────────────────────────────────
FROM base AS playwright

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# 1. Install Chromium system dependencies (cached independently)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      libatk-bridge2.0-0 \
      libatk1.0-0 \
      libcups2 \
      libdrm2 \
      libgbm1 \
      libgtk-3-0 \
      libnss3 \
      libxcomposite1 \
      libxdamage1 \
      libxfixes3 \
      libxrandr2 \
      libxshmfence1 \
      libpango-1.0-0 \
      libcairo2 \
      libasound2 \
      libx11-xcb1 \
      fonts-liberation \
      fonts-noto-color-emoji \
      xdg-utils \
      wget \
    && rm -rf /var/lib/apt/lists/*

# 2. Download Chromium binary (cached as long as this layer doesn't change)
RUN npx -y playwright@1.59.1 install chromium

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
