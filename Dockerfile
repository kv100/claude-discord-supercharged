FROM oven/bun:1 AS base
WORKDIR /app

# Install Claude Code CLI globally
RUN apt-get update && apt-get install -y curl ffmpeg && \
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    npm install -g @anthropic-ai/claude-code && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source
COPY src/ src/
COPY supervisor.ts ./

# Health check endpoint (Railway kills containers without it)
EXPOSE 8080

CMD ["bun", "src/bot.ts"]
