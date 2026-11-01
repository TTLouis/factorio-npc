# SGLuna — NPC Console / Project Context Handoff

**Status:** Conversation checkpoint is handoff-ready and safe to archive. The repository/project itself is still active.

**Verified at:** 2026-09-16 local time

**Repository:** `TTLouis/factorio-npc`

**Branch:** `feat/npc-transition-work`

**Verified branch HEAD before this document commit:** `c280378323d93846f8f6708fdd7a5cf6e6e4ea9b` (`docs: add production planning handoff`)

**CI at that HEAD:** GitHub Actions run `35166296815` completed successfully.

This file preserves the project decisions and working context from the NPC Console / E2E discussion so the chat can be archived without losing design intent. It is a handoff document, not a replacement for the implementation-specific authority documents listed below.

## Authoritative project references

Before making follow-up changes, use these as the primary sources of truth:

- `docs/NPC_AGENT_HARNESS_STATUS.md` — current single-NPC integration/promotion status.
- `docs/NPC_AGENT_HARNESS_PLAN.md` — current NPC harness roadmap.
- `docs/NPC_CHARACTER_ARCHITECTURE.md` — standalone actor architecture.
- `docs/NPC_RELIABILITY_WORK.md` — detailed reliability work and historical E2E context.
- `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md` — current production-planning handoff.
- `docs/NPC_LEARNING_BOOTSTRAP_E2E.md` — learning/bootstrap E2E context.
- `deploy/pterodactyl/README.md` — current packaged deployment/operation guidance.
- `packages/autorio/src/task_board_ui.ts` — current NPC Console implementation.
- `packages/autorio/src/task_board_activity.ts` — activity history/filter/follow behavior.
- `packages/autorio/src/task_board_debug.ts` — runtime/debug UI projection.
- `deploy/pterodactyl/runtime-v8/canonical-task-board-memory.mjs` — canonical task-board/runtime memory behavior.
- `deploy/pterodactyl/runtime-v8/supervisor.mjs` — runtime orchestration and UI bridge.

## Durable product and architecture decisions

### Runtime state is authoritative

The Factorio runtime/world state is canonical. The UI is a projection and control surface, not a second source of truth.

Do not solve UI inconsistencies by introducing duplicated mutable state. When a UI element shows a state, it should derive that state from the authoritative controller/runtime whenever possible.

The same rule applies to task execution: the canonical task board should own goal/step execution state. Compatibility views may be derived from it, but parallel mutable copies should not be allowed to drift.

### Use Factorio-native UI language

The NPC Console should look and behave like a compact Factorio control surface rather than a generic web/SaaS dashboard:

- dense but readable information;
- native frames, buttons, icons, status colors, scroll panes, and tooltips;
- minimal wasted space;
- stable geometry while live state updates;
- high-value information visible without opening multiple oversized panels.

Avoid giant buttons, unnecessary cards, repeated labels, or duplicated status displays.

### One state should have one primary UI expression

The Follow interaction established the rule: because Follow is already a toggle, the state belongs in the toggle itself rather than in a separate `FREE/FOLLOWING` badge plus another status row.

The same principle should be applied elsewhere: do not repeat a backend state in several UI locations unless each representation has a distinct operational purpose.

### Map first, vehicles later

The agreed sequencing is:

1. continue the map/spatial-control functionality;
2. make operations that naturally belong on the map available from the map where practical;
3. return to vehicles, trains, and space platforms later.

The map should become the primary spatial control plane. The task tracker is the textual execution summary, while chat is primarily for intent and exceptions rather than routine spatial micromanagement.

Current map-related modules already include construction, deconstruction, upgrade, and remote operations. Their presence does not mean the final map-control UX is complete.

## Current NPC Console direction and implementation state

The current implementation has advanced substantially beyond the early screenshot discussed in this chat. Inspect the current source before assuming an old visual/layout problem still exists.

### Layout

The console is now a two-column layout:

- the left side contains compact status/controls, AI response/debug projection, the plan/activity tracker, and `Prompt SGLuna`;
- the right side contains the NPC world preview and resource/equipment information.

Important layout decisions from this discussion:

- `Prompt SGLuna` must stay constrained to the left-side control area rather than stretching under the preview;
- left-side first-level section gaps should use one consistent spacing value;
- Status and Controls should use their natural compact height rather than being vertically stretched;
- the two sides should feel vertically balanced instead of leaving a large dead area under the preview;
- the preview may grow vertically to make useful use of the right column.

### Prompt and UI control bridge

The UI prompt is the dedicated SGLuna entry point. Users should type requests directly into `Prompt SGLuna`; they do not need a chat prefix.

