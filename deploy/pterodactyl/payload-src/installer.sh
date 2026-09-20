#!/usr/bin/env bash
# SGLuna Factorio Pterodactyl v8 standalone-NPC installer.
# Install/runtime image: ghcr.io/ptero-eggs/yolks:debian_bookworm
set -Eeuo pipefail
umask 077

if [[ -n "${SGLUNA_INSTALL_ROOT:-}" ]]; then
  SERVER_DIR="$SGLUNA_INSTALL_ROOT"
elif [[ -n "${AIRI_INSTALL_ROOT:-}" ]]; then
  SERVER_DIR="$AIRI_INSTALL_ROOT"
else
  SERVER_DIR="/mnt/server"
fi
NODE_VERSION="v24.21.0"
PNPM_VERSION="10.30.1"
AIRI_REF="ad3e87523b157880a360e773de68519e49f809f0"
REVISION="2026-09-14.22"
DEPLOYMENT_REVISION="airi-deploy-v8-npc-staging"
WORK=""

log() { printf '[SGLuna install] %s\n' "$*"; }
fail() { log "ERROR: $*" >&2; exit 1; }

if [[ -n "${SGLUNA_INSTALL_ROOT:-}" && -n "${AIRI_INSTALL_ROOT:-}" && "$SGLUNA_INSTALL_ROOT" != "$AIRI_INSTALL_ROOT" ]]; then
  log 'Compatibility warning: SGLUNA_INSTALL_ROOT overrides conflicting AIRI_INSTALL_ROOT.'
fi
if [[ -n "${SGLUNA_ACTOR_MODE+x}" ]]; then
  EFFECTIVE_ACTOR_MODE="$SGLUNA_ACTOR_MODE"
elif [[ -n "${AIRI_ACTOR_MODE+x}" ]]; then
  EFFECTIVE_ACTOR_MODE="$AIRI_ACTOR_MODE"
else
  EFFECTIVE_ACTOR_MODE="npc"
fi
if [[ -n "${SGLUNA_ACTOR_MODE:-}" && -n "${AIRI_ACTOR_MODE:-}" && "$SGLUNA_ACTOR_MODE" != "$AIRI_ACTOR_MODE" ]]; then
  log 'Compatibility warning: SGLUNA_ACTOR_MODE overrides conflicting AIRI_ACTOR_MODE.'
fi
if [[ -n "${SGLUNA_CHAT_PLAYERS:-}" && -n "${AIRI_CHAT_PLAYERS:-}" && "$SGLUNA_CHAT_PLAYERS" != "$AIRI_CHAT_PLAYERS" ]]; then
  log 'Compatibility warning: SGLUNA_CHAT_PLAYERS overrides conflicting AIRI_CHAT_PLAYERS.'
