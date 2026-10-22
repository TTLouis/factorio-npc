#!/usr/bin/env bash
# Retain native evidence before removing only this invocation's container.
# Usage: bash scripts/test-factorio-ci.sh LABEL [comma-separated-lanes]
set -Eeuo pipefail
[[ $# -ge 1 && $# -le 2 && "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || {
  echo "usage: $0 LABEL [comma-separated-lanes]" >&2; exit 2;
}
label="$1"
lanes="${2:-core,research-combat,resilience,production}"
[[ "$lanes" =~ ^[a-z0-9-]+(,[a-z0-9-]+)*$ ]] || exit 2
scope="${NPC_TEST_SCOPE:-$(date -u +%Y%m%d%H%M%S)-$$-$RANDOM}"
[[ "$scope" =~ ^[a-z0-9][a-z0-9-]*$ ]] || exit 2
name="npc-factorio-ci-$scope-$label"
evidence="${NPC_TEST_EVIDENCE_ROOT:-test-results/factorio-ci}/$label"
mkdir -p -- "$(dirname -- "$evidence")"
# Never overwrite evidence from a previous invocation.
mkdir -- "$evidence"
evidence="$(cd "$evidence" && pwd)"
cidfile="$evidence/container.cid"
cid=""
printf 'name=%s\ncompose_project=none\nnetwork=none\nlanes=%s\ncidfile=%s\n' \
  "$name" "$lanes" "$cidfile" | tee "$evidence/ownership.txt"

finish() {
  local status=$? issue=0 copied=1 remaining running part
  trap - EXIT
  trap '' INT TERM
  set +e
  printf '%s\n' "$status" > "$evidence/test-exit-code.txt"
  [[ ! -s "$cidfile" ]] || cid="$(cat "$cidfile")"
  # Cover cancellation while create is returning, before the CID reaches disk.
  if [[ -z "$cid" ]]; then
    cid="$(timeout 30s docker container ls -aq --no-trunc \
      --filter "name=^/$name$" --filter "label=sgluna.factorio-ci.owner=$scope")"
    if [[ $? != 0 ]]; then
      issue=1
      printf 'Ownership lookup failed; recover using name=%s label=sgluna.factorio-ci.owner=%s\n' \
        "$name" "$scope" >> "$evidence/recovery.txt"
    elif [[ -n "$cid" ]]; then
      printf '%s\n' "$cid" > "$cidfile"
    fi
  fi
  if [[ -n "$cid" ]]; then
    printf 'id=%s\n' "$cid" | tee -a "$evidence/ownership.txt"
    running="$(timeout 30s docker inspect --format '{{.State.Running}}' "$cid")"
    if [[ $? != 0 ]]; then
      issue=1
    elif [[ "$running" == true ]]; then
      timeout 30s docker stop --time 10 "$cid" > "$evidence/stop.log" 2>&1 || issue=1
    fi
    timeout 30s docker inspect "$cid" > "$evidence/container-inspect.json" \
      2> "$evidence/inspect.stderr" || issue=1
    timeout 30s docker logs "$cid" > "$evidence/container.log" \
      2> "$evidence/container.stderr" || { issue=1; copied=0; }
    # /test/lanes is removed by run.sh: deliberately use no bind mounts.
    for part in results lanes saves; do
      mkdir -p "$evidence/$part"
      timeout 90s docker cp "$cid:/test/$part/." "$evidence/$part/" \
        >> "$evidence/copy.log" 2>&1 || { issue=1; copied=0; }
    done
    if (( copied )); then
      timeout 30s docker rm -fv "$cid" > "$evidence/remove.log" 2>&1 || issue=1
    fi
    remaining="$(timeout 30s docker container ls -aq --no-trunc --filter "id=$cid")"
    if [[ $? != 0 || -n "$remaining" ]]; then
      issue=1
      {
        printf 'Cleanup unverified for %s (name %s).\n' "$cid" "$name"
        for part in results lanes saves; do
          printf 'Recovery: docker cp %q %q\n' "$cid:/test/$part/." "$evidence/$part/"
        done
        printf 'Recovery: docker logs %q > %q 2>&1\n' "$cid" "$evidence/container-recovered.log"
        printf 'Recovery: docker rm -fv %q\n' "$cid"
        printf 'Verify: docker container ls -aq --no-trunc --filter %q\n' "id=$cid"
      } >> "$evidence/recovery.txt"
    else
      printf 'Verified absent, including stopped containers: %s\n' "$cid" \
        | tee "$evidence/cleanup.txt"
    fi
  fi
  if (( issue )); then
    echo "Evidence/cleanup failed; retained ownership and recovery information in $evidence" >&2
    [[ ! -f "$evidence/recovery.txt" ]] || cat "$evidence/recovery.txt" >&2
    # Preserve an existing native/interrupt exit; infrastructure failure cannot pass.
    (( status != 0 )) || status=1
  fi
  printf '%s\n' "$status" > "$evidence/wrapper-exit-code.txt"
  exit "$status"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

timeout 30s docker create --pull never --network none --name "$name" \
  --label "sgluna.factorio-ci.owner=$scope" --cidfile "$cidfile" \
  -e "NPC_TEST_LANES=$lanes" "${NPC_TEST_IMAGE:-factorio-npc-test}" \
  > "$evidence/create.log" 2>&1
cid="$(cat "$cidfile")"
printf 'Created owned container: %s (%s)\n' "$name" "$cid"
start_status=0
timeout --signal=TERM --kill-after=15s "${NPC_TEST_TIMEOUT:-10m}" \
  docker start --attach "$cid" || start_status=$?
# Use the engine's exit status, while retaining timeout/start failures.
inspect_status=0
running="$(timeout 30s docker inspect --format '{{.State.Running}}' "$cid")" || inspect_status=$?
native_status="$(timeout 30s docker inspect --format '{{.State.ExitCode}}' "$cid")" || inspect_status=$?
printf '%s\n' "$native_status" > "$evidence/native-exit-code.txt"
# Interruption/timeout is authoritative even if stopping later yields exit 0.
case "$start_status" in 124|130|137|143) exit "$start_status" ;; esac
if [[ "$running" == false && "$native_status" =~ ^[0-9]+$ ]] && (( native_status != 0 )); then
  exit "$native_status"
fi
if (( start_status != 0 )); then exit "$start_status"; fi
if (( inspect_status != 0 )); then exit "$inspect_status"; fi
[[ "$running" == false && "$native_status" == 0 ]] || exit 1
exit 0