The preferred chat command is `!luna ...`; legacy `!airi ...` remains a compatibility alias routed through the same input path.

Prompt, Pause, Terminate, Follow, and related UI actions must not depend on stdout log markers being scraped by the Node runtime. The current direction is the deterministic mod-side input queue exposed through `autorio_task_board.drain_inputs`, consumed through the RCON/runtime lane.

Relevant runtime tests include `task-board-ui-control.test.mjs`, `task-board-ui-heartbeat.test.mjs`, and `rcon-ui-lane.test.mjs`.

### Follow

Follow is a toggle control. Do not reintroduce duplicate Follow status rows or a separate global `FREE/FOLLOWING` badge solely to repeat the toggle state.

Exceptional follow state, such as a path/recovery failure, may appear separately because it is actionable information rather than a duplicate state label.

### Preview

The NPC preview has a player-controlled zoom slider. Zoom is UI-local presentation state and must not modify NPC/runtime world state.

The live console refresh must update the camera in place instead of rebuilding the preview hierarchy each second, because rebuilding interrupts an in-progress slider drag.

The preview should remain useful on tall displays through responsive minimum height rather than relying on a single fixed square size.

### Tracker and activity UI

`Plan & Activity` is one operational panel with two different responsibilities:

- plan/steps answer: **where is the goal currently?**
- activity answers: **what happened that brought execution here?**

The current implementation already contains important usability work:

- separate scroll panes for plan and activity;
- stable activity identity when the runtime supplies event IDs;
- bounded synchronized activity history;
- PLAN / OBS / ACT / RESULT / ISSUE filters;
- LIVE vs paused-follow behavior for the activity feed;
- manual scrolling can stop auto-follow;
- hover avoids moving the feed under the pointer;
- deterministic Factorio-time timestamps;
- in-place refresh so tracker scroll state survives normal heartbeat updates.

Do not regress these behaviors when changing tracker rendering.

### Section headings own their feed controls

Every control that filters or pauses a feed lives in that section's subheader,
beside the section title - never in a second header row inside the section body.
`Plan & Activity` and `Current Task Conversation` used to disagree about this,
which put the same kind of selector in a heading in one section and under the
heading in the other.

All of them are sized through `style_feed_button` in `task_board_activity.ts`,
so a new feed cannot quietly reintroduce a differently-shaped control.

### The mod-GUI button reports the model in use

The top-left console button wears an avatar for the vendor behind the current
model, with the vendor and the exact model identifier in its tooltip. The
mapping lives in `packages/autorio/src/task_board_provider.ts`, driven by the
`provider_model` the runtime reports in its debug snapshot - which is seeded
from the configured `OPENAI_MODEL` and then re-reported per provider response,
so the button tracks the model actually answering rather than a startup value.

There is no house avatar for a model no vendor claims. The button answers "which
vendor is answering", so with no answer it keeps its default sprite rather than
showing a fourth face that would mean something else.

Each vendor has several avatars, and a player is rolled one when they join, so
the console does not look identical every session. The roll is per player and
lives in `storage`. That placement is the point: the console is synchronized
game state, so which sprite a player's button shows cannot be decided while
drawing or from anything client-local, and it must not be drawn from the map's
synchronized RNG either. See `packages/autorio/graphics/icons/provider/README.md`
for the import pipeline and the framing rules that keep a set looking like one
set.

Keep `data.lua` and the resolver in step in both directions, ids and variant
counts: an id or count in `data.lua` without a committed PNG is a hard mod-load
failure, and a resolver id or count with no prototype leaves the button blank or
on its default sprite for whichever players rolled the missing variant.

## Steps / Activity backend direction

During this discussion the user explicitly called out that Steps and Activity still need backend work. Since the branch has moved substantially since that point, treat the following as the agreed architecture direction and **first inspect the current canonical-task-board, behavior-trace, activity-identity, durable-plan, and UI projection code to determine what is already satisfied**.

The desired conceptual hierarchy is:

```text
Goal
└─ Step
   └─ Attempt
      ├─ Observation
      ├─ Operation batch
      ├─ Receipt
      └─ Verification
```

### Stable step identity

A step should have a stable identity that does not depend on matching its human-readable description. Rewording a description must not accidentally create a different step, and two similar descriptions must not collapse into one.

Where execution data allows it, correlate events using explicit identifiers such as:

- `goal_id`
- `step_id`
- `attempt_id`
- `batch_id`
- request/turn/trace ID

### Operation completion is not automatically step completion

This is a critical invariant:

> **Operation complete != Step complete.**

A simple deterministic step may be verifiable directly from its operation receipt. A composite step such as building a production block may require additional world-state/topology verification after placements finish.

