FROM mcr.microsoft.com/devcontainers/base:ubuntu-24.04

ARG DEBIAN_FRONTEND=noninteractive
ARG NODE_VERSION=24

ENV NVM_DIR=/usr/local/nvm
ENV PATH=/usr/local/nvm/current/bin:${PATH}

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Match the repository's current Node.js baseline and keep the toolchain
# needed for npm installs available inside the dev container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        g++ \
        make \
        python-is-python3 \
        python3 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p "${NVM_DIR}" \
    && export PROFILE=/dev/null \
    && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash \
    && source "${NVM_DIR}/nvm.sh" \
    && nvm install "${NODE_VERSION}" \
    && nvm use "v${NODE_VERSION}" \
    && nvm alias default "v${NODE_VERSION}" \
    && rm -f "${NVM_DIR}/current" \
    && ln -s "$(dirname "$(dirname "$(command -v node)")")" "${NVM_DIR}/current"
