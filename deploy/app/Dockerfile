# syntax=docker/dockerfile:1
#
# The web app and its eight eve agents as one image (README.md in this folder).
# Build from the repository root, with the four values `next build` compiles in
# (below; the build stops at once if one is missing):
#
#   docker build -f deploy/app/Dockerfile -t ni-app:local \
#     --build-arg NEXT_PUBLIC_APP_URL=https://app.example.com \
#     --build-arg EVE_NEXT_PRODUCTION_ORIGIN=http://proxy:8081 \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key> .
#
# Add --build-arg NEXT_PUBLIC_SUPABASE_PROJECT_REF=<ref> when the Supabase address
# above is not the one the project's sessions were made under (README.md here).
#
# compose.yaml builds it with made-up values for the container test.
#
# One image, four roles, chosen by the command (entrypoint.sh):
#   web            next start, with /eve/<name>/v1/* pointed at agents running elsewhere
#   worker         the same server; route only /api/inngest to it
#   agent <name>   one agent's built server (what eve start runs)
#   cron           supercronic, calling the web role's /api/cron/* routes
#
# The image keeps the repository's layout: /app/web and /app/deploy/app.
# The NEXT_PUBLIC_* build arguments are public values that `next build` compiles
# into the web role. The one secret is the hosted sandbox service's access token, for
# the coding agent's build only, mounted as a BuildKit secret (see build-agents.sh's
# step below) and never stored in the image.

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

# --- build-args: the values `next build` needs, checked first ----------------------
# They have no defaults: an image built without them would start, look healthy, and
# fail every sign-in and every call from the browser. BuildKit runs this stage beside
# deps, so a missing value stops the build in seconds; the build stage copies its
# marker, whose content never changes, so the check costs that stage no cache.
FROM base AS build-args
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG EVE_NEXT_PRODUCTION_ORIGIN
RUN missing=""; \
    [ -n "$NEXT_PUBLIC_APP_URL" ] || missing="$missing NEXT_PUBLIC_APP_URL"; \
    [ -n "$NEXT_PUBLIC_SUPABASE_URL" ] || missing="$missing NEXT_PUBLIC_SUPABASE_URL"; \
    [ -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY" ] || missing="$missing NEXT_PUBLIC_SUPABASE_ANON_KEY"; \
    [ -n "$EVE_NEXT_PRODUCTION_ORIGIN" ] || missing="$missing EVE_NEXT_PRODUCTION_ORIGIN"; \
    if [ -n "$missing" ]; then \
      echo "Missing build arguments:$missing. Pass each with --build-arg (see the top of deploy/app/Dockerfile)." >&2; \
      exit 1; \
    fi; \
    touch /build-args-checked

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
COPY --from=build-args /build-args-checked /tmp/build-args-checked
COPY web/ ./
COPY deploy/app/ /app/deploy/app/

# The crontab in this folder must be what web/vercel.json says.
RUN node /app/deploy/app/cron/generate.mjs --check

# The commit the image is built from (deploy.sh passes it). The app reads it under
# the name its earlier host gave it, VERCEL_GIT_COMMIT_SHA: `next build` turns it
# into the build id that open windows compare to notice a new deploy (next.config.mjs,
# /api/version), and the cloud browser's relay is built with it and must match the
# app's at run time. So it is written to /app/BUILD_ID as well, and entrypoint.sh
# gives every role the same value when it starts. Empty: no build id, as before.
ARG NI_BUILD_ID=
RUN case "$NI_BUILD_ID" in *[!0-9a-f]*) echo "NI_BUILD_ID must be a git commit id" >&2; exit 1 ;; esac \
 && printf '%s' "$NI_BUILD_ID" > /app/BUILD_ID

# What `npm run build` runs before `next build`, minus the test suite (CI runs that
# as its own job): the cloud browser's assets and ONNX Runtime's wasm files.
RUN VERCEL_GIT_COMMIT_SHA="$NI_BUILD_ID" node scripts/cloud-browser/build-assets.mjs \
 && node scripts/copy-ort-runtime.mjs

