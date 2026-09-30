#!/usr/bin/env bash
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${PTERODACTYL_IMAGE:-ghcr.io/ptero-eggs/yolks:debian_bookworm}"
FACTORIO_SMOKE_VERSION="${FACTORIO_SMOKE_VERSION:-2.0.77}"
SMOKE_SOURCE_REF="${SGLUNA_SMOKE_SOURCE_REF:-${AIRI_SMOKE_SOURCE_REF:-}}"
ROOT="$(mktemp -d)"
NAME="sgluna-ptero-smoke-$RANDOM-$$"
LOG="$ROOT/runtime.log"
EGG_INSTALL="$ROOT/egg-install.sh"

cleanup() {
  local code=$?
  trap - EXIT
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [[ -d "$ROOT" ]]; then
    docker run --rm \
      -v "$ROOT:/mnt/server" \
      "$IMAGE" \
      bash -c 'chmod -R a+rwX /mnt/server 2>/dev/null || true' \
      >/dev/null 2>&1 || true
    rm -rf -- "$ROOT" || true
  fi
  exit "$code"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo '[pterodactyl-smoke] docker is required' >&2; exit 1; }
command -v node >/dev/null || { echo '[pterodactyl-smoke] node is required to parse the committed egg' >&2; exit 1; }
[[ -f "$HERE/install.sh" ]] || { echo '[pterodactyl-smoke] generated install.sh is missing' >&2; exit 1; }
[[ -f "$HERE/egg-sgluna-factorio-server.json" ]] || { echo '[pterodactyl-smoke] generated egg is missing' >&2; exit 1; }

SOURCE_ENV_ARGS=()
if [[ -n "$SMOKE_SOURCE_REF" ]]; then
  [[ "$SMOKE_SOURCE_REF" =~ ^[a-f0-9]{40}$ ]] || { echo '[pterodactyl-smoke] SGLUNA_SMOKE_SOURCE_REF must be an exact 40-character commit SHA' >&2; exit 1; }
  SOURCE_ENV_ARGS=(-e "SGLUNA_SOURCE_REF=$SMOKE_SOURCE_REF")
fi

chmod 0777 "$ROOT"
echo '[pterodactyl-smoke] Verifying generated artifacts.'
node "$HERE/build-payload.mjs" --check

echo '[pterodactyl-smoke] Extracting the committed egg installation script.'
node --input-type=module - "$HERE/egg-sgluna-factorio-server.json" "$EGG_INSTALL" <<'NODE'
import fs from 'node:fs'
const [, , eggPath, outPath] = process.argv
const egg = JSON.parse(fs.readFileSync(eggPath, 'utf8'))
const script = egg?.scripts?.installation?.script
if (typeof script !== 'string' || script.length === 0) throw new Error('egg installation script is missing')
fs.writeFileSync(outPath, script)
NODE
chmod 755 "$EGG_INSTALL"

echo '[pterodactyl-smoke] Verifying standalone generated bootstrap payload.'
docker run --rm \
  -v "$HERE/install.sh:/tmp/install.sh:ro" \
  -v "$ROOT:/mnt/server" \
  -e SGLUNA_INSTALL_ROOT=/mnt/server \
  "$IMAGE" \
  bash /tmp/install.sh --verify-only

echo '[pterodactyl-smoke] Performing clean installation through the egg loader.'
docker run --rm \
  -v "$EGG_INSTALL:/tmp/egg-install.sh:ro" \
  -v "$ROOT:/mnt/server" \
  -e SGLUNA_INSTALL_ROOT=/mnt/server \
  -e SGLUNA_ACTOR_MODE=npc \
  -e SGLUNA_CHAT_PLAYERS=SmokeOperator \
  -e FACTORIO_VERSION="$FACTORIO_SMOKE_VERSION" \
  "${SOURCE_ENV_ARGS[@]}" \
  "$IMAGE" \
  bash /tmp/egg-install.sh

