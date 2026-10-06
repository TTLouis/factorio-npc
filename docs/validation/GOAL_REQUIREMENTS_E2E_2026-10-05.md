# Focused goal requirements engine checkpoint — October 5, 2026

Result: **PASS** for scripted first-plan requirements grounding and terminal
locked-craft refusal. A demonstrated ore-classification defect was fixed and
verified in the same bounded scenario. This is an isolated engine fixture, not
fresh-map production acceptance or a live-provider trial.

## Candidate and environment

- Initial implementation inspected after a clean fast-forward:
  `467dd799f11b567484ebd4ceafe17a152e007a53`.
- Initial scenario commit: `b98d65b2fc9fae8a9af86fa3c5bc73e0f02685a3`.
- Ore fix: `a3385471272ef59276dc94fc27ce16b2acab48bc`.
- Installer payload repin: `dfd019bd17252ff35658c271e6a8f3f607e9c37f`.
- Final tested candidate: `483e68c2ddfbc0652286bdde173391c4a1c16e54`.
- Docker image: `factorio-npc-test:requirements-483e68c2`, image identity
  `sha256:d5a421e4bcd2f39bd65c7a0baa2ee42302cabed5aa708b66d73a690b026dcd30`.
  Built with the repository's `tests/factorio/Dockerfile`. The copied runtime
  requirements module matches the candidate after CR normalization.
- Windows host, Docker Desktop Linux engine; Factorio **2.0.77**, linux64 headless.
  Mods: core 0.0.0; base, elevated-rails, quality and space-age 2.0.77;
  autorio 0.1.0. This is the repository's existing Space Age-enabled fixture.
- Versioned map settings: `tests/factorio/fixtures/map-gen-settings.json`, seed
  **424242**, 256×256, peaceful mode. Lane starts from a newly generated internal
  save and runs the standard core actor smoke, including a scripted clear movement
  corridor and exact crafting ingredients. These are fixture conditions.
- **Zero humans**, actor ID **1**; quiet-clock observation advanced 121 ticks in
  2.02 seconds. Container networking **none**, no bind mounts or published ports.
- Planner and interaction replies are scripted. No Jev, DeepSeek, OpenRouter or
  CLI-proxy inference, credentials, shared save resets, deployment or push.

Recent Claude changes added harness-owned locked-recipe/machine requirements,
dependency-first research facts, one first-plan grounding round, terminal refusal
evidence, skill-card recipe locks and NPC time facts. Nested Plan Tracker slices
were already in the starting checkout. This scenario tests requirements only.

## Scenario and observations

Exact objective: **"Automate red science at 20 packs per minute."** The scripted
planner deliberately proposes crafting ten locked red packs before researching
their unlock, then repeats the proposal after the corrective round.

The real compiled mod reports a complete target unlock path:

1. `electronics`: trigger craft 10 copper plates.
2. `steam-power`: trigger craft 50 iron plates.
3. `automation-science-pack`: after both prerequisites, trigger craft one lab.

The machine report names assembler-1, locked behind `automation`, with its
dependency-first research path. The test compares the red-science trigger against
the engine prototype rather than the earlier mocked iron-gear trigger.

Exactly **two scripted planner calls** occur: initial draft and one grounding
round. Both happen before committing a goal definition or admitting gameplay
work. The second prompt contains real target locks, machine facts and exact
triggers. The repeated craft is refused as
`operation_preflight_failed:recipe_locked:automation-science-pack`; evidence names
`electronics` and its copper-plate trigger as next actionable research.

Before/after snapshots match for inventory, recipe state, researched technologies,
actor identity, crafting queue and operation queue. No craft was admitted, no
research was completed, and the goal remains blocked rather than falsely complete.
Trace `req_muvz4d5y_1` correlates requirements loading, the one grounding round and
the refusal. The loaded event includes a reason and `raw_items: 2`.

## Finding, fix and all attempts

