# The Studio worker (README.md in this folder): Node 24 running the TypeScript through
# tsx's loader (no build step), with FFmpeg, poppler, LibreOffice Impress, fonts, and
# the Chrome headless shell Remotion renders in. Built on the server from the
# repository's root, never pulled: there is no registry (../deploy/studio/README.md):
#
#   sudo docker build -f studio-worker/Dockerfile -t ni-studio-worker:local .
#
# It carries the engine's own files (web/src/lib/studio/engine, the job contract and the ads contract),
# not a copy, and installs only what the engine imports (engine-deps/, as web/), so
# the image holds none of the rest of the app.
#
# Not built or run yet: written with care, untested as an image (README.md, "The image").
#
# Debian, not Alpine: Chrome and Remotion's compositor are built for glibc. The base is
# the app's own (deploy/app/Dockerfile), pinned to the same digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    DEBIAN_FRONTEND=noninteractive

# FFmpeg (import, mastering, checks), poppler (PDF pages), LibreOffice Impress (PowerPoint
# and OpenDocument to PDF), fonts for slides and the composition's fallback text, and the
# libraries Chrome headless shell needs (Remotion's list for Debian:
# https://www.remotion.dev/docs/miscellaneous/linux-dependencies).
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		ffmpeg \
		poppler-utils \
		libreoffice-impress \
		fonts-liberation fonts-noto-core fonts-noto-color-emoji \
		libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev libxfixes3 \
		libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
	&& rm -rf /var/lib/apt/lists/*
# The motion check and the review (python/motion_analysis.py): Debian's Python with numpy and
# OpenCV, found as `python3` (README.md, "The measured checks"). On-screen text in the review
# would also need `tesseract-ocr`, left out to keep the image small: the review says so.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3-numpy python3-opencv \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app
# What the engine imports, where the engine's files will find it (/app/web/node_modules).
COPY studio-worker/engine-deps/package.json studio-worker/engine-deps/package-lock.json web/
RUN cd web && npm ci --omit=dev && npm cache clean --force
# The worker's own packages; the lock file decides every version (the compositor's and
# the bundler's native packages for this machine included).
COPY studio-worker/package.json studio-worker/package-lock.json studio-worker/
RUN cd studio-worker && npm ci --omit=dev && npm cache clean --force
# Remotion's Chrome headless shell, fetched now into studio-worker/node_modules/.remotion,
# so the worker never downloads it at run time (the root is read-only there).
RUN cd studio-worker && node --input-type=module -e "import { ensureBrowser } from '@remotion/renderer'; await ensureBrowser();"

COPY web/src/lib/studio/engine web/src/lib/studio/engine
COPY web/src/lib/studio/server/job-contract.ts web/src/lib/studio/server/job-contract.ts
COPY web/src/lib/studio/server/ads-contract.ts web/src/lib/studio/server/ads-contract.ts
COPY studio-worker/tsconfig.json studio-worker/
COPY studio-worker/src studio-worker/src
COPY studio-worker/python studio-worker/python
# The work folder (the asset cache, the bundle, each job's scratch): a volume in
# compose.yaml, owned by the unprivileged user so the volume starts out that way.
RUN mkdir -p /work && chown node:node /work
ENV STUDIO_WORK_DIR=/work \
    XDG_CACHE_HOME=/tmp/.cache \
    XDG_CONFIG_HOME=/tmp/.config
# Nothing it runs needs root: the image's own unprivileged user.
USER node
WORKDIR /app/studio-worker
CMD ["node", "--import", "tsx", "src/index.ts"]
