# The call recorder (README.md in this folder): Node 24 running the TypeScript as it is
# (Node strips the types), with LiveKit's server-side SDK and nothing else. Built on the
# server by deploy/livekit/compose.yaml (`sudo docker compose --profile recorder build
# recorder`), never pulled: there is no registry.
#
# Debian, not Alpine: the SDK's native library (@livekit/rtc-ffi-bindings) is built
# for glibc. The base is the app's own (deploy/app/Dockerfile), pinned to the same digest.
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
FROM ${NODE_IMAGE}
ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false
WORKDIR /app
# The lock file decides every version, the native library's for this machine included.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
	&& node -e "require('@livekit/rtc-node')"
COPY tsconfig.json ./
COPY src ./src
# Nothing it runs needs root: the image's own unprivileged user.
USER node
CMD ["node", "src/main.ts"]
