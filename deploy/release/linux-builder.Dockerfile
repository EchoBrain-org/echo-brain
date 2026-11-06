# Local package preparation only; no AWS access, sign-in or publishing tools.
FROM node:22.22.1-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends \
    zip unzip python3 build-essential fakeroot dpkg-dev \
    libgtk-3-0 libnss3 libasound2 libgbm1 libxss1 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
ENV TZ=UTC
# Readiness is checked before dependency installation or package builds. The
# source is mounted read-only; build in a separate writable copy of that SHA.
CMD ["node", "tools/authority-staging-release.mjs", "preflight", "--target", "linux"]
