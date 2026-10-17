#!/usr/bin/env bash
# Mount captured save read-only as /input/checkpoint.zip; results writable.
# docker run --network none --entrypoint bash ... saved_layout_steam.sh
set -Eeuo pipefail
mkdir -p /replay/work/mods /replay/work/data/saves /replay/results
cp /input/checkpoint.zip /replay/work/input.zip
cp -a /opt/factorio/mods/. /replay/work/mods/
printf '[path]\nread-data=/opt/factorio/data\nwrite-data=/replay/work/data\n' >/replay/work/config.ini
sha256sum /input/checkpoint.zip >/replay/results/input-before.sha256
printf '4288b6027bb1d116c6c0ee929482466438d74aaf1c3dc70ccce35d9e0264fd3f  /input/checkpoint.zip\n' | sha256sum --check
sha256sum /test/runner/saved_layout_steam_factorio.mjs /test/runner/saved_layout_steam.sh /test/pterodactyl/runtime-v8/structured-policy.mjs /test/pterodactyl/staging/structured-policy.mjs /test/pterodactyl/staging/supervisor-adapter.mjs /opt/factorio/mods/autorio_0.1.0/control.lua >/replay/results/source-hashes.sha256
/opt/factorio/bin/x64/factorio --config /replay/work/config.ini --mod-directory /replay/work/mods --start-server /replay/work/input.zip --server-settings /test/fixtures/server-settings.json --rcon-port 27015 --rcon-password offline-replay-only --port 34197 --no-log-rotation >/replay/results/factorio.log 2>&1 &
factorio_pid=$!
trap 'kill "$factorio_pid" 2>/dev/null || true; wait "$factorio_pid" || true' EXIT
node /test/runner/saved_layout_steam_factorio.mjs --port 27015 --password offline-replay-only --results /replay/results
sha256sum /input/checkpoint.zip >/replay/results/input-after.sha256
cmp /replay/results/input-before.sha256 /replay/results/input-after.sha256
