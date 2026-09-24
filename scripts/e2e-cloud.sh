#!/usr/bin/env bash
# Run the real-Factorio E2E suite (tests/factorio) inside a sandboxed cloud
# container such as Claude Code on the web.
#
# Differences from plain `pnpm test:npc` live in scripts/lib/cloud-docker.sh:
# start dockerd if needed, pull through a registry mirror, and build through
# the sandbox egress proxy with its CA trusted. The committed Dockerfile and the
# test runner are not modified.
#
# Usage: scripts/e2e-cloud.sh [--no-build]
# Environment:
#   NPC_TEST_LANES     comma-separated lanes (default: all four)
#   NPC_TEST_PARALLEL  1 = parallel lanes (default), 0 = sequential debug mode
#   E2E_IMAGE          image tag (default: factorio-npc-test)
#   E2E_RESULTS_DIR    host directory for results (default: test-results/factorio)
#   FACTORIO_VERSION   headless server version passed as a build arg
#   See scripts/lib/cloud-docker.sh for E2E_REGISTRY_MIRROR and E2E_PROXY_CA.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${E2E_IMAGE:-factorio-npc-test}"
RESULTS_DIR="${E2E_RESULTS_DIR:-$ROOT/test-results/factorio}"
BUILD=1
[[ "${1:-}" == "--no-build" ]] && BUILD=0

CLOUD_LOG_TAG=e2e-cloud
# shellcheck source=lib/cloud-docker.sh
source "$ROOT/scripts/lib/cloud-docker.sh"
log() { cloud_log "$@"; }

build_image() {
  cloud_docker_build "$ROOT/tests/factorio/Dockerfile" "$ROOT" "$IMAGE" \
    --build-arg "FACTORIO_VERSION=${FACTORIO_VERSION:-2.0.77}"
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
