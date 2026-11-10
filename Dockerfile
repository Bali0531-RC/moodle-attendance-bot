FROM node:22-bookworm-slim

# Install Chromium dependencies + zbar-tools + Hungarian/UTF-8 fonts
RUN apt-get update && apt-get install -y --no-install-recommends \
    zbar-tools \
    ca-certificates \
    tzdata \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV TZ=Europe/Budapest
ENV HEADLESS=true
ENV NODE_ENV=production

WORKDIR /app

# Enable pnpm and install dependencies
RUN corepack enable
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile || pnpm install

# Install Playwright Chromium with OS dependencies
RUN pnpm exec playwright install --with-deps chromium

# Copy bot source files
COPY . .

CMD ["node", "index.js"]
