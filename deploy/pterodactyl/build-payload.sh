#!/usr/bin/env bash
# Regenerates the SGLuna install.sh and egg-sgluna-factorio-server.json
# from payload-src/installer.sh. See build-payload.mjs for what "byte-identical"
# means here and why the compressed bytes (unlike the decompressed content) are
# allowed to change.
set -Eeuo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec node build-payload.mjs "$@"
