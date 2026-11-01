# NPC Grounded Bootstrap E2E Findings — 2026-09-17

## Purpose

This record captures the real-provider / real-Factorio behavior observed in the exported `airi-prompts(6).jsonl` and `airi-behavior(6).jsonl` traces.

The capture exercised a deliberately high-level early-game request without exact prototype names:

> 建立一个稳定的早期资源供应体系，让我们不用一直手动采集基础资源。

The purpose of this document is not to freeze every failure in that capture as a current branch bug. The integration branch moved immediately afterward and several targeted fixes landed after the captured runtime was already running. This record therefore separates:

1. behavior proven by the captured deployed runtime;
2. post-capture fixes already present on `feat/npc-transition-work`;
3. open architecture / E2E gaps that remain relevant after those fixes.

Do not use this document as proof that the post-capture fixes are already validated in a freshly deployed E2E server. They still require a new install/runtime pass.

## Capture summary

The first five requests that reached a terminal event consumed, in aggregate:

- 51 provider calls;
- 777,840 input units;
- 641,536 cached input units;
- 136,304 cache-miss input units;
- 35,398 output units;
- 813,238 total units;
- 57 tool calls.

That is excessive for the intended early-game goal and is useful evidence that correctness and efficiency are coupled here: malformed observation recovery, exact-name bootstrap gaps, repeated discovery, and plan-state drift all increase provider work.

The sixth request was still in progress when the trace ended.

## Finding A — exact-name bootstrap is still the main architecture gap

The system prompt already tells the model that it is an in-world NPC in Factorio and already tells it not to rely on remembered Factorio wiki knowledge when deterministic tools can answer the question.

The current deterministic surface is strong once an exact identity is known:

- `getRecipeDetails(item_or_recipe)` can resolve exact recipes/products and compatible machines;
- `getPrototypeDetails(name)` can describe an exact item/fluid/entity and its engine-backed capabilities;
- `solveProduction` can discover bounded enabled recipe routes from an exact target material;
- `findLongRangeEntities(name)` can find an exact world prototype at long range;
- `findNearestEnemy` demonstrates that semantic discovery without an exact hostile prototype is possible when Factorio exposes an appropriate engine primitive.

The E2E capture proves the remaining bootstrap gap:

```text
high-level intent
"automate basic resource extraction"
        ↓
(no grounded capability-to-identity bridge)
        ↓
model memory / guessed concept
"pickaxe", "miner", "iron-mining-drill", "hand drill"
        ↓
exact-name tools and operations
```

Examples from the capture include plans referring to `采矿镐`, `手钻`, and an attempted `craft_item("iron-mining-drill")`.

This should remain the highest-priority open harness design item. The goal is not to teach the model vanilla Factorio or to embed a mod encyclopedia. The running game should answer bounded engine-backed capability queries and return a small canonical candidate set that the model can inspect and choose among.

### Scale guard for overhaul mods

Capability discovery must remain bounded.

It should prefer narrow engine-backed dimensions such as prototype type, resource category, crafting category, energy source, force availability/unlock state, or other stable prototype metadata. It should not dump every matching prototype from a large modpack.

If a query produces too many candidates, return an explicit bounded failure / narrowing requirement rather than materializing hundreds of prototypes.

The existing production-planning limits are a useful architectural precedent: bounded producer counts, bounded route candidates, bounded graph depth, and explicit `LIMIT_EXCEEDED` behavior.

## Finding B — tool-validation failures were incorrectly escalated into mutation recovery in the captured runtime

The capture repeatedly showed provider turns containing 5 or 6 observation tool calls while the runtime accepted at most 4.

In the old deployed behavior:

```text
5/6 observation calls
→ Invalid tool call batch
→ repeated validation failure
→ duplicate/no-progress path
→ tools disabled
→ strict-JSON recovery
→ model still lacks deterministic facts
→ guessed or misplaced identity/tool
→ world mutation attempt
```

One concrete first-request chain was:

