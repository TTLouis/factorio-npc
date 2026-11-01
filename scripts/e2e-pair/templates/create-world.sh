#!/bin/bash
set -euo pipefail
release_root=$(dirname "$(readlink -f /opt/sgluna/start-sgluna.sh)")
factorio_root=$release_root/factorio
"$factorio_root/bin/x64/factorio" --version >/proof/create-native-version.txt 2>&1
grep -Eq '^Version: 2\.0\.77([[:space:]]|$)' /proof/create-native-version.txt
test ! -e /data/saves/@@RUN_ID@@-fresh.zip
test -z "$(find /data/saves -type f -print -quit)"
mkdir -p /proof/create-mods/autorio_0.1.0 /proof/create-data
cp -a /proof/independent-native/. /proof/create-mods/autorio_0.1.0/
printf '%s\n' '{"mods":[{"name":"base","enabled":true},{"name":"autorio","enabled":true}]}' >/proof/create-mods/mod-list.json
"$release_root/node/bin/node" /proof/native-save-load/verify_active_mod.mjs /proof/expected-native-mod.json /proof/create-mods/autorio_0.1.0 /proof/create-mod-match.json
printf '[path]\nread-data=%s/data\nwrite-data=/proof/create-data\n' "$factorio_root" >/proof/create-config.ini
"$factorio_root/bin/x64/factorio" --config /proof/create-config.ini --mod-directory /proof/create-mods \
  --map-gen-settings /proof/map-gen-settings.json --create /data/saves/@@RUN_ID@@-fresh.zip \
  >/proof/create-world.log 2>&1
test -s /data/saves/@@RUN_ID@@-fresh.zip
sha256sum /data/saves/@@RUN_ID@@-fresh.zip >/proof/create-world.sha256
