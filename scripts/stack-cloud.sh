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
#   down           stop the stack (data stays in $STACK_DATA_DIR)
#
# Provider secrets are read from the environment only and are never written to
# disk by this script. Configure them as cloud-environment variables (all
# required by `up`; placeholders are used only so logs/down can interpolate):
#   OPENAI_API_KEY, OPENAI_API_BASEURL, OPENAI_MODEL   main LLM
#   JEV_TYPESAFE_API_KEY                               Jev decision provider
# Optional:
#   OPENAI_PROVIDER_PROFILE / other compose.yml variables pass through as usual
#   STACK_SOURCE_REF   40-char commit SHA or pushed ref the image installs
#                      (default: this checkout's HEAD, which must be pushed)
#   STACK_DATA_DIR     host data dir (default: test-results/stack-data)
#   FACTORIO_VERSION   headless version (default: 2.0.77, matching tests/factorio)
#   FACTORIO_RCON_PASSWORD  generated per data dir when unset
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE=factorio-npc:local
DATA_DIR="${STACK_DATA_DIR:-$ROOT/test-results/stack-data}"
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
    --build-arg "FACTORIO_VERSION=${FACTORIO_VERSION:-2.0.77}" \
    --build-arg "SGLUNA_LOCAL_RUNTIME_OVERRIDE=1"
}

rcon_password() {
  if [[ -n "${FACTORIO_RCON_PASSWORD:-}" ]]; then
    printf '%s' "$FACTORIO_RCON_PASSWORD"
    return
  fi
  # Local-only RCON secret for this sandbox; kept beside the data it guards.
  local file="$DATA_DIR/.rcon-password"
  mkdir -p "$DATA_DIR"
  [[ -s "$file" ]] || (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' >"$file")
  cat "$file"
}

compose() {
  FACTORIO_RCON_PASSWORD="$(rcon_password)" \
  SGLUNA_DATA_DIR="$DATA_DIR" \
  SGLUNA_CHAT_PLAYERS="${SGLUNA_CHAT_PLAYERS:-<server>}" \
  OPENAI_API_KEY="${OPENAI_API_KEY:-unset}" \
  OPENAI_API_BASEURL="${OPENAI_API_BASEURL:-https://provider.invalid/v1}" \
  OPENAI_MODEL="${OPENAI_MODEL:-unset}" \
  JEV_TYPESAFE_API_KEY="${JEV_TYPESAFE_API_KEY:-unset}" \
    docker compose -p "$PROJECT" -f "$ROOT/compose.yml" -f "$ROOT/compose.e2e.yml" "$@"
}

require_provider_env() {
  local missing=()
  for name in OPENAI_API_KEY OPENAI_API_BASEURL OPENAI_MODEL JEV_TYPESAFE_API_KEY; do
    [[ -n "${!name:-}" ]] || missing+=("$name")
  done
  if (( ${#missing[@]} )); then
    log "missing cloud-environment variables: ${missing[*]}"
    exit 1
  fi
}

rcon() {
  local port="${SGLUNA_RCON_HOST_PORT:-27015}"
  RCON_PASSWORD="$(rcon_password)" python3 - "$port" "$*" <<'PY'
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

case "${1:-}" in
  build)
    ensure_dockerd
    build
    ;;
  up)
    require_provider_env
    ensure_dockerd
    docker image inspect "$IMAGE" >/dev/null 2>&1 || build
    mkdir -p "$DATA_DIR"
    compose up -d --no-build sgluna-factorio
    log "stack started; data in $DATA_DIR. Next: scripts/stack-cloud.sh logs"
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
    compose logs -f --tail=200 sgluna-factorio
    ;;
  down)
    compose down
    ;;
  *)
    sed -n '2,26p' "$0"
    exit 2
    ;;
esac
