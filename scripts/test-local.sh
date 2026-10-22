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
case "$cmd" in runtime|mod|all) ;; *) usage ;; esac
[[ $# -eq 1 ]] || usage

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# Docker Desktop needs Windows paths from Git Bash; native POSIX shells do not
# implement pwd -W. Do not mount the whole checkout (which may contain .env).
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) host_root="$(pwd -W)" ;;
  *) host_root="$root" ;;
esac

run_scope="npc-static-$$-$RANDOM"
cid_dir="$(mktemp -d)"
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) cid_host_dir="$(cd "$cid_dir" && pwd -W)" ;;
  *) cid_host_dir="$cid_dir" ;;
esac
cleanup() {
  local status=$?
  trap - EXIT
  local file cid remaining retain=false
  for file in "$cid_dir"/*.cid; do
    [[ -f "$file" ]] || continue
    cid="$(cat "$file")"
    # --rm normally did this already. A populated cidfile proves ownership even
    # when docker run is interrupted; never remove a container by a guessed name.
    [[ -n "$cid" ]] || continue
    if remaining="$(docker container ls -aq --no-trunc --filter "id=$cid")"; then
      if [[ -n "$remaining" ]]; then
        if ! docker rm -f "$cid" >/dev/null; then
          status=1
          retain=true
        elif ! remaining="$(docker container ls -aq --no-trunc --filter "id=$cid")" || [[ -n "$remaining" ]]; then
          status=1
          retain=true
        fi
      fi
    else
      status=1
      retain=true
    fi
    if [[ "$retain" == true ]]; then
      echo "Cleanup unverified for $cid; recovery: docker rm -f $cid" >&2
    fi
  done
  if [[ "$retain" == true ]]; then
    echo "Retained owned container IDs in $cid_dir" >&2
  else
    rm -rf -- "$cid_dir"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

run_container() {
  local lane="$1"
  shift
  echo "== owned container: $run_scope-$lane (no Compose project) =="
  MSYS_NO_PATHCONV=1 docker run --rm --pull never --network none \
    --name "$run_scope-$lane" --cidfile "$cid_host_dir/$lane.cid" "$@"
}

run_runtime() {
  echo "== runtime: node --test deploy/pterodactyl/staging + runtime-v8 =="
  # deploy/pterodactyl: the suites under test.
  # contracts: without this, the runtime-v8 tool-contract parity tests fail
  #   even though nothing is actually wrong (they can't find their fixture).
  # packages/autorio/src + packages/agent/src: read by the mod/runtime contract
  #   tests (task-board-control-contract, deployed-operation-contract); the
  #   image copy goes stale as soon as those sources change.
  # packages/autorio/data.lua: source-preparer.test.mjs guards the shipped NPC
  #   vision vehicle prototype; the image copy would test a stale prototype.
  # .devcontainer + the repo-root compose/.env/.gitignore/.dockerignore files:
  #   read directly by local-compose-secret-boundary.test.mjs.
  run_container runtime \
    -e UPDATE_RESTAGE_GOLDEN \
    -v "$host_root/deploy/pterodactyl:/src/deploy/pterodactyl" \
    -v "$host_root/contracts:/src/contracts:ro" \
    -v "$host_root/packages/autorio/src:/src/packages/autorio/src:ro" \
    -v "$host_root/packages/autorio/data.lua:/src/packages/autorio/data.lua:ro" \
    -v "$host_root/packages/agent/src:/src/packages/agent/src:ro" \
    -v "$host_root/.devcontainer:/src/.devcontainer:ro" \
    -v "$host_root/compose.devcontainer.yml:/src/compose.devcontainer.yml:ro" \
    -v "$host_root/compose.yml:/src/compose.yml:ro" \
    -v "$host_root/compose.e2e.yml:/src/compose.e2e.yml:ro" \
    -v "$host_root/compose.desktop-operator.yml:/src/compose.desktop-operator.yml:ro" \
    -v "$host_root/.env.example:/src/.env.example:ro" \
    -v "$host_root/.gitignore:/src/.gitignore:ro" \
    -v "$host_root/.dockerignore:/src/.dockerignore:ro" \
    npc-dev sh -c "node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs"
}

run_mod() {
  echo "== mod: autorio vitest + tsc --noEmit + Lua build + check-generated-lua =="
  run_container mod \
    -v "$host_root/packages/autorio/src:/src/packages/autorio/src:ro" \
    -v "$host_root/packages/autorio/data.lua:/src/packages/autorio/data.lua:ro" \
    -v "$host_root/packages/autorio/graphics:/src/packages/autorio/graphics:ro" \
    -v "$host_root/packages/autorio/scripts:/src/packages/autorio/scripts:ro" \
    npc-dev sh -c "cd packages/autorio && npx --no-install vitest run && npx --no-install tsc --noEmit -p . && pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build >/dev/null && pnpm run build && node scripts/check-generated-lua.mjs"
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
