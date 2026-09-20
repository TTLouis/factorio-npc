#!/usr/bin/env bash
set -Eeuo pipefail

LANE="${1:?lane name required}"
SAVE="${2:?save path required}"
RESULTS="${3:?results path required}"
SERVER_PORT="${4:?server port required}"
RCON_PORT="${5:?rcon port required}"

FACTORIO_ROOT="${FACTORIO_ROOT:-/opt/factorio}"
FACTORIO_BIN="$FACTORIO_ROOT/bin/x64/factorio"
TEST_ROOT="${TEST_ROOT:-/test}"
SERVER_SETTINGS="$TEST_ROOT/fixtures/server-settings.json"
RCON_PASSWORD="${RCON_PASSWORD:-airi-test}"
LANE_ROOT="$(dirname "$RESULTS")"
WRITE_DATA="$LANE_ROOT/factorio-data"
MODS="$LANE_ROOT/mods"
CONFIG="$LANE_ROOT/config.ini"
FACTORIO_PID=""
START_COUNT=0
export PYTHONUNBUFFERED=1

mkdir -p "$RESULTS" "$WRITE_DATA" "$MODS"
# Parallel Factorio instances must not share a writable mod directory. Factorio
# may maintain per-instance mod metadata/caches there, so clone the prepared test
# mod tree once per lane just like save/write-data/ports are isolated.
cp -a "$FACTORIO_ROOT/mods/." "$MODS/"
cat >"$CONFIG" <<EOF
[path]
read-data=$FACTORIO_ROOT/data
write-data=$WRITE_DATA
EOF

