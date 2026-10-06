# Luna autonomy failures and repair order — October 5, 2026 (Toronto)

This is a read-only diagnosis of the retained CLI-proxy run against the current
source. No new provider requests, gameplay operations, or runtime changes were
made. The successful guided world remains saved and stopped.

The [guided checkpoint](CLI_PROXY_LUNA_RED_TO_GREEN_2026-10-05.md) proves that
native operations can reach green science. It does not establish that Luna can
choose and finish those operations independently. The following repairs target
that distinction; they must not become a scripted red-science walkthrough
masquerading as model autonomy.

## Already repaired

- Closed GPT-6 proxy rounds retain function schemas and explicit `tool_choice:
  none`, avoiding the unsolicited-image response seen in a diagnostic replay.
- Confirmed standalone native crafts now supply missing craft-trigger production
  flow without double-counting completion. A real lab craft unlocked red science
  after this fix.

Neither repair establishes autonomous planning or recovery.

## 1. Validate checkpoint meaning before commitment

**Observed:** `req_muw0yzan_3` committed an `entity_inventory_count` checkpoint:
50 iron plates in furnace 15. At turn 12, Luna proposed changing it to NPC
`inventory_count`, then collected the plates. The runtime correctly ignored the
change (`step.checkpoint_change_ignored`), and the committed checkpoint became
false because the furnace was empty. At turn 13 it tried a copper checkpoint;
that change was also correctly ignored. It eventually tried collecting iron
again and hit `transfer_failed:nothing_moved`.

The problem is not immutability itself. The draft combined an intermediate
machine stock condition with actions that deliberately removed that stock.

**Repair:** require explicit completion contracts for executable resource and
processing steps; reject contradictory drafts before commitment. Split
"smelt until machine output exists" from "collect output", or author a
collection step whose contract is held inventory. Production counters can prove
newly produced amounts when that is the requested meaning, with an appropriate
baseline. Do not replace one condition kind with another after commitment or
infer equivalent meaning from prose.

Existing malformed committed plans need a versioned replacement through verified
standing task authority, or user approval when outside that authority. Preserve
verified history and explain the correction.

**Regression:** a recorded draft that empties its own required furnace stock is
rejected before admission; valid split steps close from world evidence. The old
contract remains immutable during continuation. Relevant source:
`runtime-v8/npc-agent-loop.mjs` checkpoint attachment and batch completion checks
(around lines 4829 and 5156).

## 2. Make transfer preflight useful and recover missing supplies locally

**Observed:** `req_muw0mkcw_1` turn 7 supplied coal it did not hold; preflight
returned `ok: true`. `req_muw0tw25_2` turn 3 then tried transferring 50 iron ore
already loaded into the furnace, also passing preflight. Both native operations
failed with `item_missing`, froze the plan and needed corrective chat.

**Confirmed source gap:** `packages/autorio/src/control.ts` around line 242
includes `supply_entity` and `move_items_exact` in exact-target operations; around
line 292 it accepts them after checking entity identity and surface. It does not
check source items or destination acceptance there.

**Repair:** return structured source count, destination stock/acceptance and
missing amount before admission. Respect existing maximum-count/partial-transfer
semantics; a smaller available amount is not automatically failure. Handle batch
dependencies using an explicit bounded inventory projection or split at an
observation boundary, rather than falsely rejecting a transfer preceded by
crafting or gathering in the same batch. Retain execution-time checks: walking
and other actors can change state after preflight.

Classify a proved missing supply as a recoverable acquisition dependency within
the same committed semantic step. Re-observe stock, let Luna choose acquisition
or a different valid transfer, and bound retries. Do not automatically declare
the transfer already complete merely because the destination holds that item.
Structural blockers, reserved supplies and stale actor/epoch remain protected.

**Regression:** zero coal, ore already transferred, empty extraction, partial
stock, full destination, dependent batches, and state changes after preflight.
Prove that correctable shortages do not silently rewrite the plan or require a
human resume for ordinary recovery.

## 3. Replace blind waiting with observed progress

**Observed:** at the start of `req_muw0yzan_3`, the furnace had 47 iron plates,
2 ore and fuel and was working. Luna then submitted eleven consecutive
600-tick waits without another tool read, before collecting the output. Waiting
receipts repeatedly yielded `no_authoritative_operation_receipt` for step close.
The last observation was stale narrative context, not a tool-cache defect: the
continuation path clears `toolCache` (around line 7216).

**Repair:** connect the existing bounded condition-wait machinery to this
processing path, or require a fresh machine observation after a bounded blind
wait. Poll the specific committed condition internally, not through a new model
decision every ten seconds. On satisfied output, return current evidence; on
missing fuel/input, full output, stopped machine or timeout, return the concrete
state for a bounded recovery decision. Polling needs actor/epoch/step fences and
must not equate elapsed time with completion.

**Regression:** progress, early completion, no fuel, depleted input, blocked
output, timeout, restart and actor replacement. Waiting alone must never prove
production.

