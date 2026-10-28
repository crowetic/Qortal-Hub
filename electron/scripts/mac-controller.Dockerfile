FROM node:22-bookworm
RUN apt-get update -o APT::Update::Error-Mode=any \
    && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
ENV HOME=/tmp/controller-home
