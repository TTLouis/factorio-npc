# Handoff — 2026-09-24 session (rocket path + console redesign)

Working branch: `experiment/jev-agent-architecture-lalubg`.

Push rule: fast-forward push to `experiment/jev-agent-architecture`, which the E2E egg installs from. No repin is needed: the channel egg resolves the branch head at reinstall.

**Never add Co-Authored-By lines to commits (user preference).**

Gates before any push:
1. `pnpm run lint`
2. `pnpm run build`
3. `pnpm run typecheck`
4. `luajit -b packages/autorio/dist/control.lua /dev/null`
5. `grep -c ":slice(" packages/autorio/dist/control.lua` must print 0
6. `pnpm run test` (mod + agent)
7. `node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs` — **do not** add `--test-force-exit`.

Chain the gates with `&&`, never `;`. That mistake is how a commit slipped past a failing luajit (see "Open problem" below).

## Pushed and green (CI + release gates), last green head `9db40a31`

### Rocket path
- `launch_rocket {unit_number}`:
  - new mod task `LAUNCHING_ROCKET` in `rocket_launch.ts`, which never passes a character to `launch_rocket()`;
  - completes only when `force.rockets_launched` rises, within 3600 ticks;
  - `rocket_not_ready` reports `rocket_parts` and `rocket_parts_required`;
  - `getEntityStatus` on a silo shows parts and readiness.
- Goal counters (`rockets_launched`, `items_produced`):
  - count from goal start (`countFrom: goal_start` is the default; `save_start` is opt-in);
  - baseline recorded by the runtime-only `GOAL_BASELINES_RECORDED` reducer event.
- Force-level goal checks work while the NPC is dead (fallback to `game.forces.player`).
- Respawn:
  - a platform surface is skipped;
  - a failed create falls back to Nauvis.
- Transfers move the whole held count, not just the first stack.
- Prompt tracing recovers after a failed write.
- CI no longer uses `--test-force-exit`, which had silently dropped tests.

### Player QoL
- `!airi status` (also `进度` / `状态`) answers from durable state plus a read-only game check. It makes no model call.
- `Stop!`, `pause`, `停止` and `暂停` stop immediately.
- A progress line is printed after each verified slice.

### Dry runs
`deploy/pterodactyl/runtime-v8/rocket-goal-dry-run.test.mjs` has three scenarios:
- the full rocket goal, including restart, provider failure, status, research and launch;
- `rocket_not_ready`;
- death mid-slice.

### Docs
The round is recorded in `docs/NPC_AGENT_HARNESS_STATUS.md` and `docs/NPC_PLANNING_ROADMAP.md` §1.2.1.

## Console redesign (user approved the "Chosen" hybrid mock)

Mock-up: https://claude.ai/artifact/RKkxJFh2h6p16rsE5PpQCL (frame "Chosen").
- Left column: tabbed (NOW / PLAN / ACTIVITY).
- Right column: unchanged (camera, inventory, wanted, equipped).
- Prompt and the PAUSE / FOLLOW / … row stay visible under the tabs.

### Stage 1 — committed locally, NOT pushed: `cd146ce9`
- Title bar: icon buttons Learn / Old tasks / Debug before Close.
  - Sprites `airi-console-{learn,history,debug}-{white,black}` are declared in `data.lua`.
  - The PNGs are drawn by `packages/autorio/scripts/draw_console_icons.py` (stdlib only).
- New module `packages/autorio/src/task_board_console.ts`: title bar, blocked banner, action row. It is fed plain state objects.
- The Controls panel is removed. The action row sits under the prompt: PAUSE (wide) + FOLLOW + ….
  - The … menu holds NEW TASK and TERMINATE; `storage.airi_task_board_more_open` is written only in the click handler.
  - An armed TERMINATE keeps the menu open.
- The blocked plan shows as a full-width banner.
- Status takes the full left-column width.
- Constants are in `task_board_ui_constants.ts`.
- Source-structure tests are updated. The test helpers now also read `task_board_console.ts`.