**Correction to the earlier operator explanation:** the retained narrowed-run
behavior trace does not show a continuation-limit failure. The waits wasted
calls, but this request ended on `nothing_moved`; the final request ended on
action omission. Current active-plan code allows 64 continuations. Raising that
ceiling is not an evidence-backed fix for this run.

## 4. Preserve usable recipe facts across planner/executor handoff

**Observed:** `req_muw17okc_4` read the lab recipe, inventory and furnace, then
collected ten copper plates. A fresh executor context contained the plan, prior
entity snapshots and transfer receipt, but not the earlier lab-recipe result or
inventory read. It returned the remaining plan with zero operations, then did
so again during its bounded act-or-block repair. The harness paused on
`provider_action_omission_repair_failed`. Both submissions were `submitPlan`
calls; this was not an observation call wrongly rejected as a plan.

**Repair:** carry a bounded recipe/material dependency summary into the fresh
executor context. Retain stable recipe facts with their world/prototype revision;
mark inventory and machine stock stale after mutation and refresh the relevant
counts. Derive residual acquisition/processing needs using shared-stock accounting
and recipe output quantities. Give the executor the authoritative active step,
its contract, the latest correlated receipt, and the available observations.
Do not carry historical exact entity IDs as current executable authority.

The bootstrap report also needs placed-machine awareness. The live lab report
named an electric furnace acquisition dependency despite an observed placed
stone furnace. `bootstrap_planning.ts` around line 233 explicitly checks held
machines under `inventory_acquisition`; after placement that is insufficient to
describe a working processing route. Keep acquisition, placement and operational
readiness distinct, and never let finding a machine prove it is powered/fueled.

Give machine-only recipes an explicit processing result instead of a generic
missing-craft message: Luna attempted `craft_item iron-plate` three times during
the first request, despite smelting being required.

**Regression:** recorded replies spanning the actual role restage, lab recipe,
ten collected copper plates and additional-copper dependency. Verify the fresh
executor receives a coherent bounded context and can submit an admitted next
action with scripted replies. This establishes harness support, not live Luna
competence. Preserve budget caps and truthful pauses if the model still returns
no action.

## Independent finish still requires validation

Luna never attempted the steam network, all 75 science crafts, lab feeding or
green-science research in this run. Those are untested model capabilities, not
confirmed model failures. The guided layout establishes one physically valid
network; it does not establish autonomous site selection or layout planning.

After the repairs above, test in order: autonomous smelting and collection;
lab craft and red unlock; steam-powered lab; native green research. Use native
recipe, fluid-port and placement observations. Avoid prescribing the guided
coordinates or choosing every operation outside Luna.

Turn these findings into recorded/static regressions first, then run the Docker
runtime/mod gates and relevant engine lanes. A new real-provider trial requires
owner authorization for that run. Its acceptance criterion is one fresh normal
world, declared starter kit, zero humans, normal speed, Luna-selected structured
actions, no corrective prompts or deterministic gameplay takeover, and native
proof that green science is researched and its recipe enabled. A single pass
demonstrates one autonomous success; repeatability needs additional fresh seeds.

Evidence inspected: ignored
`test-results/luna-red-green-2026-10-05/data/logs/sgluna-behavior.jsonl` and
`sgluna-prompts.jsonl`, the guided checkpoint and the source locations above.

## Repair build checklist

Approved 2026-10-05. Defaults taken where the owner did not choose: the narrow
contradiction check for section 1, two missing-supply re-acquisitions per step
before a blocker, both parts of the wait repair, and transfer preflight built here
with room for the playable track's human-inventory exclusion. No unit adds
system-prompt text; each gives Luna facts or rejects a draft.

| Unit | Scope | Branch | Commit | Status |
|---|---|---|---|---|
| A | Transfer preflight returns source/destination counts; batch-aware missing-supply rejection; recoverable acquisition inside the step, bounded at 2 | `fix/transfer-preflight-counts` | `f2641267` | merged; gate 1,645 runtime / 991 mod |
| B | `wait`-only batches on a machine-output checkpoint route to the condition wait; wait receipts carry a fresh machine read | `fix/observed-waits` | `cb2628d6` | merged; gate 1,688 runtime / 1,018 mod |
| C | Reject drafts whose operations empty the stock their own checkpoint requires (`checkpoint_contradicts_batch`) | `fix/checkpoint-contradiction` | `551d4a5b` | merged; gate 1,705 runtime / 1,018 mod |
| D1 | `craft_item` on machine-only recipes returns `requires_machine` facts; bootstrap separates held, placed and running machines | `fix/machine-recipe-facts` | `c567d309` | merged; gate 1,709 runtime / 1,030 mod |
| D2 | Fresh executor context carries active step, contract, latest receipt, bounded recipe summary and refreshed counts | `fix/executor-handoff-context` | | in progress |
| E | Recorded scripted-reply regression of the retained run's four failure shapes | | | queued |
| F | Live ladder (smelt/collect, red unlock, steam lab, green) | | | owner runs it |
