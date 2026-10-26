#!/usr/bin/env bash
# Exercise orchestration without Docker, Factorio or inference.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/repo with spaces/scripts"
cp "$root/scripts/test-factorio-suite.sh" "$fixture/repo with spaces/scripts/"
export SUITE_LOG="$fixture/calls"
cat > "$fixture/repo with spaces/scripts/test-factorio-ci.sh" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s %s\n' "$1" "$2" >> "$SUITE_LOG"
case "$1" in
  fresh-topology) exit "${TOPOLOGY_EXIT:-0}" ;;
  partial-transfer) exit "${TRANSFER_EXIT:-0}" ;;
esac
STUB
runner="$fixture/repo with spaces/scripts/test-factorio-suite.sh"
cat > "$fixture/expected" <<'EXPECTED'
default core,research-combat,resilience,production
fresh-topology fresh-topology
direct-feed-observation direct-feed-observation
partial-transfer partial-transfer
ground-item-pickup ground-item-pickup
placement-clearing placement-clearing
water-reach-approach water-reach-approach
EXPECTED
bash "$runner"
diff -u "$fixture/expected" "$SUITE_LOG"
for code in 1 42 124; do
  : > "$SUITE_LOG"
  status=0
  TOPOLOGY_EXIT="$code" TRANSFER_EXIT=7 bash "$runner" || status=$?
  [[ "$status" == "$code" ]]
  diff -u "$fixture/expected" "$SUITE_LOG"
done
for code in 130 137 143; do
  : > "$SUITE_LOG"
  status=0
  TOPOLOGY_EXIT="$code" bash "$runner" || status=$?
  [[ "$status" == "$code" && "$(wc -l < "$SUITE_LOG")" == 2 ]]
done
: > "$SUITE_LOG"
if bash "$runner" unexpected; then exit 1; fi
[[ ! -s "$SUITE_LOG" ]]
echo 'PASS: native suite coverage, failure aggregation, interruption and portable paths'
