FROM node:22-bookworm AS node-tools
FROM golang:1.26.0-bookworm AS go-tools
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends \
       ca-certificates curl gnupg git xvfb xauth unzip file \
       osslsigncode p7zip-full python3 \
    && rm -rf /var/lib/apt/lists/*
# CPython 3.12 uses CopyFile2, which aborts under Ubuntu's Wine 9. Use WineHQ 11
# with signed APT metadata rather than patching Python's filesystem functions.
ARG WINE_VERSION=11.0.0.0~noble-1
RUN dpkg --add-architecture i386 \
    && mkdir -p /etc/apt/keyrings \
    && curl -fsSL https://dl.winehq.org/wine-builds/winehq.key \
       | gpg --dearmor -o /etc/apt/keyrings/winehq.gpg
RUN echo 'deb [signed-by=/etc/apt/keyrings/winehq.gpg] https://dl.winehq.org/wine-builds/ubuntu/ noble main' \
       > /etc/apt/sources.list.d/winehq.list \
    && apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --install-recommends "winehq-stable=${WINE_VERSION}" \
    && rm -rf /var/lib/apt/lists/*
COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=node-tools /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=go-tools /usr/local/go /usr/local/go
ENV PATH="/usr/local/go/bin:${PATH}"

# Official CPython NuGet distribution includes pip and venv, without an MSI or
# Windows Git installation. Reticulum is installed from a pinned source archive.
RUN curl -fL --retry 3 \
      https://api.nuget.org/v3-flatcontainer/python/3.12.10/python.3.12.10.nupkg \
      -o /tmp/python.nupkg \
    && echo '0eb85c2dfccccf1b17352de4c397f69194035b7d37149eacc16f1147d93de3b8  /tmp/python.nupkg' | sha256sum -c - \
    && unzip -q /tmp/python.nupkg -d /opt/windows-python \
    && rm /tmp/python.nupkg
ENV QORTAL_WINDOWS_PYTHON=/opt/windows-python/tools/python.exe \
    WINEDEBUG=-all \
    WINEARCH=win64 \
    WINEDLLOVERRIDES="mscoree,mshtml=" \
    PYTHONLEGACYWINDOWSSTDIO=1 \
    PYTHONIOENCODING=utf-8
# Python and Electron need neither Mono nor Gecko. Disable their first-run
# installer dialogs so fresh Wine prefixes can initialize unattended.
WORKDIR /workspace
