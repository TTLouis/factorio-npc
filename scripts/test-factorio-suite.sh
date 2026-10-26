#!/usr/bin/env bash
# Run every existing CI lane, preserving each wrapper's evidence and exit code.
# Build NPC_TEST_IMAGE first; this script never builds, pulls or calls providers.
set -Eeuo pipefail
[[ $# -eq 0 ]] || { echo "usage: $0" >&2; exit 2; }
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"
status=0
for label in default fresh-topology direct-feed-observation partial-transfer ground-item-pickup placement-clearing water-reach-approach; do
  lanes="$label"
  [[ "$label" != default ]] || lanes=core,research-combat,resilience,production
  lane_status=0
  bash scripts/test-factorio-ci.sh "$label" "$lanes" || lane_status=$?
  printf '[native-suite] %s: exit %s\n' "$label" "$lane_status"
  # Interrupts must stop the suite after the wrapper preserves/cleans its lane.
  case "$lane_status" in 130|137|143) exit "$lane_status" ;; esac
  if (( lane_status != 0 && status == 0 )); then status="$lane_status"; fi
done
exit "$status"
