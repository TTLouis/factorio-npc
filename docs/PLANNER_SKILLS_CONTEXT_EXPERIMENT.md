# Planner discovery and factory-guide comparison

Owner: Codex chat 01a179b0. Requested October 27, 2026. Task branch
`feat/planner-skill-discovery`, based on reviewed local Jev integration
`aedca8193d1c4944b4cc46a194438918a425d05b`.

The owner requested wider skill lookup now that planning and execution are
separate, and skipping Jev skill lookup decisions. The next experiment has
exactly two concurrent trials, both Sol planner / Luna executor: the current
native library versus that same library plus direct factory-building guides.
This document does not claim a live trial has started or gameplay improved.

## Shared discovery policy

Protocol 3 planners receive up to ten deterministically ranked native cards.
The harness opens at most six details at a planning boundary within the existing
three-second total read deadline. The logical-task cache holds six compact
details; the planner prefix holds at most six within 32,000 JSON characters.
Each detail retains the existing 7,000-character compaction bound. Ranking,
timeouts and cancellation/actor/goal/lineage fences remain deterministic.

The planner passes selected `execution_guidance.skillIds` references for each
step. The harness supplies their matching already-loaded instructions in the
executor prefix, at most three and 16,000 JSON characters. The executor does not
search or reopen the skill table: protocol 3 omits `findSkills` and
`getSkillDetails` from both its ordinary tools and targeted-read enum, and the
runtime rejects injected calls before any part of that tool batch is sent. A
caller-supplied prepared batch cannot bypass this check. The harness now saves
and automatically restores the exact selected instruction copies, as described
below. It checks them before executor turns and inference;
restoration does not depend on the executor asking for review.

The larger shared cache survives role changes;
it does not send unrelated planner strategies to the executor. A planner cannot
reference a skill omitted from its rendered context, or choose a per-step set
whose combined detail JSON exceeds the executor's 16,000-character limit.
Rejecting that draft leaves the planner to select a smaller set before commit;
the executor does not have to reopen a detail dropped by its smaller ceiling.
The existing post-step Jev
summary and handoff remain small; this is not a change to gameplay read rates,
recovery allowances, native admission or immutable step authority. Protocol 2
keeps five automatic discovery cards and three retained/rendered details.

The planner's explicit `findSkills` tool accepts one to ten results, default three,
consistently in the advertised schema, serializer, native implementation and
[contract manifest](../contracts/factorio-tool-contract.json). It remains a
discovery tool: results do not establish that details were loaded. Protocol 1/2
callers retain their existing discovery surfaces.

## Automatic restart restoration

At a selected-skill plan commit, the harness captures the compact instruction
records that were actually loaded for the planner. It binds them to the NPC
memory key, goal, plan/version and complete ordered step/reference selection,
and hashes that scope and content with SHA-256. Known skill revisions are
preserved. The canonical memory snapshot includes `planner_skill_handoffs`;
its state-file write must succeed before the first executor handoff.

The record contains at most six selected skills and 64,000 JSON characters.
There is one current record per memory key, at most 128 keys; capacity refuses
a new capture rather than silently dropping it from persistence. Each active
step still receives at most three details within its existing 16k limit.
Snapshots are static candidate instructions, never fresh world facts or native
execution/completion authority. Goal, plan and all recovery spending stay intact.

Before an executor turn or model request, and whenever its context is rendered,
the harness verifies the persisted scope, content hash, detail shape and active
selection. It automatically refills missing or altered transient cache entries
from the saved copies. Actual final message assembly also supplies the pinned
block on closed/correction prompt overrides, so an alternate prompt path cannot
omit or substitute it. A later library edit cannot change a committed procedure.
No library lookup, model/Jev request, gameplay operation, or recovery allowance
is needed for restoration. Repeated restarts use the same saved record.

Missing, corrupt, oversized or scope-mismatched records fail closed with
`planner_skill_handoff_unavailable`, classified as a harness guard. A failed
durable write likewise stops before executor handoff. Old saved plans that
reference skills but predate these records cannot recover their original
instructions from an unversioned current library and therefore stop safely;
the harness does not invent a matching snapshot. Plans without selected skills
need no such record. The two planned cold trials must use the new writer.

Trace events distinguish `skill.handoff_pinned`, `skill.handoff_restored`,
`skill.handoff_refused` and actual `skill.context_presented`. Historical replay
tests that predate this metadata explicitly inject synthetic test-only skill
records in memory. Their original captured JSON and plan semantics remain
unchanged; those replays do not prove the original instruction content or
production benefit. The new disk-restart regression uses actual commit-time
capture and state-file load, not that fixture helper.

