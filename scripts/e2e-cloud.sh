#!/usr/bin/env bash
# Run the real-Factorio E2E suite (tests/factorio) inside a sandboxed cloud
# container such as Claude Code on the web.
#
# Differences from plain `pnpm test:npc`, all confined to this wrapper:
#   - starts a local dockerd when no daemon is reachable;
#   - pulls base images through a registry mirror, because anonymous Docker Hub
#     pulls from shared egress IPs are routinely rate-limited (HTTP 429);
#   - when an HTTPS egress proxy with its own CA is configured, builds with host
#     networking, forwards the proxy variables, and trusts that CA inside a
#     generated copy of tests/factorio/Dockerfile. The committed Dockerfile and
#     the test runner are not modified.
#
# Usage: scripts/e2e-cloud.sh [--no-build]
# Environment:
#   NPC_TEST_LANES     comma-separated lanes (default: all four)
#   NPC_TEST_PARALLEL  1 = parallel lanes (default), 0 = sequential debug mode
#   E2E_IMAGE          image tag (default: factorio-npc-test)
#   E2E_RESULTS_DIR    host directory for results (default: test-results/factorio)
#   E2E_REGISTRY_MIRROR  mirror used when this script starts dockerd
#                      (default: https://mirror.gcr.io)
#   E2E_PROXY_CA       extra CA bundle to trust (default: /root/.ccr/ca-bundle.crt
#                      when present)
#   FACTORIO_VERSION   headless server version passed as a build arg
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${E2E_IMAGE:-factorio-npc-test}"
RESULTS_DIR="${E2E_RESULTS_DIR:-$ROOT/test-results/factorio}"
REGISTRY_MIRROR="${E2E_REGISTRY_MIRROR:-https://mirror.gcr.io}"
PROXY_CA="${E2E_PROXY_CA:-}"
if [[ -z "$PROXY_CA" && -f /root/.ccr/ca-bundle.crt ]]; then
  PROXY_CA=/root/.ccr/ca-bundle.crt
fi
PROXY="${HTTPS_PROXY:-${https_proxy:-}}"
NOPROXY="${NO_PROXY:-${no_proxy:-}}"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

log() { printf '[e2e-cloud] %s\n' "$*"; }

ensure_dockerd() {
  if docker info >/dev/null 2>&1; then
    return
  fi
  command -v dockerd >/dev/null || { log 'no reachable Docker daemon and dockerd is not installed'; exit 1; }
  if [[ ! -f /etc/docker/daemon.json && -n "$REGISTRY_MIRROR" ]]; then
    mkdir -p /etc/docker
    printf '{"registry-mirrors":["%s"]}\n' "$REGISTRY_MIRROR" >/etc/docker/daemon.json
  fi
  log 'starting dockerd'
  nohup dockerd >/tmp/dockerd.log 2>&1 &
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && return
    sleep 1
  done
  log 'dockerd did not become ready; see /tmp/dockerd.log'
  tail -20 /tmp/dockerd.log >&2 || true
  exit 1
}

build_image() {
  local dockerfile="$ROOT/tests/factorio/Dockerfile"
  local args=(build -t "$IMAGE" --build-arg "FACTORIO_VERSION=${FACTORIO_VERSION:-2.0.77}")

  if [[ -n "$PROXY" ]]; then
    # The sandbox proxy listens on the host loopback, so build steps need the
    # host network namespace to reach it.
    args+=(--network host
      --build-arg "HTTPS_PROXY=$PROXY" --build-arg "https_proxy=$PROXY"
      --build-arg "NO_PROXY=$NOPROXY" --build-arg "no_proxy=$NOPROXY")
  fi

  if [[ -n "$PROXY_CA" ]]; then
    # Generate a Dockerfile that installs the proxy CA right after every FROM.
    # ca-certificates' postinst (debian stage) and update-ca-certificates
    # (node stage) fold it into the system bundle; Node gets it explicitly.
    local generated
    generated="$(mktemp -d)/Dockerfile"
    awk '
      { print }
      /^FROM / {
        print "COPY --from=e2e_proxy_ca ca.crt /usr/local/share/ca-certificates/e2e-proxy-ca.crt"
        print "ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/e2e-proxy-ca.crt"
        print "RUN if command -v update-ca-certificates >/dev/null; then update-ca-certificates >/dev/null; fi"
      }
    ' "$dockerfile" >"$generated"
    local ca_ctx
    ca_ctx="$(dirname "$generated")/ca"
    mkdir -p "$ca_ctx"
    cp "$PROXY_CA" "$ca_ctx/ca.crt"
    args+=(--build-context "e2e_proxy_ca=$ca_ctx")
    dockerfile="$generated"
    log "trusting proxy CA $PROXY_CA inside the build"
  fi

  args+=(-f "$dockerfile" "$ROOT")
  log "building $IMAGE"
  docker "${args[@]}"
}

run_suite() {
  mkdir -p "$RESULTS_DIR"
  # Results are copied out of the stopped container instead of bind-mounted,
  # so run.sh keeps sole ownership of /test/results and /test/lanes.
  local name="factorio-npc-e2e-$$"
  local run_args=(run --name "$name"
    -e "NPC_TEST_LANES=${NPC_TEST_LANES:-core,research-combat,resilience,production}"
    -e "NPC_TEST_PARALLEL=${NPC_TEST_PARALLEL:-1}"
    "$IMAGE")
  log "running lanes: ${NPC_TEST_LANES:-core,research-combat,resilience,production}"
  local status=0
  docker "${run_args[@]}" || status=$?
  rm -rf "$RESULTS_DIR"/*
  docker cp "$name:/test/results/." "$RESULTS_DIR/" >/dev/null 2>&1 || true
  docker cp "$name:/test/lanes" "$RESULTS_DIR/lanes" >/dev/null 2>&1 || true
  docker rm "$name" >/dev/null 2>&1 || true
  log "results copied to $RESULTS_DIR (exit $status)"
  return "$status"
}

ensure_dockerd
(( BUILD )) && build_image
run_suite