fi
[[ "$EFFECTIVE_ACTOR_MODE" == "npc" ]] || fail 'v8 egg currently requires SGLUNA_ACTOR_MODE=npc'
export SGLUNA_ACTOR_MODE="$EFFECTIVE_ACTOR_MODE"
export AIRI_ACTOR_MODE="$EFFECTIVE_ACTOR_MODE"
cleanup() {
  local code=$?
  trap - EXIT
  if [[ -n "$WORK" && -d "$WORK" ]]; then rm -rf -- "$WORK"; fi
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
trap 'log "Failed at installer line $LINENO. Existing completed release was retained." >&2' ERR

[[ "$(uname -m)" == x86_64 ]] || fail 'An amd64 Wings node is required'
for tool in bash curl tar gzip xz awk grep sha256sum mktemp readlink flock cp mv rm chmod ln df tr basename getconf zip; do
  command -v "$tool" >/dev/null || fail "Missing installer tool: $tool; use the Bookworm image"
done
GLIBC="$(getconf GNU_LIBC_VERSION | awk '{print $2}')"
[[ "$GLIBC" =~ ^([0-9]+)\.([0-9]+)$ ]] || fail 'Unable to identify installer glibc'
(( BASH_REMATCH[1] > 2 || (BASH_REMATCH[1] == 2 && BASH_REMATCH[2] >= 36) )) || fail 'Bookworm/glibc 2.36+ is required'

mkdir -p "$SERVER_DIR"
SERVER_DIR="$(readlink -f -- "$SERVER_DIR")"
[[ "$SERVER_DIR" != / ]] || fail 'The server root cannot be /'
[[ ! -L "$SERVER_DIR/.airi" ]] || fail '.airi cannot be a symlink'
mkdir -p "$SERVER_DIR/.airi/releases"
[[ ! -L "$SERVER_DIR/.airi/releases" && ! -L "$SERVER_DIR/.airi/operation.lock" ]] || fail 'Managed SGLuna compatibility-state paths cannot be symlinks'
exec 9>"$SERVER_DIR/.airi/operation.lock"
flock -n 9 || fail 'Another SGLuna installer/runtime owns this server volume'

if [[ ! -e "$SERVER_DIR/start-sgluna.sh" && ! -L "$SERVER_DIR/start-sgluna.sh" ]]; then
  if [[ -L "$SERVER_DIR/start-airi.sh" ]]; then
    LEGACY_START_TARGET="$(readlink -- "$SERVER_DIR/start-airi.sh")"
    [[ "$LEGACY_START_TARGET" == .airi/releases/*/start-airi.sh || "$LEGACY_START_TARGET" == .airi/releases/*/start-sgluna.sh ]] || fail 'Existing AIRI compatibility startup symlink has an unexpected target'
    ln -s "$LEGACY_START_TARGET" "$SERVER_DIR/.start-sgluna-compat.new"
    mv -Tf "$SERVER_DIR/.start-sgluna-compat.new" "$SERVER_DIR/start-sgluna.sh"
    log 'Mapped the legacy active startup target onto canonical start-sgluna.sh before reinstall.'
  elif [[ -f "$SERVER_DIR/start-airi.sh" ]]; then
    cat > "$SERVER_DIR/start-sgluna.sh" <<'START_SGLUNA_COMPAT'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/start-airi.sh" "$@"
START_SGLUNA_COMPAT
    chmod 755 "$SERVER_DIR/start-sgluna.sh"
    log 'Created a temporary SGLuna startup wrapper for the legacy startup helper before reinstall.'
  else
    printf '#!/bin/bash\necho "[SGLuna] No completed installation is active" >&2\nexit 78\n' > "$SERVER_DIR/start-sgluna.sh"
    chmod 755 "$SERVER_DIR/start-sgluna.sh"
  fi
fi

WORK="$(mktemp -d "$SERVER_DIR/.airi/install.XXXXXX")"
APP="$WORK/app"
mkdir -p "$APP/src/runtime-v8" "$APP/src/staging" "$APP/autorio" "$APP/factorio" "$APP/client-mod" "$WORK/tmp" "$WORK/home" "$WORK/cache" "$WORK/npm-cache"
export HOME="$WORK/home" TMPDIR="$WORK/tmp" XDG_CACHE_HOME="$WORK/cache" NPM_CONFIG_CACHE="$WORK/npm-cache"
unset OPENAI_API_KEY OPENAI_API_BASEURL FACTORIO_RCON_PASSWORD RCON_PASSWORD SERVER_TOKEN FACTORIO_TOKEN NODE_OPTIONS NODE_PATH || true
export NODE_TLS_REJECT_UNAUTHORIZED=1

fetch() {
  curl --fail --location --retry 3 --connect-timeout 20 --max-time 900 --proto '=https' --proto-redir '=https' "$1" --output "$2"
}

log "Installer revision $REVISION; source $AIRI_REF"
FREE_KB="$(df -Pk "$SERVER_DIR" | awk 'END {print $4}')"
[[ "$FREE_KB" =~ ^[0-9]+$ ]] && (( FREE_KB >= 4194304 )) || fail 'At least 4 GiB free space is required for transactional installation'

log "Downloading Node $NODE_VERSION"
NODE_ARCHIVE="node-${NODE_VERSION}-linux-x64.tar.gz"
fetch "https://nodejs.org/dist/${NODE_VERSION}/${NODE_ARCHIVE}" "$WORK/$NODE_ARCHIVE"
fetch "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
NODE_HASH="$(awk -v name="$NODE_ARCHIVE" '$2==name {print $1}' "$WORK/SHASUMS256.txt")"
[[ "$NODE_HASH" =~ ^[a-f0-9]{64}$ ]] || fail 'Missing or ambiguous Node checksum'
printf '%s  %s\n' "$NODE_HASH" "$NODE_ARCHIVE" | (cd "$WORK" && sha256sum -c -)
mkdir -p "$APP/node"
tar -xzf "$WORK/$NODE_ARCHIVE" --strip-components=1 --no-same-owner -C "$APP/node"
export PATH="$APP/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ "$(node --version)" == "$NODE_VERSION" ]] || fail 'Portable Node verification failed'
node "$APP/node/lib/node_modules/npm/bin/npm-cli.js" install --global --prefix "$WORK/build-tools" --ignore-scripts --no-audit --no-fund "pnpm@$PNPM_VERSION"
export PATH="$WORK/build-tools/bin:$PATH"
[[ "$(pnpm --version)" == "$PNPM_VERSION" ]] || fail 'pnpm verification failed'

log 'Downloading pinned Factorio NPC source'
fetch "https://codeload.github.com/TTLouis/factorio-npc/tar.gz/$AIRI_REF" "$WORK/airi-source.tar.gz"
mkdir -p "$WORK/source"
tar -xzf "$WORK/airi-source.tar.gz" --strip-components=1 --no-same-owner -C "$WORK/source"
[[ -f "$WORK/source/pnpm-lock.yaml" ]] || fail 'Pinned source lockfile is missing'
[[ -f "$WORK/source/deploy/pterodactyl/staging/guard.ts" ]] || fail 'Pinned source lacks the v8 NPC guard'
[[ -f "$WORK/source/deploy/pterodactyl/runtime-v8/supervisor.mjs" ]] || fail 'Pinned source lacks the v8 runtime supervisor'
[[ -f "$WORK/source/deploy/pterodactyl/runtime-v8/outcome-authority.mjs" ]] || fail 'Pinned source lacks the runtime outcome authority module'
[[ -f "$WORK/source/deploy/pterodactyl/runtime-v8/recovery-route.mjs" ]] || fail 'Pinned source lacks the runtime recovery router module'

# Full staging/runtime and Autorio test suites run in GitHub CI. Reinstall should
# remain a bounded deployment path, not a second CI runner inside Pterodactyl.
log 'Installing the Autorio build graph for deployment'
(
  cd "$WORK/source"
  NODE_ENV=development pnpm install --filter 'autorio.ts...' --frozen-lockfile --ignore-scripts --store-dir "$WORK/pnpm-store" --package-import-method=copy
  pnpm --filter @proj-airi/tstl-plugin-reload-factorio-mod run build
)

log 'Preparing native actor-aware Autorio source and compiling the deployment guard'
node "$WORK/source/deploy/pterodactyl/staging/source-preparer.mjs" \
  "$WORK/source" \
  "$WORK/source/deploy/pterodactyl/staging/guard.ts" \
  > "$WORK/source-preparation.json"
grep -q 'native-actor-aware-autorio' "$WORK/source-preparation.json" || fail 'Native NPC source preparation did not confirm its contract'
(
  cd "$WORK/source"
  pnpm --filter autorio.ts run typecheck
  pnpm --filter autorio.ts run build
)
[[ -s "$WORK/source/packages/autorio/dist/control.lua" ]] || fail 'Lua compilation did not emit control.lua'
[[ -s "$WORK/source/packages/autorio/dist/data.lua" ]] || fail 'Lua packaging did not emit data.lua'
cp "$WORK/source/packages/autorio/info.json" "$WORK/source/packages/autorio/dist/info.json"
cp -a "$WORK/source/packages/autorio/dist/." "$APP/autorio/"

log 'Copying v8 supervisor, shared policy, and prompt'
for file in common.mjs canonical-task-board-memory.mjs planning-state.mjs game-files.mjs provider-base.mjs provider.mjs supervisor.mjs structured-policy.mjs supervisor-adapter.mjs outcome-authority.mjs recovery-route.mjs step-completion.mjs jev-decision-taxonomy.mjs npc-agent-loop.mjs; do
  cp "$WORK/source/deploy/pterodactyl/runtime-v8/$file" "$APP/src/runtime-v8/$file"
done
for file in structured-policy.mjs supervisor-adapter.mjs npc-agent-loop.mjs; do
  cp "$WORK/source/deploy/pterodactyl/staging/$file" "$APP/src/staging/$file"
done
cp "$WORK/source/packages/agent/src/llm/prompt.md" "$APP/src/prompt.md"
cp "$WORK/source/LICENSE" "$APP/UPSTREAM-LICENSE"
for file in "$APP/src/runtime-v8/"*.mjs "$APP/src/staging/"*.mjs; do node --check "$file"; done
AIRI_SUPERVISOR_VERIFY="$APP/src/runtime-v8/supervisor.mjs" node --input-type=module <<'VERIFY_RUNTIME_IMPORTS'
import { pathToFileURL } from 'node:url'
await import(pathToFileURL(process.env.AIRI_SUPERVISOR_VERIFY).href)
VERIFY_RUNTIME_IMPORTS

FACTORIO_REQUEST="${FACTORIO_VERSION:-latest}"
if [[ "$FACTORIO_REQUEST" == latest || "$FACTORIO_REQUEST" == experimental ]]; then
  FACTORIO_TARGET="$(FACTORIO_REQUEST="$FACTORIO_REQUEST" node --input-type=module <<'NODE'
const request = process.env.FACTORIO_REQUEST
const response = await fetch('https://factorio.com/api/latest-releases', { redirect: 'error', signal: AbortSignal.timeout(15000) })
if (!response.ok) throw new Error(`release API HTTP ${response.status}`)
const data = await response.json()
const version = data?.[request === 'latest' ? 'stable' : 'experimental']?.headless
if (typeof version !== 'string' || !/^2\.0\.\d+$/.test(version)) throw new Error('unsupported Factorio release')
process.stdout.write(version)
NODE
)" || fail 'Unable to resolve requested Factorio release'
else
  [[ "$FACTORIO_REQUEST" =~ ^2\.0\.[0-9]+$ ]] || fail 'FACTORIO_VERSION must be latest, experimental, or an exact 2.0.x release'
  FACTORIO_TARGET="$FACTORIO_REQUEST"
