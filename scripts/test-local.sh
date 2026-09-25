#!/usr/bin/env bash
# scripts/test-local.sh — run this repo's test suites inside the local
# `npc-dev` Docker image, with the mounts each suite actually needs.
#
# Why: on Windows, node_modules under the checkout are WSL symlinks, so
# tests must run inside `npc-dev` (which already has dependencies — this
# script never runs `pnpm install` and never touches the network). Agents
# picking their own ad hoc mounts have been hitting false failures:
#   - the runtime-v8 tool-contract parity tests need `contracts/` mounted;
#   - deploy/pterodactyl/staging/local-compose-secret-boundary.test.mjs reads
#     repo-root files (.devcontainer/, the compose.*.yml files, .env.example,
#     .gitignore, .dockerignore) that aren't under deploy/pterodactyl.
#
# Run from Git Bash on Windows (or any POSIX shell with Docker Desktop).
#
# Usage:
#   scripts/test-local.sh runtime   # node --test: deploy/pterodactyl staging + runtime-v8
#   scripts/test-local.sh mod       # autorio: vitest, tsc --noEmit, Lua build, check-generated-lua
#   scripts/test-local.sh all       # both

set -euo pipefail

usage() {
  echo "usage: $0 {runtime|mod|all}" >&2
  exit 2
}

cmd="${1:-}"
[[ -n "$cmd" ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

run_runtime() {
  echo "== runtime: node --test deploy/pterodactyl/staging + runtime-v8 =="
  # deploy/pterodactyl: the suites under test.
  # contracts: without this, the runtime-v8 tool-contract parity tests fail
  #   even though nothing is actually wrong (they can't find their fixture).
  # .devcontainer + the repo-root compose/.env/.gitignore/.dockerignore files:
  #   read directly by local-compose-secret-boundary.test.mjs.
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$(pwd -W)/deploy/pterodactyl:/src/deploy/pterodactyl" \
    -v "$(pwd -W)/contracts:/src/contracts:ro" \
    -v "$(pwd -W)/.devcontainer:/src/.devcontainer:ro" \
    -v "$(pwd -W)/compose.devcontainer.yml:/src/compose.devcontainer.yml:ro" \
    -v "$(pwd -W)/compose.yml:/src/compose.yml:ro" \
    -v "$(pwd -W)/compose.e2e.yml:/src/compose.e2e.yml:ro" \
    -v "$(pwd -W)/compose.desktop-operator.yml:/src/compose.desktop-operator.yml:ro" \
    -v "$(pwd -W)/.env.example:/src/.env.example:ro" \
    -v "$(pwd -W)/.gitignore:/src/.gitignore:ro" \
    -v "$(pwd -W)/.dockerignore:/src/.dockerignore:ro" \
    npc-dev sh -c "node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs"
}

run_mod() {
  echo "== mod: autorio vitest + tsc --noEmit + Lua build + check-generated-lua =="
  MSYS_NO_PATHCONV=1 docker run --rm \
    -v "$(pwd -W)/packages/autorio/src:/src/packages/autorio/src:ro" \
    npc-dev sh -c "cd packages/autorio && npx vitest run && npx tsc --noEmit -p . && pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build >/dev/null && pnpm run build && node scripts/check-generated-lua.mjs"
}

case "$cmd" in
  runtime)
    run_runtime
    ;;
  mod)
    run_mod
    ;;
  all)
    run_runtime
    run_mod
    ;;
  *)
    usage
    ;;
esac
