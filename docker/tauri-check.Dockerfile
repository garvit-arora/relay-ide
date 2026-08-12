FROM rust:1.97-trixie
RUN rm -rf /var/lib/apt/lists/* \
 && apt-get clean \
 && apt-get update -o Acquire::Retries=3 \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends -o Acquire::Retries=3 \
      pkg-config libgtk-3-dev libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace/src-tauri
CMD ["cargo", "check"]