# Debian 11 (bullseye) ~glibc 2.31 — same compatibility class as Ubuntu 20.04, without PPAs.
# Ubuntu 20.04 focal is EOL; deadsnakes often stops publishing for it, breaking apt installs.
# Python 3.9 + libpython come from Debian main. For local Linux Docker package builds only; CI stays ubuntu-22.04.
FROM debian:bullseye-slim

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=UTC

# Bullseye's final security packages moved to archive.debian.org after LTS ended.
# Keep glibc 2.31; live security indexes can still reference removed .deb files.
# HTTP bootstraps ca-certificates; APT still verifies Debian signatures/hashes.
# Only these immutable archive entries disable the metadata expiry check.
RUN rm -f /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources \
    && printf '%s\n' \
    'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://archive.debian.org/debian bullseye main' \
    'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://archive.debian.org/debian bullseye-updates main' \
    'deb [check-valid-until=no signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] http://archive.debian.org/debian-security bullseye-security main' \
    > /etc/apt/sources.list \
    && rm -rf /var/lib/apt/lists/*

# python3-dev pulls libpython3.9-dev (PyInstaller); python3 pulls libpython3.9-stdlib (.so runtime).
RUN apt-get -o APT::Update::Error-Mode=any -o Acquire::Retries=3 update \
    && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gnupg \
    build-essential \
    binutils \
    python3 \
    python3-pip \
    python3-venv \
    python3-dev \
    fakeroot \
    dpkg-dev \
    rpm \
    squashfs-tools \
    libgtk-3-0 \
    libnss3 \
    libasound2 \
    libgbm1 \
    libxss1 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# The regular desktop app uses this compiler for its QUIC/MASQUE sidecar.
# Checksums: https://go.dev/dl/?mode=json&include=all (go1.26.0).
ARG GO_VERSION=1.26.0
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) go_arch=amd64; go_sha=aac1b08a0fb0c4e0a7c1555beb7b59180b05dfc5a3d62e40e9de90cd42f88235 ;; \
      arm64) go_arch=arm64; go_sha=bd03b743eb6eb4193ea3c3fd3956546bf0e3ca5b7076c8226334afe6b75704cd ;; \
      *) echo 'Unsupported Go build architecture' >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tar.gz; \
    printf '%s  /tmp/go.tar.gz\n' "${go_sha}" | sha256sum -c -; \
    tar -C /usr/local -xzf /tmp/go.tar.gz; \
    rm /tmp/go.tar.gz; \
    /usr/local/go/bin/go version
ENV PATH="/usr/local/go/bin:${PATH}"

WORKDIR /workspace
