#!/usr/bin/env bash
# No real engine or provider: test the actual wrapper's Docker protocol.
set -Eeuo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/repo with spaces/scripts"
cp "$root/scripts/test-factorio-ci.sh" "$fixture/repo with spaces/scripts/"
export FAKE_ROOT="$fixture"
export FAKE_CID=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
cat > "$fixture/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "$*" >> "$FAKE_ROOT/docker.log"
case "$1" in
  create)
    # Assert isolated offline ownership and forbid mounts of cleared lane paths.
    [[ "$*" == *'--pull never --network none --name npc-factorio-ci-fixture-'* ]]
    [[ "$*" == *'--label sgluna.factorio-ci.owner=fixture --cidfile '* ]]
    [[ "$*" != *'--rm'* && "$*" != *'--volume'* && "$*" != *'--mount'* ]]
    touch "$FAKE_ROOT/container"
    printf 'false\n' > "$FAKE_ROOT/running"
    if [[ "$FAKE_CASE" == create-interrupted ]]; then exit 125; fi
    prev=""
    for arg in "$@"; do
      if [[ "$prev" == --cidfile ]]; then printf '%s\n' "$FAKE_CID" > "$arg"; fi
      prev="$arg"
    done
    printf '%s\n' "$FAKE_CID"
    ;;
  start)
    [[ "$*" == "start --attach $FAKE_CID" ]]
    if [[ "$FAKE_CASE" == interrupted ]]; then
      printf 'true\n' > "$FAKE_ROOT/running"
      # The foreground CLI's parent is timeout; signal the wrapper shell.
      wrapper_pid="$(ps -o ppid= -p "$PPID" | tr -d ' ')"
      kill -TERM "$wrapper_pid"
    fi
    if [[ "$FAKE_CASE" == native-cli-failure ]]; then exit 42; fi
    ;;
  inspect)
    [[ -f "$FAKE_ROOT/container" && "${!#}" == "$FAKE_CID" ]]
    case "$*" in
      *'{{.State.Running}}'*) cat "$FAKE_ROOT/running" ;;
      *'{{.State.ExitCode}}'*)
        case "$FAKE_CASE" in native-failure|native-cli-failure|failure-cleanup) echo 42 ;; *) echo 0 ;; esac
        ;;
      *) echo '{"State":{"Running":false}}' ;;
    esac
    ;;
  logs) [[ "${!#}" == "$FAKE_CID" ]]; echo 'native console evidence' ;;
  stop)
    [[ "${!#}" == "$FAKE_CID" ]]
    printf 'false\n' > "$FAKE_ROOT/running"
    ;;
  cp)
    [[ -f "$FAKE_ROOT/container" && "$2" == "$FAKE_CID:/test/"* ]]
    [[ "$FAKE_CASE" != copy-failure ]] || exit 51
    case "$2" in
      */results/.) echo 'assertion diagnostics' > "$3/assertion.txt" ;;
      */lanes/.) echo 'native lane trace' > "$3/trace.jsonl"; echo 'lane save' > "$3/npc-test.zip" ;;
      */saves/.) echo 'base save' > "$3/base.zip" ;;
      *) exit 98 ;;
    esac
    ;;
  rm)
    [[ "$*" == "rm -fv $FAKE_CID" ]]
    # Removal before all three evidence copies is a regression.
    [[ "$(grep -c '^cp ' "$FAKE_ROOT/docker.log")" == 3 ]]
    case "$FAKE_CASE" in cleanup-failure|failure-cleanup) exit 55 ;; esac
    rm "$FAKE_ROOT/container"
    ;;
  container)
    [[ "$2" == ls && "$*" == *' -aq --no-trunc --filter '* ]]
    if [[ "$FAKE_CASE" == daemon-loss && "$*" == *"id=$FAKE_CID"* ]]; then exit 125; fi
    [[ ! -f "$FAKE_ROOT/container" ]] || echo "$FAKE_CID"
    ;;
  *) exit 99 ;;
esac
STUB
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"
export NPC_TEST_SCOPE=fixture
export NPC_TEST_EVIDENCE_ROOT="$fixture/evidence with spaces"
runner="$fixture/repo with spaces/scripts/test-factorio-ci.sh"

run_case() {
  local case_name="$1" expected="$2" status=0 evidence
  export FAKE_CASE="$case_name"
  rm -f "$fixture/container" "$fixture/docker.log"
  bash "$runner" "$case_name" placement-clearing,water-reach-approach \
    > "$fixture/$case_name.log" 2>&1 || status=$?
  if [[ "$status" != "$expected" ]]; then
    cat "$fixture/$case_name.log" >&2
    echo "$case_name: expected $expected, got $status" >&2
    exit 1
  fi
  evidence="$NPC_TEST_EVIDENCE_ROOT/$case_name"
  [[ "$(cat "$evidence/wrapper-exit-code.txt")" == "$expected" ]]
  [[ "$(cat "$evidence/container.cid")" == "$FAKE_CID" ]]
  grep -F "id=$FAKE_CID" "$evidence/ownership.txt" >/dev/null
  if [[ "$case_name" == copy-failure ]]; then
    [[ -f "$fixture/container" ]]
    ! grep -q '^rm ' "$fixture/docker.log"
  else
    [[ -s "$evidence/results/assertion.txt" && -s "$evidence/lanes/trace.jsonl" ]]
    [[ -s "$evidence/lanes/npc-test.zip" && -s "$evidence/saves/base.zip" ]]
    [[ -s "$evidence/container.log" ]]
    cp_line="$(grep -n '^cp ' "$fixture/docker.log" | tail -1 | cut -d: -f1)"
    rm_line="$(grep -n '^rm ' "$fixture/docker.log" | cut -d: -f1)"
    (( cp_line < rm_line ))
  fi
  case "$case_name" in
    cleanup-failure|failure-cleanup|copy-failure|daemon-loss)
      grep -F "Recovery: docker rm -fv $FAKE_CID" "$evidence/recovery.txt" >/dev/null
      [[ ! -f "$evidence/cleanup.txt" ]]
      ;;
    *)
      [[ ! -f "$fixture/container" && -s "$evidence/cleanup.txt" ]]
      [[ ! -f "$evidence/recovery.txt" ]]
      ;;
  esac
  if [[ "$case_name" == interrupted ]]; then grep -q '^stop --time 10 ' "$fixture/docker.log"; fi
  printf 'PASS: %s (exit %s)\n' "$case_name" "$status"
}
run_case success 0
run_case native-failure 42
run_case native-cli-failure 42
run_case interrupted 143
run_case cleanup-failure 1
run_case failure-cleanup 42
run_case copy-failure 1
run_case daemon-loss 1
run_case create-interrupted 125
# Fail before Docker on invalid arguments and evidence reuse.
: > "$fixture/docker.log"
if bash "$runner" bad/label; then exit 1; fi
if bash "$runner" success; then exit 1; fi
[[ ! -s "$fixture/docker.log" ]]
echo 'PASS: native CI evidence, exit status, interruption, exact ownership and recovery'
