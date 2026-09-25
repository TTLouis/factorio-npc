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

### Stages 1–4 — all pushed to both branches
- `cd146ce9` stage 1: title-bar icons, the action row and the … menu, the blocked banner.
- `5371c2c8` stage 2: the Goal and Now cards, and `goalUiView()` in the runtime.
- `e4919e38` the LuaJIT fix: `new_combat_controller` in `combat.ts` captured about 70 module locals, over LuaJIT's 60-upvalue limit. Its tuning constants are now one `COMBAT` table (36 captures). CI and release gates are green on this commit.
  - Why CI had passed before is unexplained: a local build of `9db40a31` failed the same check. The fix removes the dependence either way.
  - Pitfall: `pnpm run test` overwrites `dist/control.lua` with a 26-line stub. Run luajit right after `pnpm run build`, before the tests.
- `940d7ad8` stage 3: NOW / PLAN / ACTIVITY tabs.
  - A button strip (not a native tabbed-pane: its content padding is not settable from Lua) and three pages, switched by `.visible`.
  - `storage.airi_task_board_tab`; clicks go through the `airi_console_tab` tag.
  - The activity feed moved out of the tracker into its own section.
- Stage 4: the Latest card (3 newest rows plus "All activity") and merged ×N repeats.
  - `activity_rows` / `activity_row_diff` in `task_board_activity.ts`.
  - A row matches by its first or last entry, so new repeats and trims update in place.

## Remaining ideas (not started)
- An ACTIVITY tab caption with an unseen count while another tab is open.
- Check the heights at 1080p in real Factorio. The feed height is `CONSOLE_TABS.activity_height = 460`.

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