- two oversized tool batches;
- duplicate `getInventoryItems`;
- no-progress recovery;
- read-only `getRecipeDetails` and `findLongRangeEntities` incorrectly placed in `operations[]`;
- no-tool recovery then guessed `iron-mining-drill`;
- mutation admission failed.

### Post-capture branch status

This failure class is now specifically targeted by commit `80bfd213` (`fix(agent): separate tool validation from observation recovery`) and its follow-up tests.

The current source classifies oversized tool batches as `tool_validation`, keeps tools enabled, asks for a bounded <=4 subset, preserves earlier observations, and separates that retry budget from duplicate-observation/no-progress handling.

Status: **addressed in current source; requires fresh deployed E2E verification.**

## Finding C — recipe-details Factorio 2 API regression

The captured runtime threw:

```text
LuaRecipe doesn't contain key categories
autorio_knowledge.recipe_details
categories_for
```

when the model requested `getRecipeDetails("burner-mining-drill")`.

This deterministic knowledge failure pushed the model back toward weaker remembered knowledge and older fallback tools.

### Post-capture branch status

Commit `c9f05895` (`fix(autorio): resolve recipe categories through Factorio 2 runtime API`) and follow-up test `72211518` target this exact regression.

Status: **addressed in current source; requires fresh real-Factorio verification.**

## Finding D — invalid resource identity was admitted too late

The captured runtime eventually emitted:

```json
{
  "name": "gather_resource",
  "args": {
    "resource_name": "tree-02-red",
    "count": 4,
    "search_radius": 64
  }
}
```

A tree is not a Factorio `resource` prototype and should not reach mutation admission as if it were ore.

### Post-capture branch status

Commits `685da74c` and `7956b15d`, followed by runtime-v8 preflight exposure and tests, now add deterministic identity/kind preflight for relevant operations and explicitly classify invalid `gather_resource` targets.

Status: **addressed in current source; requires fresh deployed E2E verification.**

## Finding E — first-turn admission failures previously erased useful plan context

In the captured runtime, an accepted first plan could reach mutation admission before durable plan/conversation persistence. If admission failed, the UI could show:

- the user goal;
- `WORLD = IDLE`;
- an error;
- no active plan;
- zero task conversation messages.

This made a mutation-admission failure look like the model had never formed a plan at all.

### Post-capture branch status

The post-capture sequence beginning at `1cd2561f` persists accepted plans before risky mutation admission and introduces an explicit admission lifecycle. Follow-up commits preserve underlying Factorio failure diagnostics, failure indexing, and no-replay semantics.

The no-replay rule remains correct: a multi-operation Factorio batch cannot be assumed transactional or rolled back merely because a later operation failed.

Status: **addressed in current source; requires fresh deployed E2E verification.**

## Finding F — output-budget recovery improved, but capture/runtime version must be distinguished

The capture contains output-budget recovery requests that correctly:

- kept observation tools available;
- emitted `thinking: {"type":"disabled"}`;
- reduced the output budget for the compact continuation path.

The same capture also contains generic strict-JSON recovery requests that did not carry the same visible no-thinking encoding.

Current source has since broadened the no-thinking policy to generic recovery attempts for DeepSeek-compatible models.

Because the exported trace was produced while the branch was moving and before the later recovery commits were deployed, this is a **deployment-version verification item**, not evidence that current HEAD still has the old policy.

Status: **fresh E2E needed before drawing a current-runtime conclusion.**

## Finding G — Task Board semantic completion is not safely bound to executed work

This is the most important new correctness finding from this capture after grounded capability discovery.

In request `req_mu64q93x_5`, the canonical Task Board still contained older semantic steps such as:

1. confirm status/inventory;
2. scout resources;
3. make pickaxe/furnace/chest tools;
4. place mining/furnace automation;
5. report results.

The actual later operations were resource gathering.

After a successful iron gathering batch, the board showed step 3 active.

After the next successful **coal gathering** batch, the board advanced to:

- step 3 `制作采矿镐、石炉、箱子等基础工具` = **completed**;
- step 4 `在矿点放置采矿机/石炉实现自动采炼` = active.