### Stage 2 — committed locally, NOT pushed: `5371c2c8`
- Runtime:
  - `goalUiView()` in `goal-definition.mjs`;
  - `Session.goalUiView()` in `supervisor.mjs`: 30 s cache, read-only, invalidated on `goal.evaluated`;
  - `syncTaskBoardUi` adds `snapshot.goal`.
- Mod:
  - `TaskBoardUiGoal` plus `sanitize_goal` (at most 6 checks; met is recounted);
  - the Goal card and Now card in `task_board_console.ts` replace the Status panel;
  - the title bar gains a status sprite and label (phase · detail), with NPC / world task / sync in its tooltip;
  - the `TONE_*` tables moved to constants.
- Tests:
  - `task_board_console.test.ts` has fake-GUI render tests;
  - runtime tests are in `goal-definition.test.mjs`;
  - `test-setup.ts` gains `defines.rich_text_setting`.
- Locally all tests pass: mod 741, runtime 863, agent 101. Lint is clean.

## OPEN PROBLEM — resolve before pushing stage 1/2

`luajit -b packages/autorio/dist/control.lua` fails locally:

```
function at line 7901 has more than 60 upvalues
```

The function is `new_combat_controller` in `combat.ts`, which is untouched. Facts gathered:
- It fails even when building the source of pushed commit `9db40a31`. CI's "Parse generated Lua with LuaJIT" step **passed** on that same commit, using the same apt LuaJIT 2.1.
- The same local luajit check passed earlier this session, including on the first stage-2 build.
- Installed TSTL (1.32.0) matches the lockfile. No TSTL plugin is used in the production tsconfig.

Hypothesis being tested when interrupted: the build output is not deterministic between runs, or something in the local environment changed.

Next checks:
1. Build 2–3 times and diff `dist/control.lua` and the luajit result.
2. If the output is deterministic and still fails, compare with CI's artifact, or push stage 1+2 on a scratch branch and watch CI's luajit step. The test is whether CI parses it.
3. If CI also fails, reduce `new_combat_controller`'s upvalues in `combat.ts`. For example, group its tuning constants into one table (the same pattern as `RESOURCE_LAYOUT` / `CONSOLE_LAYOUT`).

## Remaining work after that

- **Stage 3 — tabs.**
  - Add a native `tabbed-pane` in the left column. The selected tab is persisted per player from `on_gui_selected_tab_changed`, never from render.
  - NOW = Goal and Now cards plus the conversation section (`debug_ui.render_ai_reply`; its host is `parent.parent`).
  - PLAN = Goal card plus the existing tracker (shelf + plan).
  - ACTIVITY = the activity feed. Today it is built but hidden inside the tracker; give it its own section and reuse `refresh_activity`.
  - Keep scroll panes alive: toggle `.visible`, never rebuild.
  - Update `activity_scroll_of` / `prompt_field` paths.
  - The blocked banner stays above the tabs.
- **Stage 4 — Latest and merged repeats.**
  - The NOW tab gets the 3 newest activity lines plus an "All activity" button that switches tab.
  - Consecutive identical activity lines merge into one row with `×N`, and the caption is updated in place (keep the diff/append logic in `refresh_activity` intact).
- After each stage:
  - run the full gates, commit (no co-author), and push to both branches;
  - schedule a CI check-in with `send_later`;
  - update the tasks (#2 is in progress; #3 and #4 are pending).
- **Docs:** note the console redesign and that it is not yet seen in real Factorio in `docs/NPC_AGENT_HARNESS_STATUS.md`.

## Unverified in real Factorio (tell the user; they are offline until the 27th)

Rocket path:
- launch timing and the confirmation bound;
- base-game victory handling on a headless server;
- silo transfer overflow into non-input inventories;
- platform respawn.

Console:
- the new console layout as a whole;
- the icon sprites;
- `toggled` on frame action buttons.
