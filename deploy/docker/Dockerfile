FROM --platform=linux/amd64 debian:bookworm-slim AS base

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    coreutils \
    curl \
    findutils \
    git \
    grep \
    gzip \
    mawk \
    procps \
    tar \
    util-linux \
    xz-utils \
    zip \
  && rm -rf /var/lib/apt/lists/*

# The official Factorio headless archive, cached per FACTORIO_VERSION so a
# source rebuild does not download it again. The installer still verifies it
# against Factorio's published checksums, and downloads the archive itself when
# the cached one is not the version it resolves (for example after a new
# release while an older FACTORIO_VERSION=latest layer is cached).
FROM base AS factorio-archive
ARG FACTORIO_VERSION=latest
RUN set -eux; \
  mkdir -p /cache; \
  case "$FACTORIO_VERSION" in \
    latest|experimental) \
      channel=stable; \
      if [ "$FACTORIO_VERSION" = experimental ]; then channel=experimental; fi; \
      curl --fail --location --retry 3 --connect-timeout 20 --max-time 60 \
        --proto '=https' --proto-redir '=https' \
        https://factorio.com/api/latest-releases --output /tmp/releases.json; \
      target="$(grep -oE "\"$channel\":[{][^}]*[}]" /tmp/releases.json | grep -oE '"headless":"[0-9]+[.][0-9]+[.][0-9]+"' | grep -oE '[0-9]+[.][0-9]+[.][0-9]+' || true)";; \
    *) target="$FACTORIO_VERSION";; \
  esac; \
  if printf '%s' "$target" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+$'; then \
    archive="factorio-headless_linux_${target}.tar.xz"; \
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 \
      --proto '=https' --proto-redir '=https' \
      "https://www.factorio.com/get-download/${target}/headless/linux64" --output "/cache/$archive"; \
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 60 \
      --proto '=https' --proto-redir '=https' \
      https://factorio.com/download/sha256sums/ --output /tmp/factorio-sha256sums.txt; \
    awk -v name="$archive" '$2==name {print $1 "  " $2}' /tmp/factorio-sha256sums.txt > /tmp/factorio-archive.sha256; \
    test "$(wc -l < /tmp/factorio-archive.sha256)" = 1; \
    (cd /cache && sha256sum -c /tmp/factorio-archive.sha256); \
  fi; \
  rm -f /tmp/releases.json /tmp/factorio-sha256sums.txt /tmp/factorio-archive.sha256

FROM base

ARG SGLUNA_REPO=
ARG SGLUNA_SOURCE_REF=
ARG AIRI_REPO=
ARG AIRI_SOURCE_REF=
ARG FACTORIO_VERSION=latest
ARG SGLUNA_LOCAL_RUNTIME_OVERRIDE=0
# The source layer is cached by its build arguments. An exact commit SHA fully
# determines it; a branch ref does not, so use a SHA or change this nonce to
# install the branch's newer commits.
ARG SGLUNA_SOURCE_NONCE=

RUN --mount=type=bind,from=factorio-archive,source=/cache,target=/opt/factorio-cache \
  set -eux; \
  : "source nonce: ${SGLUNA_SOURCE_NONCE}"; \
  repo="${SGLUNA_REPO:-${AIRI_REPO:-TTLouis/factorio-npc}}"; \
  ref="${SGLUNA_SOURCE_REF:-${AIRI_SOURCE_REF:-main}}"; \
  if [ -n "${SGLUNA_SOURCE_REF:-}" ] && [ -n "${AIRI_SOURCE_REF:-}" ] && [ "$SGLUNA_SOURCE_REF" != "$AIRI_SOURCE_REF" ]; then echo '[SGLuna docker] SGLUNA_SOURCE_REF overrides conflicting AIRI_SOURCE_REF.' >&2; fi; \
  if printf '%s' "$ref" | grep -Eq '^[a-f0-9]{40}$'; then \
    resolved="$ref"; \
  else \
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 60 \
      --proto '=https' --proto-redir '=https' \
      --get --data-urlencode "sha=$ref" --data-urlencode 'per_page=1' \
      "https://api.github.com/repos/$repo/commits" \
      --output /tmp/airi-resolution.json; \
    resolved="$(grep -m1 -oE '\"sha\"[[:space:]]*:[[:space:]]*\"[a-f0-9]{40}\"' /tmp/airi-resolution.json | grep -oE '[a-f0-9]{40}' || true)"; \
  fi; \
  printf '%s' "$resolved" | grep -Eq '^[a-f0-9]{40}$'; \
  short="$(printf '%s' "$resolved" | cut -c1-12)"; \
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 120 \
    --proto '=https' --proto-redir '=https' \
    "https://raw.githubusercontent.com/$repo/$resolved/deploy/pterodactyl/payload-src/installer.sh" \
    --output /tmp/airi-installer.sh; \
  test "$(grep -Ec '^AIRI_REF=\"[a-f0-9]{40}\"$' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -c '^AIRI_REF=' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -Ec '^REVISION=\"[A-Za-z0-9._-]+\"$' /tmp/airi-installer.sh)" = 1; \
  test "$(grep -c '^REVISION=' /tmp/airi-installer.sh)" = 1; \
  awk -v ref="$resolved" -v revision="docker-$short" ' \
    /^AIRI_REF=/ { print "AIRI_REF=\"" ref "\""; next } \
    /^REVISION=/ { print "REVISION=\"" revision "\""; next } \
    index($0, "fetch \"https://www.factorio.com/get-download/${FACTORIO_TARGET}/headless/linux64\"") == 1 { \
      print "if [[ -f \"/opt/factorio-cache/$FACTORIO_ARCHIVE\" ]]; then log \"Using cached Factorio archive $FACTORIO_ARCHIVE\"; cp \"/opt/factorio-cache/$FACTORIO_ARCHIVE\" \"$WORK/$FACTORIO_ARCHIVE\"; else " $0 "; fi"; next } \
    { print } \
  ' /tmp/airi-installer.sh > /tmp/airi-installer-patched.sh; \
  if ! grep -q '/opt/factorio-cache/' /tmp/airi-installer-patched.sh; then echo '[SGLuna docker] installer has no recognised Factorio download line; it downloads Factorio itself.' >&2; fi; \
  SGLUNA_INSTALL_ROOT=/opt/airi FACTORIO_VERSION="$FACTORIO_VERSION" bash /tmp/airi-installer-patched.sh; \
  printf '%s\n' "$resolved" > /opt/airi/SOURCE_SHA; \
  printf '%s\n' "$ref" > /opt/airi/SOURCE_REF; \
  printf '%s\n' "$FACTORIO_VERSION" > /opt/airi/FACTORIO_VERSION_REQUEST; \
  rm -f /tmp/airi-resolution.json /tmp/airi-installer.sh /tmp/airi-installer-patched.sh /opt/airi/sgluna-config.json

COPY deploy/docker/entrypoint.sh /usr/local/bin/sgluna-docker-entrypoint
RUN chmod 755 /usr/local/bin/sgluna-docker-entrypoint

# An opt-in local E2E hook. The normal image always uses the exact resolved
# source revision above; the test overlay can replace only the supervisor and
# update its release manifest before the container starts.
COPY deploy/pterodactyl/runtime-v8/supervisor.mjs /tmp/local-supervisor.mjs
RUN set -eux; \
  if [ "$SGLUNA_LOCAL_RUNTIME_OVERRIDE" = "1" ]; then \
    target="$(readlink /opt/airi/start-sgluna.sh)"; \
    app="/opt/airi/${target%/start-sgluna.sh}"; \
    test -f "$app/src/runtime-v8/supervisor.mjs"; \
    cp /tmp/local-supervisor.mjs "$app/src/runtime-v8/supervisor.mjs"; \
    APP_ROOT="$app" "$app/node/bin/node" --input-type=module -e 'import fs from "node:fs/promises"; import path from "node:path"; import crypto from "node:crypto"; const root = process.env.APP_ROOT; const file = "src/runtime-v8/supervisor.mjs"; const manifestPath = path.join(root, "manifest.json"); const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); manifest.files[file] = crypto.createHash("sha256").update(await fs.readFile(path.join(root, file))).digest("hex"); await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + String.fromCharCode(10));'; \
  fi; \
  rm -f /tmp/local-supervisor.mjs

ENV CONTAINER_ROOT=/data
WORKDIR /data
VOLUME ["/data"]
EXPOSE 34197/udp
STOPSIGNAL SIGTERM

ENTRYPOINT ["/usr/local/bin/sgluna-docker-entrypoint"]
