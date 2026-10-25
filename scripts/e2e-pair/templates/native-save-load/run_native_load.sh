#!/bin/bash
set -euo pipefail
mkdir -p /proof/work-data /proof/work-mods
cp /input/data/saves/@@SAVE_NAME@@.zip /proof/pristine-copy.zip
mapfile -t mod_dirs < <(printf '%s\n' /input/data/.sgluna/run-*/mods)
if [[ ${#mod_dirs[@]} -eq 1 && -d "${mod_dirs[0]}" ]]; then
  cp -a "${mod_dirs[0]}/." /proof/work-mods/
  printf '%s\n' 'active_runtime_directory' >/proof/mod-provenance.txt
else
  mkdir -p /proof/work-mods/autorio_0.1.0
  cp -a /input/independent-native/. /proof/work-mods/autorio_0.1.0/
  printf '%s\n' '{"mods":[{"name":"base","enabled":true},{"name":"autorio","enabled":true}]}' >/proof/work-mods/mod-list.json
  printf '%s\n' 'independent_native_hash_matched_to_preflight_deployment' >/proof/mod-provenance.txt
fi
release_root=$(dirname "$(readlink -f /opt/sgluna/start-sgluna.sh)")
factorio_root=$release_root/factorio
cat >/proof/native-config.ini <<EOF
[path]
read-data=$factorio_root/data
write-data=/proof/work-data
EOF
$factorio_root/bin/x64/factorio --version >/proof/native-version.txt 2>&1
grep -Eq '^Version: 2\.0\.77([[:space:]]|$)' /proof/native-version.txt
$release_root/node/bin/node /proof/verify_active_mod.mjs /input/expected-native-mod.json /proof/work-mods/autorio_0.1.0 /proof/active-mod-match-proof.json
set +e
timeout --signal=TERM --kill-after=10s 90s $factorio_root/bin/x64/factorio \
  --config /proof/native-config.ini --mod-directory /proof/work-mods \
  --benchmark /proof/pristine-copy.zip --benchmark-ticks 1 --benchmark-runs 1 \
  --console-log /proof/benchmark-console.log >/proof/benchmark.log 2>&1
result=$?
set -e
printf '%s\n' "$result" >/proof/benchmark-exit.txt
sha256sum /input/data/saves/@@SAVE_NAME@@.zip /proof/pristine-copy.zip >/proof/after-save-hashes.txt
exit "$result"