echo '[pterodactyl-smoke] Verifying installed artifacts inside the install container.'
docker run --rm \
  -v "$ROOT:/mnt/server" \
  "$IMAGE" \
  bash -ceu '
    [[ -L /mnt/server/start-sgluna.sh ]] || { echo "[pterodactyl-smoke] installer did not activate start-sgluna.sh" >&2; exit 1; }
    [[ "$(readlink -- /mnt/server/start-airi.sh)" == start-sgluna.sh ]] || { echo "[pterodactyl-smoke] legacy startup alias is missing" >&2; exit 1; }
    [[ -x /mnt/server/rollback-sgluna.sh ]] || { echo "[pterodactyl-smoke] rollback helper is missing" >&2; exit 1; }
    [[ "$(readlink -- /mnt/server/rollback-airi.sh)" == rollback-sgluna.sh ]] || { echo "[pterodactyl-smoke] legacy rollback alias is missing" >&2; exit 1; }
    [[ -s /mnt/server/client-mods/autorio_0.1.0.zip ]] || { echo "[pterodactyl-smoke] managed client mod is missing from client-mods/" >&2; exit 1; }
    [[ -s /mnt/server/client-mods/SHA256SUMS ]] || { echo "[pterodactyl-smoke] managed client mod checksum is missing" >&2; exit 1; }
    [[ ! -e /mnt/server/autorio_0.1.0.zip ]] || { echo "[pterodactyl-smoke] legacy root client mod should have been removed" >&2; exit 1; }
    [[ -s /mnt/server/sgluna-config.json ]] || { echo "[pterodactyl-smoke] airi-config.json is missing" >&2; exit 1; }
    [[ -s /mnt/server/README-SGLUNA.txt ]] || { echo "[pterodactyl-smoke] README-SGLUNA.txt is missing" >&2; exit 1; }
    [[ -d /mnt/server/mods && -d /mnt/server/saves ]] || { echo "[pterodactyl-smoke] operator mod/save directories are missing" >&2; exit 1; }
    ! grep -q "smoke-secret" /mnt/server/sgluna-config.json || { echo "[pterodactyl-smoke] provider secret leaked to airi-config.json" >&2; exit 1; }
    target="$(readlink -- /mnt/server/start-sgluna.sh)"
    [[ "$target" == .sgluna/releases/*/start-sgluna.sh ]] || { echo "[pterodactyl-smoke] unexpected startup target: $target" >&2; exit 1; }
    [[ -s "/mnt/server/${target%/start-sgluna.sh}/manifest.json" ]] || { echo "[pterodactyl-smoke] release manifest is missing" >&2; exit 1; }
  '

echo '[pterodactyl-smoke] Starting packaged runtime with zero connected players.'
docker run -d --name "$NAME" \
  -v "$ROOT:/home/container" \
  -e CONTAINER_ROOT=/home/container \
  -e SGLUNA_ACTOR_MODE=npc \
  -e OPENAI_API_KEY=smoke-secret \
  -e OPENAI_MODEL=smoke-model \
  -e OPENAI_API_BASEURL=https://api.example.invalid/v1 \
  -e SERVER_PORT=34197 \
  "$IMAGE" \
  bash ./start-sgluna.sh >/dev/null

ready=0
for _ in $(seq 1 180); do
  docker logs "$NAME" > "$LOG" 2>&1 || true
  if grep -q 'SGLuna Factorio ready;' "$LOG"; then
    ready=1
    break
  fi
  if [[ "$(docker inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null || echo false)" != true ]]; then
    cat "$LOG" >&2
    echo '[pterodactyl-smoke] runtime exited before readiness' >&2
    exit 1
  fi
  sleep 1
done

if [[ "$ready" != 1 ]]; then
  cat "$LOG" >&2
  echo '[pterodactyl-smoke] timed out waiting for standalone-NPC readiness' >&2
  exit 1
fi

echo '[pterodactyl-smoke] Standalone NPC is ready; requesting graceful save/stop.'
docker stop --signal=SIGINT --time=60 "$NAME" >/dev/null
docker logs "$NAME" > "$LOG" 2>&1 || true
cat "$LOG"
grep -q 'Requesting Factorio graceful /quit shutdown' "$LOG" || { echo '[pterodactyl-smoke] supervisor did not request Factorio /quit' >&2; exit 1; }
grep -q 'Goodbye' "$LOG" || { echo '[pterodactyl-smoke] Factorio clean Goodbye shutdown marker missing' >&2; exit 1; }
grep -q 'SGLuna Factorio stopped cleanly' "$LOG" || { echo '[pterodactyl-smoke] clean shutdown acknowledgement missing' >&2; exit 1; }
docker run --rm \
  -v "$ROOT:/mnt/server" \
  "$IMAGE" \
  bash -ceu 'find /mnt/server/saves -maxdepth 1 -type f -name "*.zip" -size +0c -print -quit | grep -q .' \
  || { echo '[pterodactyl-smoke] no saved Factorio world was produced' >&2; exit 1; }

echo '[pterodactyl-smoke] PASS: generated PTDL_v2 egg installed, started a zero-player standalone NPC, Factorio said Goodbye after /quit, saved, and stopped cleanly.'
