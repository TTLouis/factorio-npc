FROM node:22-bookworm AS build

ENV CI=true
RUN corepack enable
WORKDIR /src
# Fetch the pinned pnpm once, in a layer keyed on the root package.json, and keep
# the package store in a BuildKit cache, so a source-only change downloads nothing.
COPY package.json ./
RUN corepack install
COPY . .
RUN --mount=type=cache,id=npc-test-pnpm-store,target=/pnpm/store \
  pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store
RUN pnpm test:prompt
RUN pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build
RUN pnpm --filter autorio.ts run test
RUN node deploy/pterodactyl/staging/source-preparer.mjs . deploy/pterodactyl/staging/guard.ts
RUN pnpm --filter autorio.ts run typecheck
RUN pnpm --filter autorio.ts run build
RUN cp packages/autorio/info.json packages/autorio/dist/info.json

FROM debian:bookworm-slim

ARG FACTORIO_VERSION=2.0.77
ENV FACTORIO_VERSION=${FACTORIO_VERSION}
ENV FACTORIO_ROOT=/opt/factorio
ENV TEST_ROOT=/test

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl libstdc++6 python3 xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://factorio.com/get-download/${FACTORIO_VERSION}/headless/linux64" -o /tmp/factorio.tar.xz \
  && mkdir -p /opt \
  && tar -xJf /tmp/factorio.tar.xz -C /opt \
  && rm /tmp/factorio.tar.xz

RUN mkdir -p /opt/factorio/mods /test/results /test/saves
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN node --version
COPY --from=build /src/packages/autorio/dist /opt/factorio/mods/autorio_0.1.0
COPY --from=build /src/deploy/pterodactyl/staging /test/pterodactyl/staging
COPY --from=build /src/deploy/pterodactyl/runtime-v8 /test/pterodactyl/runtime-v8
COPY tests/factorio/runner /test/runner
COPY tests/factorio/fixtures /test/fixtures
COPY tests/factorio/run.sh /test/run.sh
RUN sed -i 's/\r$//' /test/run.sh && chmod +x /test/run.sh

WORKDIR /test
ENTRYPOINT ["/test/run.sh"]