# Each agent is built from its own folder with no Vercel environment, so eve writes a
# Node server to agents/<name>/.output (not Vercel Build Output) and prepares the
# sandbox with the provider it finds here. In a container that is just-bash: there
# is no Docker daemon and no /dev/kvm. build-agents.sh fails on any other, with one
# exception: given the hosted sandbox service's three settings, the coding agent's
# sandbox is prepared there (a snapshot), as its runs need.
#
# Those three reach this step ONLY as BuildKit secrets (compose.yaml's build
# secrets, which deploy.sh fills from .env for that command alone): each is an environment variable of this
# one RUN and of nothing else, never a build argument or an ENV, and is written to no
# layer. build-agents.sh refuses to finish if the access token turns up in what the
# build wrote. Without them (the CI build, the container test) the step runs as
# before. NI_CODING_AGENT_SANDBOX holds no secret, only which sandbox deploy.sh meant
# ("vercel/<team id>/<project id>", ids that are not secret, or empty): BuildKit's
# cache key ignores secrets, so this is what makes a change of sandbox, team or
# project rebuild this step, and build-agents.sh stops if the secrets disagree with it.
ARG NI_CODING_AGENT_SANDBOX=
RUN --mount=type=secret,id=SANDBOX_ACCESS_TOKEN,env=SANDBOX_ACCESS_TOKEN \
    --mount=type=secret,id=SANDBOX_TEAM_ID,env=SANDBOX_TEAM_ID \
    --mount=type=secret,id=SANDBOX_PROJECT_ID,env=SANDBOX_PROJECT_ID \
    /app/deploy/app/build-agents.sh

# Public values that `next build` compiles into the web role, server code included:
# the web role cannot take another NEXT_PUBLIC_* value when it starts. The four with
# no default are required (the build-args stage above).
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_SITE_URL=
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
# The name the session cookie keeps when the Supabase address is not the one the
# sessions were made under (web/src/lib/supabase/project.ts). Empty: not pinned.
# The build stops on a value that cannot be right.
ARG NEXT_PUBLIC_SUPABASE_PROJECT_REF=
ARG NEXT_PUBLIC_POSTHOG_KEY=
ARG NEXT_PUBLIC_POSTHOG_HOST=
# Sentry is switched on, in the browser and on the server, only by a DSN present
# when `next build` runs (next.config.mjs). Source maps are not uploaded: that needs
# SENTRY_AUTH_TOKEN at build time, which this build never sees.
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG APP_DOWNLOAD_URL=
ARG APP_DOWNLOAD_URL_WINDOWS=
# Where the web role finds the agents: the origin that serves
# /_eve_internal/eve/<name>/eve/v1/* (proxy/Caddyfile, the :8081 listener).
# `next build` writes it into its rewrites; eve-origin.mjs reads it back.
ARG EVE_NEXT_PRODUCTION_ORIGIN

RUN NEXT_PUBLIC_APP_URL="$NEXT_PUBLIC_APP_URL" \
    NEXT_PUBLIC_SITE_URL="$NEXT_PUBLIC_SITE_URL" \
    NEXT_PUBLIC_SUPABASE_URL="$NEXT_PUBLIC_SUPABASE_URL" \
    NEXT_PUBLIC_SUPABASE_ANON_KEY="$NEXT_PUBLIC_SUPABASE_ANON_KEY" \
    NEXT_PUBLIC_SUPABASE_PROJECT_REF="$NEXT_PUBLIC_SUPABASE_PROJECT_REF" \
    NEXT_PUBLIC_POSTHOG_KEY="$NEXT_PUBLIC_POSTHOG_KEY" \
    NEXT_PUBLIC_POSTHOG_HOST="$NEXT_PUBLIC_POSTHOG_HOST" \
    NEXT_PUBLIC_SENTRY_DSN="$NEXT_PUBLIC_SENTRY_DSN" \
    VERCEL_GIT_COMMIT_SHA="$NI_BUILD_ID" \
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

# The runtime runs as `node` (uid 1000), which owns only what is written while the
# app runs:
# - web and worker: Next's cache, the pages it regenerates (it saves them beside the
#   built ones, in .next/server/app), and the docs index that `next start` writes
#   again each time it loads next.config.mjs (.source).
# - each agent: its state under .eve (workflow runs, sandbox sessions). compose.yaml
#   puts volumes there; a new volume takes its owner from these folders.
# Set here, not in the runtime stage: copying a stage keeps its owners, and a chown
# there would store .next/server/app a second time in a layer of its own.
RUN mkdir -p .next/cache .source \
 && /app/deploy/app/build-agents.sh --state-dirs | xargs mkdir -p \
 && /app/deploy/app/build-agents.sh --state-dirs | xargs chown -R node:node .next/cache .next/server/app .source

# --- runtime ----------------------------------------------------------------------
FROM base AS runtime
ENV NODE_ENV=production \
    TZ=UTC \
    PORT=3000
COPY --link --from=supercronic /out/supercronic /usr/local/bin/supercronic
COPY --link --from=build /app/deploy /app/deploy
COPY --link --from=build /app/web /app/web
COPY --link --from=build /app/BUILD_ID /app/BUILD_ID
RUN supercronic -test /app/deploy/app/cron/crontab
USER node

EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=90s --start-interval=2s --retries=4 \
  CMD ["node", "/app/deploy/app/healthcheck.mjs"]
ENTRYPOINT ["/app/deploy/app/entrypoint.sh"]
