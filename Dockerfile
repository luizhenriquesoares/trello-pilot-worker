FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsup.config.ts ./
COPY src/ src/
RUN npm run build

FROM node:20-slim

RUN apt-get update && apt-get install -y \
    git curl openssh-client \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y gh && rm -rf /var/lib/apt/lists/*

# Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json config.json ./

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash pilot
RUN git config --global user.email "trello-pilot@automation" \
    && git config --global user.name "Trello Code Pilot"

# Set ownership and switch to non-root
RUN chown -R pilot:pilot /app /tmp
USER pilot

# Git config for the non-root user
RUN git config --global user.email "trello-pilot@automation" \
    && git config --global user.name "Trello Code Pilot"

EXPOSE 3000
CMD ["node", "dist/index.js"]