The backend should make this distinction explicit rather than assuming that one completed batch means one completed plan step.

### Verification policy should be deterministic where possible

After an operation finishes, the runtime should decide whether the step is:

- verified complete;
- waiting for a deterministic observation/readback;
- blocked/failed;
- ready for another attempt.

Examples:

- gathering a fixed count of an item may be directly receipt/inventory-verifiable;
- placing an entity should verify the entity exists in the intended world state;
- setting a recipe should verify readback;
- a production block may require topology, recipe, inserter, belt/lane, fluid, or throughput checks before the step is actually complete.

### Activity should be an auditable event projection

Activity should converge toward a chronological event ledger generated by runtime/tool/world events rather than prose invented by the UI.

Prefer observable events such as:

- step started/completed/blocked;
- observation/result received;
- operation batch admitted/started/completed/failed;
- verification succeeded/failed;
- retry/recovery/replan;
- pause/resume/terminate;
- goal completed.

Never fabricate hidden chain-of-thought. If a reasoning summary is shown, it should be an explicit runtime/model-supplied summary intended for display, not hidden model reasoning reconstructed by the UI.

### Durable history vs ephemeral live phase

Keep a conceptual distinction between durable execution history and transient live status.

Durable examples:

- step transitions;
- operation/receipt transitions;
- verification results;
- blockers;
- pause/resume;
- goal completion.

Ephemeral examples:

- thinking;
- waiting for provider;
- currently calling a tool;
- transient execution heartbeat.

A restart should not resurrect a stale `THINKING` state, while meaningful execution history should remain useful for E2E debugging.

## E2E and agent-harness principles

Real bad NPC decisions should become reproducible regression cases.

When E2E finds a failure, prefer improving deterministic observations, tools, planning constraints, runtime verification, and structured operations before making the system prompt larger.

The system should remain usable with smaller/cheaper models by moving Factorio facts and constraints that can be determined locally out of model inference.

The desired debugging trace remains:

```text
player request
→ request / turn
→ model + tool actions
→ runtime / world effects
→ verification / result
```

Persistent behavior logging and IDs should make that chain traceable end-to-end.

## Production-planning principles to preserve

Production planning must account for real game constraints rather than asking the model to guess them. Relevant factors include:

- recipe input/output expansion or compression;
- machine count and crafting speed;
- direct insertion when appropriate;
- belt speed and lane capacity;
- inserter throughput and research-dependent behavior;
- stacked belts/stacking capacity;
- fluid and topology constraints;
- actual measured transport capacity when assumptions are uncertain.

Do not hand the model an unvalidated throughput assumption when a deterministic calculation or live measurement can establish the value first.

The current production-planning implementation is already substantial; use `docs/NPC_PRODUCTION_PLANNING_HANDOFF.md` and the current `production_planning*`, `production_topology*`, `throughput_capacity*`, and `throughput_measurement*` modules before planning more work.

## Pterodactyl configuration authority

The deployment configuration rule remains:

> **Pterodactyl Egg/environment variables are the source of truth.**

`sgluna-config.json` may persist non-secret/default/runtime-visible values, but it must not override an environment value.

Important environment-controlled values discussed during this work include:

- `OPENAI_MODEL`
- `OPENAI_API_BASEURL`
- `PROVIDER_TIMEOUT_MS`
- `MAX_PROVIDER_REQUESTS_PER_HOUR`
- `FACTORIO_USERNAME`
- `FACTORIO_TOKEN`
- other existing runtime Egg variables.

## Recommended continuation order

For a new chat/agent continuing from this checkpoint:

1. Read the current branch HEAD and CI before changing anything; this integration branch moves frequently and multiple agents may work concurrently.
2. Read `NPC_AGENT_HARNESS_STATUS.md` and the topic-specific handoff doc before assuming an older chat state is current.
3. For Steps/Activity work, inspect the existing canonical task-board memory, behavior trace, activity identity/history, and durable-plan implementation first; map the agreed Step → Attempt → Batch/Receipt → Verification model onto what already exists instead of duplicating it.
4. Continue the map/spatial control plane and make spatial operations map-native where practical.
5. Continue real E2E regression harvesting and deterministic production-planning/throughput validation.
6. Return to vehicle/train/space-platform interaction after the map control foundation is in a good state.
7. Treat swarm/multi-agent coordination as later work unless the branch/task explicitly changes scope.

## Archive note

This conversation can be archived after this checkpoint is committed. Its durable project decisions are preserved here, while current implementation truth remains in the branch source, tests, CI, and the authority documents listed at the top of this file.

> Compatibility note: the underlying runtime actor identity remains `AIRI` / `airi`; console branding and deployment controls are SGLuna.