print_failure_context() {
  local pattern file
  for pattern in "$RESULTS"/*-error.txt "$RESULTS"/runner-error.txt; do
    for file in $pattern; do
      [[ -f "$file" && -s "$file" ]] || continue
      printf '\n[npc-test][%s] ===== %s =====\n' "$LANE" "$(basename "$file")" >&2
      cat "$file" >&2
    done
  done

  for file in "$RESULTS"/factorio-process-*.log; do
    [[ -f "$file" && -s "$file" ]] || continue
    printf '\n[npc-test][%s] ===== tail %s =====\n' "$LANE" "$(basename "$file")" >&2
    tail -n 120 "$file" >&2
  done
}

stop_factorio() {
  if [[ -n "$FACTORIO_PID" ]] && kill -0 "$FACTORIO_PID" 2>/dev/null; then
    kill "$FACTORIO_PID" 2>/dev/null || true
    wait "$FACTORIO_PID" 2>/dev/null || true
  fi
  FACTORIO_PID=""
}

finish() {
  local code=$?
  trap - EXIT
  stop_factorio
  if (( code != 0 )); then
    printf '[npc-test][%s] FAILED with exit code %s\n' "$LANE" "$code" >&2
    print_failure_context
  fi
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

start_factorio() {
  START_COUNT=$((START_COUNT + 1))
  local process_log="$RESULTS/factorio-process-$START_COUNT.log"
  local console_log="$RESULTS/factorio-console-$START_COUNT.log"

  "$FACTORIO_BIN" \
    --config "$CONFIG" \
    --mod-directory "$MODS" \
    --start-server "$SAVE" \
    --server-settings "$SERVER_SETTINGS" \
    --port "$SERVER_PORT" \
    --rcon-port "$RCON_PORT" \
    --rcon-password "$RCON_PASSWORD" \
    --console-log "$console_log" \
    --no-log-rotation \
    >"$process_log" 2>&1 &
  FACTORIO_PID=$!

  sleep 0.5
  if ! kill -0 "$FACTORIO_PID" 2>/dev/null; then
    wait "$FACTORIO_PID" || true
    printf '[npc-test][%s] Factorio exited before RCON became available.\n' "$LANE" >&2
    exit 1
  fi
  printf '[npc-test][%s] Factorio started pid=%s game_port=%s rcon_port=%s start=%s\n' \
    "$LANE" "$FACTORIO_PID" "$SERVER_PORT" "$RCON_PORT" "$START_COUNT"
}

restart_factorio() {
  printf '[npc-test][%s] Restarting Factorio...\n' "$LANE"
  stop_factorio
  sleep 0.5
  start_factorio
}

run_py() {
  local script="$1"
  shift
  python3 "$TEST_ROOT/runner/$script" \
    --host 127.0.0.1 \
    --port "$RCON_PORT" \
    --password "$RCON_PASSWORD" \
    --results "$RESULTS" \
    "$@"
}

run_node() {
  local script="$1"
  shift
  NODE_TEST_CONTEXT=1 node "$TEST_ROOT/runner/$script" \
    --host 127.0.0.1 \
    --port "$RCON_PORT" \
    --password "$RCON_PASSWORD" \
    --results "$RESULTS" \
    "$@"
}

printf '[npc-test][%s] Starting isolated runtime lane.\n' "$LANE"
start_factorio

# Every lane begins with the same zero-player actor/clock/core-action smoke. This
# gives each isolated save a runner.json actor identity and verifies the common
# foundation before a specialized gate mutates its world.
run_py run.py

case "$LANE" in
  core)
    printf '[npc-test][core] Running placement/transfer and lifecycle cancellation gates...\n'
    run_py placement_transfer.py
    printf '[npc-test][core] Running full furnace supply/retrieval transfer gate...\n'
    run_py smelting_transfer.py
    run_py control_lifecycle.py
    printf '[npc-test][core] Running owned basic-operation outcome/failure gates...\n'
    run_py basic_outcomes.py
    printf '[npc-test][core] Running exact non-resource mining auto-approach gate...\n'
    run_py exact_entity_mining.py
    printf '[npc-test][core] Running construction-area finite blocker clearing gate...\n'
    run_py construction_area_clearing.py
    ;;

  research-combat)
    printf '[npc-test][research-combat] Running native research gate...\n'
    run_py research.py
    printf '[npc-test][research-combat] Running correlated research follow-through gate...\n'
    run_py research_followthrough.py
    printf '[npc-test][research-combat] Running bounded combat gate...\n'
    run_py combat.py
    ;;

  resilience)
    printf '[npc-test][resilience] Preparing full planning lifecycle acceptance state on real Factorio...\n'
    run_node planning_lifecycle_factorio.mjs --mode prepare

    printf '[npc-test][resilience] Preparing live planning BLOCKED state against real Factorio preflight...\n'
    run_node planning_live_factorio.mjs --mode prepare

    printf '[npc-test][resilience] Saving active movement for real process restart...\n'
    run_py persistence_prepare.py --save "$SAVE"
    restart_factorio
    run_py persistence_verify.py

    printf '[npc-test][resilience] Verifying full planning lifecycle lineage after real Factorio restart...\n'
    run_node planning_lifecycle_factorio.mjs --mode verify

    printf '[npc-test][resilience] Restoring planning BLOCKED state after real Factorio restart...\n'
    run_node planning_live_factorio.mjs --mode verify

    printf '[npc-test][resilience] Running death-recovery and navigation/belt gates...\n'
    run_py death_recovery.py
    run_py navigation.py

    printf '[npc-test][resilience] Running owned native crafting/cancellation gate...\n'
    run_py crafting.py

    printf '[npc-test][resilience] Saving active owned craft for second process restart...\n'
    run_py crafting_restart_prepare.py --save "$SAVE"
    restart_factorio
    run_py crafting_restart_verify.py
    ;;

  production)
    # Production-capability validation lane (docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md).
    # Kept isolated from `core` because these gates rewrite terrain, force
    # always_day and raise game.speed inside their own save.
    # Ordering matters: the assembler gate ends by exercising the NPC recipe
    # operation, which currently kills the Factorio process (see the runtime
    # defect documented in powered_assembler_cell.py), so it must run last.
    printf '[npc-test][production] Running A1 belt/inserter transport gate...\n'
    run_py belt_transport_cell.py
    printf '[npc-test][production] Running A1 powered assembler production cell gate...\n'
    run_py powered_assembler_cell.py
    ;;

  *)
    printf '[npc-test][%s] Unknown lane.\n' "$LANE" >&2
    exit 2
    ;;
esac

printf '[npc-test][%s] PASS\n' "$LANE"