| Candidate | Outcome |
| --- | --- |
| `b98d65b2` | Grounding/refusal lane passed, but saved facts revealed a semantic defect: iron/copper ore were treated as locked recipes requiring Space Age asteroid research. |
| `dfd019bd` | Fixed query removed those false requirements. Rerun exited 1 on an overbroad new test assumption that *all* alternative machine paths must fit without truncation. |
| `483e68c2` | Corrected harness assumption; final lane exited 0 with the full grounding/refusal flow and ore regression assertions passing. |

The fix recognizes products of mineable **resource** prototypes as raw acquisition
inputs before searching alternate recipes. It excludes placed machine reclamation,
so mining a machine cannot bypass its construction recipe lock. Two unit
regressions cover those boundaries. Requirements loading now traces the raw-item
count. Locks fell from **9 to 6**, recipe visits from **10 to 7**, raw items rose
from **0 to 2**, and false asteroid requirements disappeared.

The failed intermediate assertion was a harness assumption, not an engine refusal:
optional assembler-3 research legitimately hits the 12-node cap. The final test
requires complete target/assembler-1 paths, absence of false orbital research for
ores, and a truthful global truncation flag for truncated optional alternatives.
Both intermediate facts and the failure are retained below. The cap is unchanged.

## Verification and durable evidence

- Offline Docker runtime: **1,624/1,624**, exit 0.
- Docker mod gate: **967/967**, typecheck, Lua build, generated-Lua check, exit 0.
- Installer generation/check and **9/9** payload tests, exit 0. Payload bytes and
  hash remain unchanged; immutable source reference is repinned to `a3385471`.
- Final repository Docker image build: exit 0; prompt tests **55/55**, mod tests
  **967/967**, typecheck and Lua build passed.
- Focused `requirements` lane: exit 0, including **86 Python runner regressions**
  and standard zero-player actor smoke.

Durable files in [goal-requirements-2026-10-05](goal-requirements-2026-10-05/):
[initial payload](goal-requirements-2026-10-05/initial-engine.json),
[intermediate query](goal-requirements-2026-10-05/intermediate-requirements.json),
[intermediate assertion failure](goal-requirements-2026-10-05/intermediate-assertion-error.txt),
[final engine result](goal-requirements-2026-10-05/final-engine.json),
[behavior trace](goal-requirements-2026-10-05/final-behavior.jsonl),
[scripted prompts](goal-requirements-2026-10-05/final-prompts.json),
[RCON transcript](goal-requirements-2026-10-05/final-transcript.json), and
[quiet-clock evidence](goal-requirements-2026-10-05/simulation-clock.json).
Full build/gate/process logs remain locally under
`test-results/requirements-2026-10-05/` (gitignored). Exited test containers were
removed after evidence export; shared stacks were untouched.

Reproduce from this candidate with repository commands:

```sh
docker build -f tests/factorio/Dockerfile -t factorio-npc-test:requirements-483e68c2 .
docker run --rm --network none -e NPC_TEST_LANES=requirements \
  -e NPC_TEST_CANDIDATE_SHA=483e68c2ddfbc0652286bdde173391c4a1c16e54 \
  factorio-npc-test:requirements-483e68c2
bash scripts/test-local.sh all
```

## Remaining boundary and next small test

No runtime failure remains in this refusal scenario. It does not establish ordinary
unlock progression, requirements refresh after research, offshore-pumped-fluid
classification, autonomous layout selection, UI rendering, upstream production,
sustained red-pack output or the three normal-enemy fresh-map acceptance trials.
Resource prototype facts do not prove a reachable deposit or extraction machinery.
Unlock-selection differences between skill cards and requirements remain untested.

Next bounded engine target: **one furnace smelts ten copper plates through native
operations with zero humans; verify `electronics` completes through its ordinary
trigger and the refreshed requirements drop that prerequisite.** Keep it an
isolated fixture, with scripted replies and no direct research-state assignment.
Checkpoint that result before adding the steam-power/lab unlocks or production.
