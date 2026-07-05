# {{PROJECT}} Development Container
#
# Scaffolded by the `devcontainer` skill — versions and conventions live there,
# not here. Debian bookworm-slim + Bun, runs as root inside the container.
#
# CACHE ALIGNMENT: everything above the "project-specific" marker must stay
# byte-identical across projects so Docker's layer cache is shared between them.
# Project additions go below the marker only.

FROM debian:bookworm-slim@sha256:f9c6a2fd2ddbc23e336b6257a5245e31f996953ef06cd13a59fa0a1df2d5c252

SHELL ["/bin/bash", "-c"]

# Install system dependencies and Node.js
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    unzip \
    openssh-client \
    gcc \
    libc6-dev \
    make \
    jq \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y gh \
    && rm -rf /var/lib/apt/lists/*

# Install Bun (pinned; the install script takes the version as a positional
# arg — the BUN_VERSION env var is silently ignored)
ENV BUN_INSTALL="/usr/local"
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.9"

WORKDIR /workspace

# Install typescript-language-server (used by mcp-language-server below)
RUN bun add -g typescript-language-server

# Install Claude Code CLI (native binary)
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:${PATH}"

# Install Go (for mcp-language-server)
RUN curl -fsSL https://go.dev/dl/go1.24.13.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xzf -
ENV PATH="/usr/local/go/bin:/root/go/bin:${PATH}"

# Install mcp-language-server for LSP integration with Claude Code
RUN go install github.com/isaacphi/mcp-language-server@latest

# --- project-specific below this line ---

# {{IF_POSTGRES}}
RUN apt-get update && apt-get install -y --no-install-recommends postgresql-client \
    && rm -rf /var/lib/apt/lists/*
RUN bun add -g drizzle-kit
# {{END_IF_POSTGRES}}

# {{IF_DIND}}
# Docker CLI, pointed at the isolated DinD sidecar via DOCKER_HOST (no host socket)
RUN install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
    && rm -rf /var/lib/apt/lists/*
# {{END_IF_DIND}}

# {{IF_PLAYWRIGHT}}
RUN bunx playwright install --with-deps chromium
# {{END_IF_PLAYWRIGHT}}

# Setup shell configuration (last: changes most often, keeps cache above intact)
COPY .devcontainer/shell-config.sh /root/.shell-config.sh
RUN echo 'source /root/.shell-config.sh' >> /root/.bashrc
