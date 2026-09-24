#!/usr/bin/env bash
# Run the provider-backed Compose stack (compose.yml + compose.e2e.yml) inside a
# sandboxed cloud container such as Claude Code on the web, for guided or
# autonomous provider trials against real Factorio.
#
# Usage: scripts/stack-cloud.sh <command>
#   build          build factorio-npc:local from a pushed source revision
#   up             start the stack (builds first if the image is missing)
#   goal <text>    send "!luna <text>" to the server console over RCON
#   rcon <cmd>     send one raw RCON command (operator/debug use only)
#   logs           follow the Factorio/runtime container log
#   down           stop the stack (data stays in SGLUNA_DATA_DIR)
#
# Configuration comes from the gitignored repo-root .env, created from
# .env.cloud.example on first use with a generated FACTORIO_RCON_PASSWORD.
# Compose loads it automatically; variables exported in the shell or set as
# cloud-environment variables override it. `up` requires:
#   OPENAI_API_KEY, OPENAI_API_BASEURL, OPENAI_MODEL   main LLM
#   JEV_TYPESAFE_API_KEY                               Jev decision provider
#   FACTORIO_RCON_PASSWORD                             local RCON secret
# This script never writes secrets. Optional:
#   STACK_SOURCE_REF   40-char commit SHA or pushed ref the image installs
#                      (default: this checkout's HEAD, which must be pushed)
#   FACTORIO_VERSION   headless version (default: 2.0.77, matching tests/factorio)
#   SGLUNA_DATA_DIR    host data dir (default: ./test-results/stack-data)
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=factorio-npc:local
ENV_FILE="$ROOT/.env"
PROJECT=factorio-npc-cloud

CLOUD_LOG_TAG=stack-cloud
# shellcheck source=lib/cloud-docker.sh
source "$ROOT/scripts/lib/cloud-docker.sh"
log() { cloud_log "$@"; }

source_ref() {
  if [[ -n "${STACK_SOURCE_REF:-}" ]]; then
    printf '%s' "$STACK_SOURCE_REF"
    return
  fi
  local head
  head="$(git -C "$ROOT" rev-parse HEAD)"
  git -C "$ROOT" fetch -q origin 2>/dev/null || true
  if [[ -z "$(git -C "$ROOT" branch -r --contains "$head" 2>/dev/null)" ]]; then
    log "HEAD $head is not on any origin branch; push it first or set STACK_SOURCE_REF"
    exit 1
  fi
  printf '%s' "$head"
}

build() {
  local ref
  ref="$(source_ref)"
  log "image installs source $ref (runtime supervisor overridden from this checkout)"
  cloud_docker_build "$ROOT/deploy/docker/Dockerfile" "$ROOT" "$IMAGE" \
    --build-arg "SGLUNA_SOURCE_REF=$ref" \
    --build-arg "FACTORIO_VERSION=$(setting FACTORIO_VERSION 2.0.77)" \
    --build-arg "SGLUNA_LOCAL_RUNTIME_OVERRIDE=1"
}

# setting NAME [default]: the exported value, else the .env value, else default.
setting() {
  local name="$1" fallback="${2:-}" value
  if [[ -n "${!name:-}" ]]; then
    printf '%s' "${!name}"
    return
  fi
  if [[ -f "$ENV_FILE" ]]; then
    value="$(sed -n "s/^${name}=//p" "$ENV_FILE" | tail -1)"
    value="${value%\"}"; value="${value#\"}"; value="${value%\'}"; value="${value#\'}"
    [[ -n "$value" ]] && { printf '%s' "$value"; return; }
  fi
  printf '%s' "$fallback"
}

data_dir() {
  local dir
  dir="$(setting SGLUNA_DATA_DIR ./test-results/stack-data)"
  [[ "$dir" == /* ]] || dir="$ROOT/${dir#./}"
  printf '%s' "$dir"
}

# A fresh cloud session has no .env (it is gitignored), so recreate it from the
# committed non-secret template. Never overwrites an existing .env.
ensure_env_file() {
  [[ -f "$ENV_FILE" ]] && return
  local password
  password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
  (umask 077; sed "s/^FACTORIO_RCON_PASSWORD=\$/FACTORIO_RCON_PASSWORD=$password/" \
    "$ROOT/.env.cloud.example" >"$ENV_FILE")
  log "created $ENV_FILE from .env.cloud.example; fill in the provider keys there or as environment variables"
}

REQUIRED=(OPENAI_API_KEY OPENAI_API_BASEURL OPENAI_MODEL JEV_TYPESAFE_API_KEY FACTORIO_RCON_PASSWORD)

require_settings() {
  local missing=() name
  for name in "${REQUIRED[@]}"; do
    [[ -n "$(setting "$name")" ]] || missing+=("$name")
  done
  if (( ${#missing[@]} )); then
    log "missing settings (fill them in .env or set them as environment variables): ${missing[*]}"
    exit 1
  fi
}

compose() {
  docker compose -p "$PROJECT" --project-directory "$ROOT" \
    -f "$ROOT/compose.yml" -f "$ROOT/compose.e2e.yml" "$@"
}

# logs/down must work before secrets are filled in; Compose still interpolates
# the required variables, so give only the missing ones an inert placeholder.
compose_without_secrets() {
  local placeholders=() name
  for name in "${REQUIRED[@]}"; do
    [[ -n "$(setting "$name")" ]] || placeholders+=("$name=unset")
  done
  env "${placeholders[@]}" docker compose -p "$PROJECT" --project-directory "$ROOT" \
    -f "$ROOT/compose.yml" -f "$ROOT/compose.e2e.yml" "$@"
}

rcon() {
  local port
  port="$(setting SGLUNA_RCON_HOST_PORT 27015)"
  RCON_PASSWORD="$(setting FACTORIO_RCON_PASSWORD)" python3 - "$port" "$*" <<'PY'
import os, socket, struct, sys

port, command = int(sys.argv[1]), sys.argv[2]

def send(sock, request_id, kind, body):
    payload = struct.pack('<ii', request_id, kind) + body.encode() + b'\x00\x00'
    sock.sendall(struct.pack('<i', len(payload)) + payload)

def receive(sock):
    size = struct.unpack('<i', sock.recv(4, socket.MSG_WAITALL))[0]
    data = sock.recv(size, socket.MSG_WAITALL)
    return struct.unpack('<i', data[:4])[0], data[8:-2].decode(errors='replace')

with socket.create_connection(('127.0.0.1', port), timeout=30) as sock:
    send(sock, 1, 3, os.environ['RCON_PASSWORD'])
    if receive(sock)[0] == -1:
        sys.exit('RCON authentication failed')
    send(sock, 2, 2, command)
    print(receive(sock)[1])
PY
}

ensure_env_file

case "${1:-}" in
  build)
    ensure_dockerd
    build
    ;;
  up)
    require_settings
    ensure_dockerd
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    mkdir -p "$(data_dir)"
    compose up -d --no-build sgluna-factorio
    log "stack started; data in $(data_dir). Next: scripts/stack-cloud.sh logs"
    ;;
  goal)
    shift
    [[ $# -gt 0 ]] || { log 'usage: goal <text>'; exit 2; }
    rcon "!luna $*"
    ;;
  rcon)
    shift
    rcon "$@"
    ;;
  logs)
    compose_without_secrets logs -f --tail=200 sgluna-factorio
    ;;
  down)
    compose_without_secrets down
    ;;
  *)
    sed -n '2,24p' "$0"
    exit 2
    ;;
esac