But the completed receipt only proved a walking/mining batch for coal.

After the next successful **copper gathering** batch, the board advanced again to:

- step 4 `在矿点放置采矿机/石炉实现自动采炼` = **completed**;
- step 5 = active.

But the completed receipt only proved a walking/mining batch for copper. No mining drill/furnace automation had been placed.

This is not only a presentation issue. It breaks the intended meaning of a canonical Task Board: completed semantic steps can become false facts supplied back to later model turns.

### Likely mechanism

The current Task Board model is primarily positional:

- steps before `active_index` are marked completed;
- model-proposed `currentStep` / replans can move the active index;
- a generic operation receipt is attached to the currently active step;
- successful batch completion proves that a submitted batch completed, but not that the arbitrary semantic description attached to that position was fulfilled.

A generic receipt such as:

```text
walking_to_entity + mining completed
```

must not by itself prove:

```text
"build mining/furnace automation" completed
```

### Required architecture invariant

Operation-batch completion and semantic-plan-step completion must be distinct claims.

A future fix should establish an explicit relationship among:

```text
semantic step
→ admitted operation batch / intended evidence
→ operation receipt
→ optional world verification
→ semantic step completion
```

At minimum, the harness must refuse to advance a canonical semantic step solely because a provider supplied a later positional `currentStep` when the evidence attached to prior steps does not establish their intent.

This should be treated as a high-severity correctness issue, immediately after the grounded capability bootstrap priority.

Status: **open; needs design + deterministic regression before relying on Task Board completed steps as durable truth.**

## Finding H — operation identity safety is not the same as operation feasibility

The capture also showed valid identities being used in infeasible actions.

For example, after collecting resources the model attempted additional `stone-furnace` crafting without enough stone for the requested count. Earlier it attempted a multi-craft batch that included items for which its inventory did not contain the necessary ingredients.

Identity preflight can prove that `stone-furnace` is a real craftable identity. That is not the same as proving that the actor can currently craft the requested count from its live inventory / queue state.

Before expanding preflight scope, audit what current `craft_item` admission already checks and what evidence is available from the native crafting runtime. Avoid duplicating Factorio recipe arithmetic in the LLM harness.

Status: **open question / audit item; do not assume the new identity preflight solves feasibility.**

## Finding I — broad local observation can become expensive and low-value

One trace used an unfiltered radius-64 nearby scan with roughly 1,931 matches and a truncated 60-entity response, mostly exposing irrelevant trees/rocks for the production decision.

This is not necessarily a runtime bug: the model asked for a broad scan. It is useful efficiency evidence.

Prefer narrow type/name/capability observations and higher-level semantic production/resource summaries where possible. A large modpack makes this more important.

Status: **efficiency follow-up, lower priority than grounded identity and Task Board correctness.**

## Acceptance gates for the next fresh E2E

A fresh server/install E2E should verify the post-capture fixes before treating them as proven:

1. a provider may emit >4 observation calls and be repaired with tools still enabled, without destructive/no-tool escalation;
2. `getRecipeDetails("burner-mining-drill")` returns deterministic Factorio 2 recipe data;
3. a tree cannot enter `gather_resource` mutation admission;
4. an accepted first-turn plan remains visible if preflight/admission fails;
5. the underlying Factorio admission failure and operation index remain visible while the batch is not replayed;
6. generic recovery uses the intended no-thinking provider path where supported;
7. most importantly, successful mining receipts must not mark unrelated crafting/construction semantic steps complete.

A separate grounded-bootstrap benchmark should then start from a high-level production/resource goal containing no exact prototype names and verify that the model reaches valid current-game identities through bounded deterministic discovery rather than remembered vanilla Factorio knowledge.

## Status at documentation time

The integration branch was still moving while this document was prepared. The fixes listed above landed after the trace capture. Always refetch `feat/npc-transition-work` and record the exact deployed SHA before the next E2E comparison.

This document is evidence and design context, not an implementation task list.
