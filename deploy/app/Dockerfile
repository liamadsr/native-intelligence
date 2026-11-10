# syntax=docker/dockerfile:1
#
# The web app and its eight eve agents as one image (README.md in this folder).
# Build from the repository root:
#
#   docker build -f deploy/app/Dockerfile -t ni-app:local .
#
# One image, four roles, chosen by the command (entrypoint.sh):
#   web            next start, with /eve/<name>/v1/* pointed at agents running elsewhere
#   worker         the same server; route only /api/inngest to it
#   agent <name>   eve start for one agent
#   cron           supercronic, calling the web role's /api/cron/* routes
#
# The image keeps the repository's layout: /app/web and /app/deploy/app.
# Nothing here reads a secret. The NEXT_PUBLIC_* build arguments are public values
# that `next build` compiles into the web role.

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG GO_IMAGE=golang:1.27-bookworm@sha256:dc0963f32053e4bc451d24d87e3892d42d01021b61f093e98eb95c0352bb84b0

# --- supercronic, the cron role's scheduler ---------------------------------------
# Built from source through the Go module proxy, which checks the module against
# Go's public checksum database: no hand-kept checksum, and any CPU architecture.
FROM ${GO_IMAGE} AS supercronic
ARG SUPERCRONIC_VERSION=v0.2.51
RUN CGO_ENABLED=0 GOBIN=/out go install -trimpath -ldflags="-s -w" \
      "github.com/aptible/supercronic@${SUPERCRONIC_VERSION}"

# --- base: Node 24 on Debian (glibc, which sharp's and onnxruntime's binaries need) -
FROM ${NODE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1 \
    EVE_TELEMETRY_DISABLED=1 \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app/web

# --- deps: node_modules, with web/patches applied -----------------------------------
# `npm ci` runs the root postinstall, patch-package. Outside CI that exits 0 even
# when a patch no longer applies, so it runs once more with --error-on-fail (a no-op
# on packages already patched): a stale patch fails the image.
# ONNXRUNTIME_NODE_INSTALL_CUDA=skip: onnxruntime-node's install script otherwise
# downloads 340 MB of NVIDIA GPU libraries that nothing here can use.
FROM base AS deps
COPY web/package.json web/package-lock.json ./
COPY web/packages/ui/package.json packages/ui/package.json
COPY web/patches patches
RUN ONNXRUNTIME_NODE_INSTALL_CUDA=skip npm ci \
 && node_modules/.bin/patch-package --error-on-fail \
 && rm -rf /root/.npm

# --- build: the eight `eve build`s, then `next build` -------------------------------
FROM deps AS build
COPY web/ ./
COPY deploy/app/ /app/deploy/app/

# The crontab in this folder must be what web/vercel.json says.
RUN node /app/deploy/app/cron/generate.mjs --check

# What `npm run build` runs before `next build`, minus the test suite (CI runs that
# as its own job): the cloud browser's assets and ONNX Runtime's wasm files.
RUN node scripts/cloud-browser/build-assets.mjs \
 && node scripts/copy-ort-runtime.mjs

# Each agent is built from its own folder with no Vercel environment, so eve writes a
# Node server to agents/<name>/.output (not Vercel Build Output) and prepares the
# sandbox with the provider it finds here. In a container that is just-bash: there
# is no Docker daemon and no /dev/kvm. build-agents.sh fails on any other.
RUN /app/deploy/app/build-agents.sh

# Public values that `next build` compiles into the web role, server code included:
# the web role cannot take another NEXT_PUBLIC_* value when it starts.
ARG NEXT_PUBLIC_APP_URL=http://proxy:8080
ARG NEXT_PUBLIC_SITE_URL=
ARG NEXT_PUBLIC_SUPABASE_URL=http://supabase.invalid
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY=build-placeholder
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
ARG APP_DOWNLOAD_URL=
ARG APP_DOWNLOAD_URL_WINDOWS=
# Where the web role finds the agents: the origin that serves
# /_eve_internal/eve/<name>/eve/v1/* (proxy/Caddyfile, the :8081 listener).
# `next build` writes it into its rewrites; eve-origin.mjs reads it back.
ARG EVE_NEXT_PRODUCTION_ORIGIN=http://proxy:8081

RUN NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
    NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
    NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    NEXT_PUBLIC_POSTHOG_KEY="$NEXT_PUBLIC_POSTHOG_KEY" \
    NEXT_PUBLIC_POSTHOG_HOST="$NEXT_PUBLIC_POSTHOG_HOST" \
    APP_DOWNLOAD_URL="$APP_DOWNLOAD_URL" \
    APP_DOWNLOAD_URL_WINDOWS="$APP_DOWNLOAD_URL_WINDOWS" \
    EVE_NEXT_PRODUCTION_ORIGIN="$EVE_NEXT_PRODUCTION_ORIGIN" \
    NODE_OPTIONS=--max-old-space-size=8192 \
    node_modules/.bin/next build \
 && rm -rf .next/cache \
 && built="$(node /app/deploy/app/eve-origin.mjs)" \
 && if [ "$built" != "$EVE_NEXT_PRODUCTION_ORIGIN" ]; then \
      echo "next build pointed the agents at $built, not $EVE_NEXT_PRODUCTION_ORIGIN" >&2; exit 1; \
    fi

# --- runtime ----------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000
COPY --link --from=supercronic /out/supercronic /usr/local/bin/supercronic
COPY --link --from=build /app/deploy /app/deploy
COPY --link --from=build /app/web /app/web

# Runs as `node` (uid 1000), which owns only what is written while the app runs:
# - web and worker: Next's cache, the pages it regenerates (it saves them beside the
#   built ones, in .next/server/app), and the docs index that `next start` writes
#   again each time it loads next.config.mjs (.source).
# - each agent: its state under .eve (workflow runs, sandbox sessions). compose.yaml
#   puts volumes there; a new volume takes its owner from these folders.
RUN supercronic -test /app/deploy/app/cron/crontab \
 && mkdir -p .next/cache .source \
 && /app/deploy/app/build-agents.sh --state-dirs | xargs mkdir -p \
 && /app/deploy/app/build-agents.sh --state-dirs | xargs chown -R node:node .next/cache .next/server/app .source
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --start-interval=2s --retries=4 \
  CMD ["node", "/app/deploy/app/healthcheck.mjs"]
ENTRYPOINT ["/app/deploy/app/entrypoint.sh"]