The live supervisor no longer wires `skillDecisionProvider`, so native ranking
and planner choice require no Jev skill-ranking request, including shadow calls.
Other Jev routes retain their existing providers. Historical explicit-injection
shadow fixtures and cancellation/ledger regressions remain supported for
compatibility; they are not wired into the live supervisor. A deterministic
`skill.ranked` event records `deterministic_library_ranking`.

`skill.offered` records the selected discovery policy. For protocol 3, the new
request-correlated `skill.context_presented` event records actual assembled
provider role, loaded IDs, presented IDs, character count and caps. Full supplied
prompt capture is authoritative; library presence, a discovery card, loading,
planner selection, executor exposure and native success are separate measures.

## Treatment data

The [candidate playbook pack](../packages/autorio/src/fixtures/factory-playbooks-v1.json)
contains six native schema-v1 records:

| Added skill | Concrete guidance |
|---|---|
| `factory-playbook-fuel` | Startup fuel, coal extraction, self-fueling and surplus delivery |
| `factory-playbook-direct-smelting` | Miner output geometry, receiving furnace, separate fuel and plate output |
| `factory-playbook-steam-power` | Shoreline intake, water/steam ports, electrical load and sustained boiler fuel |
| `factory-playbook-ingredients` | Only required intermediates inside the target line, live recipes and connected transfers |
| `factory-playbook-red-science` | Native unlocks, hand-crafted research bootstrap, Automation, then sustained assembly and output |
| `factory-playbook-belt-smelting` | Connectable smelting row with ore/fuel inputs, proven first cell and plate output |

These are experimental candidate guides, not verified blueprints or engine
facts. The imperative first sentence fits the short discovery card; numbered
procedures live in constraints retained by the real context compactor. The
recorded tests must prove that no procedure is clipped. Recipes, research costs,
geometry, capacities and throughput must be obtained from live deterministic
tools. The science bootstrap quantity is the current research requirement, not
a permanently assumed ten packs. Bootstrap packs never count as automated
output. This does not restore the retired `automation-science-bootstrap` ID or
claim that a straight-line layout proves sustainable production.

The pack is not imported into `BASIC_SKILL_DEFINITIONS` and is disabled by
default. Import only into the treatment world's native registry through the
existing `autorio_skills.put_definition` interface, before inference. Record
each original submission/receipt and canonical readback. Refuse ID collisions
and preserve every baseline definition. Snapshot both libraries; their exact
set difference must be these six IDs. Import failure is a pre-inference failure,
not permission to retry a provider or restart an already-started lane.

## Next two-run comparison

Both lanes use planner `gpt-6.1-sol` and executor `gpt-6-luna`, the same supported
high cap/adaptive effort policy, same shared lookup code, immutable candidate,
goal/starter, normal 1x construction, 60-minute cap, acceptance and capture
contracts. Each has its own fresh world/data, actor/goal, Docker project, ports,
tunnel, recorder and short-context Luna-low observer. Keep resource ownership,
strict stop/save/load, original-reply/plan/receipt capture, terminal/causal
indexes, sealing, metrics and cleanup requirements from workspace AGENTS.md.

Lane A retains the unchanged native library. Lane B adds only the six playbooks.
Use matching seed/map-generation settings only after a newly reviewed two-lane
runner profile supports them and native initial-world checks pass; the older
runner deliberately requires distinct seeds. Never silently bypass that check.
If matching cannot be established, report the seed confound and avoid causal
ranking. Even a matched single pair is exploratory, not a reliable effect-size
estimate.

Measure native success, equal-milestone time, sustained output, bootstrap versus
assembler science counts, refusals/recovery, request latency, cache/uncached/
output/reasoning usage and verified-rate costs. Also measure discovery, loading,
actual planner/executor exposure, selection and instruction-following evidence.
Extra context has a token/latency cost. An unexposed treatment or common harness
blocker makes the context-effect conclusion incomplete.

## Dependencies and checkpoint

This task does not edit Claude's placement recovery. The registry currently
marks `fix/placement-candidate-recovery` active/unmerged. Freeze the reviewed,
integrated repair plus this reviewed change before the next comparison; do not
reuse the known Run BC blocker. Source integration, merged gates and the
separate installer payload repin remain required before promotion. No push or
deployment is authorized by this preparation.

Acceptance: native library/schema parity; wider bounded planner delivery;
selected-only executor delivery; context-ceiling refusal; zero live skill Jev
wiring; unmodified baseline library; full guide preservation; full offline gate;
independent review. Native production benefit remains unproven until the
separately frozen authorized two-run batch is completed.
