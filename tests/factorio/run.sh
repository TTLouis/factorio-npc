#!/usr/bin/env bash
set -Eeuo pipefail

FACTORIO_BIN="${FACTORIO_ROOT:-/opt/factorio}/bin/x64/factorio"
TEST_ROOT="${TEST_ROOT:-/test}"
RESULTS="$TEST_ROOT/results"
SAVES="$TEST_ROOT/saves"
LANES_ROOT="$TEST_ROOT/lanes"
BASE_SAVE="$SAVES/npc-test-base.zip"
MAP_GEN_SETTINGS="$TEST_ROOT/fixtures/map-gen-settings.json"
PARALLEL="${NPC_TEST_PARALLEL:-1}"
LANE_FILTER="${NPC_TEST_LANES:-core,research-combat,resilience,production}"
GAME_PORT_BASE="${GAME_PORT_BASE:-34197}"
RCON_PORT_BASE="${RCON_PORT_BASE:-27015}"
export PYTHONUNBUFFERED=1

mkdir -p "$RESULTS" "$SAVES"
rm -rf "$RESULTS"/* "$LANES_ROOT"
rm -f "$BASE_SAVE"
mkdir -p "$LANES_ROOT"

CHILD_PIDS=()

cleanup_children() {
  local pid
  for pid in "${CHILD_PIDS[@]:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "${CHILD_PIDS[@]:-}"; do
    [[ -n "$pid" ]] || continue
    wait "$pid" 2>/dev/null || true
  done
}

finish() {
  local code=$?
  trap - EXIT
  if (( code != 0 )); then
    cleanup_children
    printf '\n[npc-test] FAILED with exit code %s\n' "$code" >&2
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

printf '[npc-test] Running deterministic Python regressions while creating the shared deterministic base save...\n'
python3 -m unittest discover -s "$TEST_ROOT/runner" -p 'test_*.py' -v \
  >"$RESULTS/runner-unit.log" 2>&1 &
UNIT_PID=$!

"$FACTORIO_BIN" --create "$BASE_SAVE" \
  --map-gen-settings "$MAP_GEN_SETTINGS" \
  >"$RESULTS/create.log" 2>&1 &
CREATE_PID=$!

UNIT_STATUS=0
CREATE_STATUS=0
wait "$UNIT_PID" || UNIT_STATUS=$?
wait "$CREATE_PID" || CREATE_STATUS=$?
cat "$RESULTS/runner-unit.log"

if (( UNIT_STATUS != 0 )); then
  printf '[npc-test] Deterministic Python regressions failed.\n' >&2
  exit "$UNIT_STATUS"
fi
if (( CREATE_STATUS != 0 )); then
  printf '[npc-test] Base save creation failed.\n' >&2
  cat "$RESULTS/create.log" >&2
  exit "$CREATE_STATUS"
fi
printf '[npc-test] Base save created successfully.\n'

prepare_lane() {
  local lane="$1"
  local lane_root="$LANES_ROOT/$lane"
  mkdir -p "$lane_root/results"
  cp "$BASE_SAVE" "$lane_root/npc-test.zip"
}

launch_lane() {
  local lane="$1"
  local game_port="$2"
  local rcon_port="$3"
  local lane_root="$LANES_ROOT/$lane"
  local lane_save="$lane_root/npc-test.zip"
  local lane_results="$lane_root/results"
  local lane_log="$RESULTS/$lane.log"

  (
    set -o pipefail
    bash "$TEST_ROOT/runner/run_lane.sh" \
      "$lane" "$lane_save" "$lane_results" "$game_port" "$rcon_port" \
      2>&1 | sed -u "s/^/[$lane] /" | tee "$lane_log"
  ) &
  CHILD_PIDS+=("$!")
}

lane_offset() {
  case "$1" in
    core) printf '0' ;;
    research-combat) printf '1' ;;
    resilience) printf '2' ;;
    production) printf '3' ;;
    *) printf '[npc-test] Unknown lane requested: %s\n' "$1" >&2; return 2 ;;
  esac
}

IFS=',' read -r -a REQUESTED_LANES <<< "$LANE_FILTER"
LANES=()
for raw_lane in "${REQUESTED_LANES[@]}"; do
  lane="${raw_lane//[[:space:]]/}"
  [[ -n "$lane" ]] || continue
  lane_offset "$lane" >/dev/null
  LANES+=("$lane")
done
if (( ${#LANES[@]} == 0 )); then
  printf '[npc-test] NPC_TEST_LANES selected no runtime lanes.\n' >&2
  exit 2
fi

for lane in "${LANES[@]}"; do
  prepare_lane "$lane"
done

printf '[npc-test] Runtime lane mode: %s\n' "$([[ "$PARALLEL" == "0" ]] && printf 'sequential-debug' || printf 'parallel')"
printf '[npc-test] Selected lanes: %s\n' "$(IFS=' | '; echo "${LANES[*]}")"

OVERALL=0
if [[ "$PARALLEL" == "0" ]]; then
  # Debug mode preserves lane isolation while making logs strictly ordered and
  # stops after the first failing lane so the relevant process tail stays near
  # the failure.
  for lane in "${LANES[@]}"; do
    offset="$(lane_offset "$lane")"
    CHILD_PIDS=()
    launch_lane "$lane" "$((GAME_PORT_BASE + offset))" "$((RCON_PORT_BASE + offset))"
    if ! wait "${CHILD_PIDS[0]}"; then
      OVERALL=1
      break
    fi
  done
else
  for lane in "${LANES[@]}"; do
    offset="$(lane_offset "$lane")"
    launch_lane "$lane" "$((GAME_PORT_BASE + offset))" "$((RCON_PORT_BASE + offset))"
  done

  for pid in "${CHILD_PIDS[@]}"; do
    if ! wait "$pid"; then
      OVERALL=1
    fi
  done
fi

CHILD_PIDS=()

if (( OVERALL != 0 )); then
  printf '\n[npc-test] One or more isolated runtime lanes failed. See prefixed output above and lane logs in %s.\n' "$RESULTS" >&2
  for lane in "${LANES[@]}"; do
    lane_error_dir="$LANES_ROOT/$lane/results"
    if compgen -G "$lane_error_dir/*-error.txt" >/dev/null; then
      printf '\n[npc-test] ===== %s error files =====\n' "$lane" >&2
      cat "$lane_error_dir"/*-error.txt >&2 || true
    fi
  done
  exit 1
fi

printf '[npc-test] PASS: selected isolated runtime lanes completed successfully: %s\n' "$(IFS=' + '; echo "${LANES[*]}")"
printf '[npc-test] Runtime smoke completed successfully.\n'