fi

log "Downloading Factorio headless $FACTORIO_TARGET"
FACTORIO_ARCHIVE="factorio-headless_linux_${FACTORIO_TARGET}.tar.xz"
fetch "https://www.factorio.com/get-download/${FACTORIO_TARGET}/headless/linux64" "$WORK/$FACTORIO_ARCHIVE"
fetch "https://factorio.com/download/sha256sums/" "$WORK/factorio-sha256sums.txt"
FACTORIO_HASH="$(awk -v name="$FACTORIO_ARCHIVE" '$2==name {print $1}' "$WORK/factorio-sha256sums.txt")"
[[ "$FACTORIO_HASH" =~ ^[a-f0-9]{64}$ ]] || fail 'Official Factorio checksum is missing or ambiguous'
printf '%s  %s\n' "$FACTORIO_HASH" "$FACTORIO_ARCHIVE" | (cd "$WORK" && sha256sum -c -)
xz -t "$WORK/$FACTORIO_ARCHIVE"
while IFS= read -r name; do
  [[ "$name" == factorio/* && "$name" != *'..'* && "$name" != *'\\'* ]] || fail "Unsafe Factorio archive path: $name"
done < <(tar -tJf "$WORK/$FACTORIO_ARCHIVE")
while IFS= read -r line; do
  [[ "${line:0:1}" == '-' || "${line:0:1}" == 'd' ]] || fail 'Factorio archive contains a link or special file'
done < <(tar -tvJf "$WORK/$FACTORIO_ARCHIVE")
tar -xJf "$WORK/$FACTORIO_ARCHIVE" --strip-components=1 --no-same-owner --no-same-permissions -C "$APP/factorio"
[[ "$($APP/factorio/bin/x64/factorio --version | awk '/Version:/ {print $2; exit}')" == "$FACTORIO_TARGET" ]] || fail 'Factorio executable version mismatch'

log 'Packaging the exact managed Autorio client mod'
mkdir -p "$WORK/client-mod/autorio_0.1.0"
cp -a "$APP/autorio/." "$WORK/client-mod/autorio_0.1.0/"
(cd "$WORK/client-mod" && zip -qr "$APP/client-mod/autorio_0.1.0.zip" autorio_0.1.0)
(cd "$APP/client-mod" && sha256sum autorio_0.1.0.zip > SHA256SUMS)

cat > "$APP/start-sgluna.sh" <<'START_SGLUNA'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${CONTAINER_ROOT:-/home/container}"
ROOT="$(readlink -f -- "$ROOT")"
SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
APP="$(dirname -- "$SELF")"
[[ -d "$ROOT/.airi" && ! -L "$ROOT/.airi" ]] || { echo '[SGLuna] Missing managed state directory' >&2; exit 78; }
exec 9>"$ROOT/.airi/operation.lock"
flock -n 9 || { echo '[SGLuna] Another SGLuna install/runtime owns this server volume' >&2; exit 73; }
unset NODE_OPTIONS NODE_PATH
export NODE_TLS_REJECT_UNAUTHORIZED=1
export HOME="$ROOT" CONTAINER_ROOT="$ROOT"
export PATH="$APP/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
export TMPDIR="$ROOT/.airi/tmp"
mkdir -p "$TMPDIR"
cd "$ROOT"
exec "$APP/node/bin/node" "$APP/src/runtime-v8/supervisor.mjs"
START_SGLUNA
chmod 755 "$APP/start-sgluna.sh"

log 'Writing checksummed release manifest'
APP_ROOT="$APP" AIRI_REF_VALUE="$AIRI_REF" RELEASE_REVISION_VALUE="$REVISION" FACTORIO_TARGET_VALUE="$FACTORIO_TARGET" node --input-type=module <<'MANIFEST'
import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
const root = process.env.APP_ROOT
const names = [
  'start-sgluna.sh',
  'src/prompt.md',
  'src/runtime-v8/common.mjs',
  'src/runtime-v8/canonical-task-board-memory.mjs',
  'src/runtime-v8/planning-state.mjs',
  'src/runtime-v8/game-files.mjs',
  'src/runtime-v8/provider-base.mjs',
  'src/runtime-v8/provider.mjs',
  'src/runtime-v8/supervisor.mjs',
  'src/runtime-v8/structured-policy.mjs',
  'src/runtime-v8/supervisor-adapter.mjs',
  'src/runtime-v8/outcome-authority.mjs',
  'src/runtime-v8/recovery-route.mjs',
  'src/runtime-v8/step-completion.mjs',
  'src/runtime-v8/jev-decision-taxonomy.mjs',
  'src/runtime-v8/npc-agent-loop.mjs',
  'src/staging/structured-policy.mjs',
  'src/staging/supervisor-adapter.mjs',
  'src/staging/npc-agent-loop.mjs',
  'autorio/control.lua',
  'autorio/data.lua',
  'autorio/info.json',
  'factorio/bin/x64/factorio',
]
const files = {}
for (const name of names) {
  const bytes = await fs.readFile(path.join(root, name))
  files[name] = crypto.createHash('sha256').update(bytes).digest('hex')
}
await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
  revision: 'airi-pterodactyl-v8',
  releaseRevision: process.env.RELEASE_REVISION_VALUE,
  source: process.env.AIRI_REF_VALUE,
  factorio: process.env.FACTORIO_TARGET_VALUE,
  files,
}, null, 2) + '\n')
MANIFEST

RELEASE_ID="${REVISION}-$(basename "$WORK" | tr . -)"
RELEASE="$SERVER_DIR/.airi/releases/$RELEASE_ID"
[[ ! -e "$RELEASE" ]] || fail 'Release directory collision'
mv "$APP" "$RELEASE"

CLIENT_MOD_DIR="$SERVER_DIR/client-mods"
[[ ! -L "$CLIENT_MOD_DIR" ]] || fail 'client-mods cannot be a symlink'
mkdir -p "$CLIENT_MOD_DIR"
cp "$RELEASE/client-mod/autorio_0.1.0.zip" "$CLIENT_MOD_DIR/autorio_0.1.0.zip"
cp "$RELEASE/client-mod/SHA256SUMS" "$CLIENT_MOD_DIR/SHA256SUMS"
rm -f -- "$SERVER_DIR/autorio_0.1.0.zip"
PREVIOUS_TARGET=""
if [[ -L "$SERVER_DIR/start-sgluna.sh" ]]; then
  PREVIOUS_TARGET="$(readlink -- "$SERVER_DIR/start-sgluna.sh")"
  [[ "$PREVIOUS_TARGET" == .airi/releases/*/start-sgluna.sh || "$PREVIOUS_TARGET" == .airi/releases/*/start-airi.sh ]] || fail 'Existing SGLuna startup symlink has an unexpected target'
elif [[ -L "$SERVER_DIR/start-airi.sh" ]]; then
  PREVIOUS_TARGET="$(readlink -- "$SERVER_DIR/start-airi.sh")"
  [[ "$PREVIOUS_TARGET" == .airi/releases/*/start-airi.sh || "$PREVIOUS_TARGET" == .airi/releases/*/start-sgluna.sh ]] || fail 'Existing AIRI compatibility startup symlink has an unexpected target'
elif [[ -e "$SERVER_DIR/start-sgluna.sh" ]]; then
  [[ -f "$SERVER_DIR/start-sgluna.sh" ]] || fail 'Existing SGLuna startup path is not a regular file or managed symlink'
elif [[ -e "$SERVER_DIR/start-airi.sh" ]]; then
  [[ -f "$SERVER_DIR/start-airi.sh" ]] || fail 'Existing AIRI compatibility startup path is not a regular file or managed symlink'
fi
ln -s ".airi/releases/$RELEASE_ID/start-sgluna.sh" "$SERVER_DIR/.start-sgluna-$RELEASE_ID.new"
mv -Tf "$SERVER_DIR/.start-sgluna-$RELEASE_ID.new" "$SERVER_DIR/start-sgluna.sh"
ln -s "start-sgluna.sh" "$SERVER_DIR/.start-airi-compat.new"
mv -Tf "$SERVER_DIR/.start-airi-compat.new" "$SERVER_DIR/start-airi.sh"
if [[ -n "$PREVIOUS_TARGET" ]]; then
  printf '%s\n' "$PREVIOUS_TARGET" > "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target.tmp"
  mv -Tf "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target.tmp" "$SERVER_DIR/.airi/rollback-$RELEASE_ID.target"
fi
cat > "$SERVER_DIR/rollback-sgluna.sh" <<'ROLLBACK_SGLUNA'
#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="${CONTAINER_ROOT:-/home/container}"
ROOT="$(readlink -f -- "$ROOT")"
LATEST="$(ls -1t "$ROOT"/.airi/rollback-*.target 2>/dev/null | head -n 1 || true)"
[[ -n "$LATEST" && -f "$LATEST" ]] || { echo '[SGLuna rollback] No previous completed release is recorded.' >&2; exit 1; }
TARGET="$(cat "$LATEST")"
[[ ( "$TARGET" == .airi/releases/*/start-sgluna.sh || "$TARGET" == .airi/releases/*/start-airi.sh ) && -f "$ROOT/$TARGET" ]] || { echo '[SGLuna rollback] Recorded previous release is unavailable.' >&2; exit 1; }
ln -s "$TARGET" "$ROOT/.start-sgluna-rollback.new"
mv -Tf "$ROOT/.start-sgluna-rollback.new" "$ROOT/start-sgluna.sh"
ln -s "start-sgluna.sh" "$ROOT/.start-airi-compat.new"
mv -Tf "$ROOT/.start-airi-compat.new" "$ROOT/start-airi.sh"
echo "[SGLuna rollback] Restored startup target: $TARGET"
ROLLBACK_SGLUNA
chmod 755 "$SERVER_DIR/rollback-sgluna.sh"
ln -s "rollback-sgluna.sh" "$SERVER_DIR/.rollback-airi-compat.new"
mv -Tf "$SERVER_DIR/.rollback-airi-compat.new" "$SERVER_DIR/rollback-airi.sh"

SGLUNA_CONFIG_ROOT="$SERVER_DIR" SGLUNA_SUPERVISOR="$RELEASE/src/runtime-v8/supervisor.mjs" "$RELEASE/node/bin/node" --input-type=module <<'CONFIG'
import { pathToFileURL } from 'node:url'
const { migrateCanonicalConfig } = await import(pathToFileURL(process.env.SGLUNA_SUPERVISOR).href)
await migrateCanonicalConfig(process.env.SGLUNA_CONFIG_ROOT)
CONFIG

mkdir -p "$SERVER_DIR/mods" "$SERVER_DIR/saves"
cat > "$SERVER_DIR/README-SGLUNA.txt" <<EOF_SGLUNA
SGLuna Factorio Server
======================

Client mod download: client-mods/autorio_0.1.0.zip
User Factorio mods:   mods/
Saves:                saves/
Effective config:     sgluna-config.json (canonical non-secret runtime config)
Legacy config input:  airi-config.json (read only when canonical config is absent)
Managed runtime:      .airi/ (internal compatibility state; do not edit)
Visibility:           automatic from FACTORIO_USERNAME + FACTORIO_TOKEN
                      both blank = private/hidden; both supplied = public
Installed source:     $AIRI_REF
Installed release:    $REVISION
Startup:              bash ./start-sgluna.sh
EOF_SGLUNA
chmod 644 "$SERVER_DIR/README-SGLUNA.txt"

log "Installation complete: $DEPLOYMENT_REVISION"
log "Pinned source: $AIRI_REF"
log "Factorio: $FACTORIO_TARGET"
log 'Actor ownership: standalone NPC; zero connected humans is valid.'
log 'Client mod download: client-mods/autorio_0.1.0.zip'
log 'Chat command: !luna. Legacy !airi remains accepted as a compatibility alias.'
log 'Preferred chat allowlist: SGLUNA_CHAT_PLAYERS (blank/* = everyone, comma list = allowlist, none = disabled). AIRI_CHAT_PLAYERS remains a fallback.'
log 'Factorio visibility is automatic: set FACTORIO_USERNAME and FACTORIO_TOKEN together for public listing; leave both blank for private/hidden.'
log 'User Factorio mods: mods/'
log 'Managed runtime mods: .airi/run-*/mods/ (internal; do not edit)'
log 'Operator help: README-SGLUNA.txt'
log 'Startup command: bash ./start-sgluna.sh'
exit 0
