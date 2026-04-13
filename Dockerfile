# ──────────────────────────────────────────────────────────────
# Build stage
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim AS builder

WORKDIR /app

# Install pnpm
RUN npm install -g pnpm

# Copy source
COPY . .

# Install all dependencies (dev included) and build
RUN pnpm install --frozen-lockfile
RUN pnpm run build

# ──────────────────────────────────────────────────────────────
# Production stage
# ──────────────────────────────────────────────────────────────
FROM node:24-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Install pnpm
RUN npm install -g pnpm

# Copy package manifest (no prepare script needed here)
COPY package.json pnpm-lock.yaml* ./

# Install only production dependencies
RUN pnpm install --prod --frozen-lockfile

# Install system libraries + Chromium required by the repo-pinned Playwright runtime
RUN npx -y playwright@1.59.1 install --with-deps chromium

# Copy compiled output from builder
COPY --from=builder /app/build ./build

# Copy docs directory (needed for scope resolution)
COPY --from=builder /app/docs ./docs

# Expose default HTTP port
EXPOSE 3000

# Default command — stdio mode (override with "node build/server-http.js" for HTTP mode)
CMD ["node", "build/index.js"]
