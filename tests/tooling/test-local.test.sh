#!/usr/bin/env bash
# Exercise the real runner with a fake Docker CLI: no engine or credentials.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
export TMPDIR="$fixture"
mkdir -p "$fixture/bin" "$fixture/repo with spaces/scripts"
cp "$root/scripts/test-local.sh" "$fixture/repo with spaces/scripts/"
export DOCKER_TEST_LOG="$fixture/docker.log"
export DOCKER_TEST_STATE="$fixture/state"
cat > "$fixture/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$DOCKER_TEST_LOG"
case "$1" in
  run)
    lane=runtime
    for arg in "$@"; do
      case "$arg" in
        npc-static-*-agent) lane=agent ;;
        npc-static-*-mod) lane=mod ;;
      esac
    done
    if [[ "$lane" == agent ]]; then
      for required in \
        '/packages/agent/src:/src/packages/agent/src:ro' \
        '/packages/agent/package.json:/src/packages/agent/package.json:ro' \
        '/packages/agent/vite.config.ts:/src/packages/agent/vite.config.ts:ro' \
        '/packages/agent/tsconfig.json:/src/packages/agent/tsconfig.json:ro' \
        '/contracts:/src/contracts:ro'; do
        found=false
        for arg in "$@"; do
          [[ "$arg" != *"/repo with spaces$required" ]] || found=true
        done
        [[ "$found" == true ]]
      done
      [[ "${!#}" == 'pnpm --filter @factorio-npc/agent run test --run' ]]
    fi
    if [[ "$lane" == runtime ]]; then
      found_contracts=false
      for arg in "$@"; do
        [[ "$arg" != *'/repo with spaces/contracts:/src/contracts:ro' ]] || found_contracts=true
      done
      [[ "$found_contracts" == true ]]
    fi
    prev=
    for arg in "$@"; do
      if [[ "$prev" == --cidfile ]]; then
        printf '%s' "owned-$lane" > "$arg"
        touch "$DOCKER_TEST_STATE-owned-$lane"
      fi
      prev="$arg"
    done
    if [[ "${FAIL_LANE:-}" == "$lane" ]]; then exit 42; fi
    rm -f "$DOCKER_TEST_STATE-owned-$lane"
    ;;
  container)
    [[ "${DOCKER_DOWN:-}" != true ]] || exit 125
    cid="${!#}"
    cid="${cid#id=}"
    if [[ -f "$DOCKER_TEST_STATE-$cid" ]]; then printf '%s\n' "$cid"; fi
    ;;
  rm) rm "$DOCKER_TEST_STATE-$3" ;;
  *) exit 99 ;;
esac
STUB
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"
runner="$fixture/repo with spaces/scripts/test-local.sh"

bash "$runner" all
[[ "$(grep -c '^run ' "$DOCKER_TEST_LOG")" == 3 ]]
{
  IFS= read -r agent_run
  IFS= read -r runtime_run
  IFS= read -r mod_run
} < <(grep '^run ' "$DOCKER_TEST_LOG")
[[ "$agent_run" == *'-agent '* ]]
[[ "$runtime_run" == *'-runtime '* ]]
[[ "$mod_run" == *'-mod '* ]]
grep -F -- '--rm --pull never --network none' "$DOCKER_TEST_LOG" >/dev/null
# The quoted bind must reach Docker as one argument despite the spaces.
grep -F '/repo with spaces/contracts:/src/contracts:ro' "$DOCKER_TEST_LOG" >/dev/null
grep -F 'npx --no-install vitest' "$DOCKER_TEST_LOG" >/dev/null
grep -F 'pnpm --filter @factorio-npc/agent run test --run' "$DOCKER_TEST_LOG" >/dev/null
if grep -E '/\.env:|/repo with spaces:/src' "$DOCKER_TEST_LOG"; then exit 1; fi

# Each selector runs only its own lane, including the new ordinary-agent gate.
for lane in agent runtime mod; do
  : > "$DOCKER_TEST_LOG"
  bash "$runner" "$lane"
  [[ "$(grep -c '^run ' "$DOCKER_TEST_LOG")" == 1 ]]
  grep '^run ' "$DOCKER_TEST_LOG" | grep -F -- "-$lane " >/dev/null
done

# A failure in any lane stops all before subsequent work and cleans its CID.
expected_runs=0
for lane in agent runtime mod; do
  expected_runs=$((expected_runs + 1))
  : > "$DOCKER_TEST_LOG"
  set +e
  FAIL_LANE="$lane" bash "$runner" all
  status=$?
  set -e
  [[ "$status" == 42 ]]
  [[ "$(grep -c '^run ' "$DOCKER_TEST_LOG")" == "$expected_runs" ]]
  grep -Fx "rm -f owned-$lane" "$DOCKER_TEST_LOG" >/dev/null
  [[ ! -f "$DOCKER_TEST_STATE-owned-$lane" ]]
done

# Daemon failure must not be reported as successful cleanup or discard the CID.
set +e
DOCKER_DOWN=true bash "$runner" runtime > "$fixture/unavailable.log" 2>&1
status=$?
set -e
[[ "$status" == 1 ]]
grep -F 'Cleanup unverified for owned-runtime; recovery: docker rm -f owned-runtime' "$fixture/unavailable.log" >/dev/null
grep -F 'Retained owned container IDs' "$fixture/unavailable.log" >/dev/null
[[ -n "$(find "$fixture" -name runtime.cid -print -quit)" ]]

: > "$DOCKER_TEST_LOG"
if bash "$runner" invalid; then exit 1; fi
if bash "$runner" all unexpected; then exit 1; fi
[[ ! -s "$DOCKER_TEST_LOG" ]]
echo 'PASS: three ordered lanes, current agent mounts/CI command, portable paths, isolated selectors, failure propagation, owned cleanup, daemon loss evidence, invalid arguments'
