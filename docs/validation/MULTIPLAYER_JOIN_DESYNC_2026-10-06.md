# Multiplayer join and desync incident — October 6, 2026 (Toronto)

**Confirmed client/server CRC divergence during the assisted red-to-green run; cause unresolved.** The owner reports that joining seems to break the run repeatedly. Retained evidence confirms one actual multiplayer desync and a separate observer-selection bug. It does not establish that every join fails or that external prompting causes desync.

This qualifies the [assisted gameplay success](LUNA_GUIDED_RED_TO_GREEN_2026-10-06.md): green science was unlocked on the server, but multiplayer stability was not demonstrated. No reproduction, provider call or gameplay change was performed to produce this incident record.

## Confirmed desync and ordering

Unchanged candidate `1eb6172f75089d89122b101cd56aaccbeafafcd3`, Factorio 2.0.77, actor 25, seed 1196625720, speed 1. Server: `luna-jev-resume-20261006-sgluna-factorio-1`, local Windows Docker Desktop, UDP 34201. Times below are Toronto (UTC−4); server wall times come from captured Docker logs. Operation log timestamps record when the operator observed or submitted an event; receipt ticks identify its game-time boundary.

| Event | Game tick | Evidence / time |
|---|---:|---|
| Operator admits third native batch of 15 red packs | Admission tick not stated here | Guided log, 05:10:08.430 |
| Human joins while that craft is in progress | 99928 | Server and client `PlayerJoinGame`; server 05:10:21.957 |
| External progress read observes one human and actor 25 | 100488 | Guided log, 05:10:31.290; 32 red crafted, 23 consumed |
| Third native craft batch completes | 104176 | Receipt for `batch-g2-58` |
| First recorded client CRC mismatch | 104177 | Client: server CRC `111425912`, local CRC `4219508961` |
| Server receives `playerDesynced` | 104182 | Server 05:11:32.854, about 71 seconds after join |
| Server saves desync report and returns to `InGame` | 104182 | Server 05:11:32.880–05:11:34.072 |
| Operator poll observes completed craft | World read 104189; receipt 104176 | Guided log, 05:11:34.207; observation came after report save |
| Subsequent lab-feeding operations complete | 104200, 104220 | Both follow the first CRC mismatch |

The client also reports mismatches for ticks 104178–104180, creation of a desync report, and disconnection with reason `Desynced`. The server removes peer 1 at 05:11:34.688 and continues. It later completes green-science research at 05:15:04.531.

**The first recorded CRC failure is one tick after craft-batch completion.** This is a useful investigation boundary, not a demonstrated root cause. A reported CRC tick alone does not identify the first state mutation that diverged. The later lab feeds cannot explain a divergence already reported at tick 104177.

Client and server startup mod checksums match for core, base, autorio, elevated-rails, quality and space-age. Loaded script checksums also match: level `2722821277`, autorio `1485374948`. The installed client archive/control file had previously been verified against the deployed release. This provides no evidence of a simple different-mod build, but does not exclude mod runtime or load-state problems.

The retained previous client session joined at tick 15859 and disconnected with reason `Quit`; it contains no recorded CRC desync. Thus the owner's repeated-join concern remains a reported pattern needing controlled reproduction.

## Separate failures that must not be conflated

- **Confirmed observer bug:** the initial autonomous observer selected `find_entities_filtered{name="character"}[1]`. After a human joined, it read player actor 48 instead of NPC actor 25 and falsely reported `trial_invariant_changed`. Corrected observation resolves the actor through `autorio_actor.status` and `game.get_entity_by_unit_number`. Authoritative evidence confirms NPC 25 remained intact. This is a harness identity error, distinct from the later CRC mismatch.
- **Autonomous continuation failure:** Luna twice omitted semantic step completion and paused with `provider_action_omission_repair_failed`. Joining as its cause is unproven; the original failed trial remains failed.
- **Earlier server query stall:** the operator's large placement-candidate query blocked candidate sorting and caused RCON timeouts, requiring checkpoint recovery. It began with the owner disconnected. It is a separate query-cost issue, not evidence of a join-induced CRC desync.

## External prompting and command interaction: unresolved hypotheses

The owner specifically asked to track desyncs that external prompting might cause. Record the distinction between an external chat/model prompt, its resulting game commands, and externally initiated status reads:

- No new Luna or Jev calls occurred around this desync. All seven main-provider calls and seven Jev exchanges belonged to the earlier autonomous portion. This incident does not demonstrate a new model prompt causing divergence.
- Operator-issued RCON/native commands and progress polling were active. Native crafting crossed a completion boundary one tick before the first recorded CRC failure. Investigate craft completion, receipt bookkeeping and the existing standalone-crafting statistics bridge, including consistency after multiplayer map loading. These are candidates for inspection, not established defects.
- A nominal status read may call runtime code with bookkeeping side effects. Read-only intent alone does not establish that every invoked implementation path leaves synchronized state unchanged. Whether any poll contributed here is unproven.
- Joining/map loading, external objective injection, in-game chat routing and concurrent controller work should be isolated in subsequent tests. No evidence here proves the join alone, external chat alone, RCON alone or Tailscale transport caused the CRC divergence.

## Retained evidence

Ignored incident capture directory: `test-results/luna-jev-resume-2026-10-06/multiplayer-desync/`.

- `client-current.log`: join at line 144, first CRC failure at line 148, report/disconnect at lines 164–165.
- `client-previous.log`: prior join at line 144 and normal quit at line 147.
- `server-current.log`: join at line 949; desync notification at lines 954–955.
- `server-utc-desync.log`: bounded Docker log capture with UTC timestamps, 09:10:15–09:11:40 UTC.
- `guided-timeline.jsonl`: 15 original operation/progress events around the incident, preserving receipt ticks and observation timestamps.
- `capture-manifest.json`: SHA256 and byte count for each captured evidence file.

Full guided trace and original autonomous provider/decision evidence remain under `test-results/luna-jev-resume-2026-10-06/data/logs/`. Client logs say a desync report was created; its archive was not captured or analyzed in this documentation pass. No duplicate world saves were added.

## Follow-up validation, not yet executed

Use the same deployed build and fixed native command sequence before spending more provider calls. Keep server/client logs and, if available, the paired desync report before log rotation. Correlate actor ID, epoch, request/batch ID, admission/completion tick, join/load events and CRC tick.

| Controlled case | What it isolates |
|---|---|
| Idle server; join/leave repeatedly, no external commands | Join/load behavior alone |
| Same native craft sequence with no human | Headless completion control |
| Join before craft versus mid-craft | Join/load interaction with in-flight work |
| Join with status polling only; then same sequence with native writes | Poll effects versus command effects |
| In-game chat versus external objective submission, using fixed inputs | Prompt ingress and resulting admission paths |
| Repeated joins with two clients on the same verified build | Whether the divergence repeats across clients |

Completion criterion: repeated join and external-command cases finish without CRC mismatch, while the authoritative NPC identity and native receipts remain consistent. The current assisted research result satisfies gameplay progress only; this multiplayer validation remains open.
