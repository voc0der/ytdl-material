# Fetching our utils
FROM ubuntu:26.04 AS utils
ENV DEBIAN_FRONTEND=noninteractive
# Use script due local build compability
COPY docker-utils/*.sh .
RUN chmod +x *.sh
# Running both binaries also proves they resolve their shared libraries.
RUN sh ./ffmpeg-fetch.sh && \
    /ffmpeg/bin/ffmpeg -hide_banner -version >/dev/null && \
    /ffmpeg/bin/ffprobe -hide_banner -version >/dev/null
RUN sh ./fetch-twitchdownloader.sh


# Base runtime image with Node.js 24 (installed via nvm for multi-arch compatibility)
FROM ubuntu:26.04 AS base
ARG TARGETPLATFORM
ARG DEBIAN_FRONTEND=noninteractive
ENV UID=1000
ENV GID=1000
ENV USER=youtube
ENV NO_UPDATE_NOTIFIER=true
ENV PM2_HOME=/app/pm2
ENV ALLOW_CONFIG_MUTATIONS=true
ENV npm_config_cache=/app/.npm

# Use NVM to get the current Node 24 LTS line
ENV NODE_VERSION=24
RUN (groupadd -g $GID $USER || groupadd $USER) && \
    (useradd --system -m -g $USER --uid $UID $USER || useradd --system -m -g $USER $USER) && \
    apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates tzdata libatomic1 && \
    ICU_PKG=$(apt-cache search '^libicu[0-9]+$' | awk '{print $1}' | sort -V | tail -1) && \
    apt-get install -y --no-install-recommends "${ICU_PKG}" && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

RUN mkdir /usr/local/nvm
ENV PATH="/usr/local/nvm/current/bin:${PATH}"
ENV NVM_DIR=/usr/local/nvm
# install.sh already installs NODE_VERSION because it is set. nvm keeps the downloaded
# tarball in its cache, and Node ships C++ headers that are only needed to compile native
# addons (nothing here does), so both are removed in this same layer or they stay in the image.
RUN curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash && \
    . "$NVM_DIR/nvm.sh" && \
    nvm install ${NODE_VERSION} && \
    nvm use v${NODE_VERSION} && \
    nvm alias default v${NODE_VERSION} && \
    nvm cache clear && \
    rm -rf "$NVM_DIR"/versions/node/*/include && \
    rm -f "$NVM_DIR/current" && \
    ln -s "$(dirname "$(dirname "$(command -v node)")")" "$NVM_DIR/current"

# Build frontend
ARG BUILDPLATFORM
FROM --platform=${BUILDPLATFORM} node:24 AS frontend
WORKDIR /build
COPY [ ".npmrc", "package.json", "package-lock.json", "angular.json", "tsconfig.json", "/build/" ]
COPY [ "src/", "/build/src/" ]
RUN npm ci && \
    npm run build


# Install backend deps
FROM base AS backend
WORKDIR /app
COPY [ "backend/","/app/" ]
# npm_config_cache points inside /app, so the cache would be copied into the final image.
RUN npm ci --omit=dev && \
    npm cache clean --force

# Final image
FROM base
# curl_cffi is what gives yt-dlp an impersonation target. The downloaded yt-dlp binary is a
# zipapp that runs on this system Python, so without curl_cffi installed here sites that
# fingerprint TLS answer 403 and yt-dlp only warns that no impersonate target is available.
RUN command -v setpriv >/dev/null && \
    npm install -g pm2 && \
    npm cache clean --force && \
    apt update && \
    apt install -y --no-install-recommends gosu python3-minimal python-is-python3 python3-pip atomicparsley build-essential unzip && \
    pip install --no-cache-dir --break-system-packages pycryptodomex curl_cffi && \
    apt remove -y --purge build-essential && \
    apt autoremove -y --purge && \
    apt clean && \
    rm -rf /var/lib/apt/lists/*

# Install Deno system-wide as yt-dlp's JavaScript runtime. The yt-dlp-ejs scripts it runs
# ship inside the downloaded yt-dlp binary, so no system-wide yt-dlp install is needed.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app
# ffmpeg and ffprobe load their libraries from ../lib, so bin/ and lib/ land side by side.
COPY --from=utils [ "/ffmpeg/bin/", "/usr/local/bin/" ]
COPY --from=utils [ "/ffmpeg/lib/", "/usr/local/lib/" ]
# User 1000 already exist from base image
COPY --chown=$UID:$GID --from=utils [ "/usr/local/bin/TwitchDownloaderCLI", "/usr/local/bin/TwitchDownloaderCLI"]
COPY --chown=$UID:$GID [ "Public API v1.yaml", "/app/Public API v1.yaml" ]
COPY --chown=$UID:$GID --from=backend ["/app/","/app/"]
COPY --chown=$UID:$GID --from=frontend [ "/build/backend/public/", "/app/public/" ]
RUN chmod +x /app/fix-scripts/*.sh && \
    mkdir -p /app/pm2 /app/.npm && \
    chmod 777 /app/pm2 /app/.npm
# Add some persistence data
#VOLUME ["/app/appdata"]

EXPOSE 17442
ENTRYPOINT [ "/app/entrypoint.sh" ]
CMD [ "npm","start" ]
