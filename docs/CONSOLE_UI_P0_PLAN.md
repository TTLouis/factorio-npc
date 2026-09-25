# Console UI P0 — working plan and checklist

The owner's spec: `docs/NPC_AGENT_HARNESS_STATUS.md`, "Owner's P0 spec" (2026-09-25).
This file tracks progress across sessions. Tick items as they land, and put each
item's commit next to it.

## Rules for this work

- Doc it, fix it, test it. Add tests to the existing `task_board_ui*` /
  `project_window` test files; don't add new CI jobs.
- Other agents' earlier console changes are intended; build on them and don't revert
  them. Before editing, check `git status` and `git log -5 -- packages/autorio/src/task_board_ui.ts`
  in case a peer session is active.
- The uncommitted Docker work (`SGLUNA_LOCAL_SOURCE`, `Dockerfile.mod-overlay`,
  `update-mod-overlay.mjs`, `scripts/build-docker-local.ps1`,
  `scripts/update-docker-mod-local.ps1`) belongs to another agent. Don't commit or
  revert it. `update-docker-mod-local.ps1` needs a clean tree, so while that work is
  uncommitted, use the `tests/factorio` Docker lanes for engine checks.
- **Build from local sources and save network (owner, 2026-09-25).** Every build and
  deploy uses the local checkout, never a GitHub fetch:
  - the local stack uses `scripts/build-docker-local.ps1` (`SGLUNA_LOCAL_SOURCE=1`)
    or the mod overlay, never a `SGLUNA_SOURCE_REF` rebuild from GitHub;
  - reuse cached layers: no `--no-cache`, no `--pull`, and no re-download of
    Factorio or base images;
  - the `tests/factorio` image already builds from `COPY . .`, but it re-downloads
    every npm package on each source change (see step 0).

  If the local-source scripts can't run (a dirty tree from the other agent's
  uncommitted work), stop before D2 and ask the owner. Don't fall back to a GitHub
  build.
- Unit tests don't prove the feel of the UI. The owner judges drag and typing in the
  real client; record what's still unverified.
- No provider calls are needed for this work.

## Where the code is (as of 263918a)

- `packages/autorio/src/task_board_ui.ts` (1,495 lines):
  - an `on_nth_tick(60)` loop (line ~1494) runs `render_panel`,
    `render_skills_popout` and `render_debug_popout` for every open console;
  - `refresh_columns` (~1261) already gates the left dynamic part, the action row
    and resources by `tags.signature`, but it clears whole containers when a
    signature changes;
  - `render_skills_popout` (~1319) runs `body.clear(); build_skills_body(body)` on
    every tick, with no signature at all;
  - the prompt field keeps its draft through `on_gui_text_changed` →
    `set_prompt_draft`.
- `task_board_console.ts`, `task_board_debug*.ts`, `task_board_ui_constants.ts`.
- Past plans ("Old tasks"): `projects/project_window.ts`. It has a list-box on the
  left, updated in place by `refresh_project_list`, a detail pane on the right with a
  skeleton plus `refresh_project_detail`, selection by `select_project`, and export.
  The skills browser should copy this pattern.
- Skills: `skills.ts` has `list_skill_ui_summaries`, `get_skill_definition`,
  `put_untrusted_skill_definition`, `canonicalize_skill_definition`,
  `generate_skill_markdown` and `export_skill`. The pop-out currently shows only
  learning status, the Learn Area button and export.

## Checklist

### 0. Cut network use in the test build
- [ ] 0.1. In `tests/factorio/Dockerfile`, give `pnpm install` a BuildKit cache
      mount for the pnpm store (for example
      `RUN --mount=type=cache,id=npc-test-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prefer-offline --store-dir /pnpm/store`),
      so that a source change stops re-downloading every package. Behaviour and
      lanes stay the same. `deploy/docker/Dockerfile` already caches its pnpm store.
- [ ] 0.2. Check it: the second build after a source-only change fetches no
      packages (pnpm reports them reused from the store).

### A. Measure first
- [ ] A1. Add a GUI-mock counter test: with no data change, a periodic refresh must
      make zero `clear`/`destroy`/`add` calls on the console, the skills pop-out or
      the debug pop-out. It should fail today (at least on the skills pop-out).
- [ ] A2. Add a test that a refresh with a changed board never destroys or replaces
      the prompt textfield, and never destroys any `screen` root (a destroyed root
      interrupts a drag and resets its location).
- [ ] A3. Note in this file whether the preview camera (`refresh_world_preview`)
      is updated every tick; it is a likely source of drag lag.

### B. Sections that update independently
- [ ] B1. Split the left dynamic part into sections, each with its own signature
      and container: banner, Goal card, Now card, Latest card, conversation, plan
      tracker, activity. A change rebuilds only its own section. Where possible,
      update captions in place instead of rebuilding.
- [ ] B2. Keep the prompt row and the window/title bar outside every rebuilt
      container.
- [ ] B3. Skills and debug pop-outs: gated by a signature, so a tick with no change
      does nothing.
- [ ] B4. Make A1 and A2 pass. Keep the existing layout and regression tests green.

### C. Skills browser (like Old tasks)
- [ ] C1. Pop-out layout: a skills list-box on the left (name, kind, stage/status),
      updated in place, and a detail pane on the right (summary, preconditions,
      flows, topology, constraints, verification, evidence refs), with a skeleton and
      a refresh. Keep Learn Area and export.
- [ ] C2. Store the selected skill per player, and keep the selection and scroll
      across refreshes.
- [ ] C3. Edit: an Edit button turns the editable fields (name, summary, status
      incl. `deprecated`) into text fields. Save goes through
      `canonicalize_skill_definition` and `put_untrusted_skill_definition` as a new
      revision, with the source marked as a player edit. Invalid input shows an
      error and saves nothing. Curated skills are edited as a copy or a new
      revision, never by mutating the curated constant.
- [ ] C4. Tests in `skills.test.ts` / `task_board_ui.test.ts`: list, select,
      detail, edit round trip, rejection, and that the LLM's `getSkillDetails` sees
      the edited revision.

### D. Validation and hand-off
- [ ] D1. Unit tests, typecheck, `check:lua` and eslint on the changed files in the
      Docker build stage; then `NPC_TEST_LANES=core` in `tests/factorio`.
- [ ] D2. Deploy to the local stack from local sources only (mod overlay if the tree allows, otherwise
      `scripts/build-docker-local.ps1`, reusing the cached Factorio layer), then copy the client
      mod zip to `%APPDATA%\Factorio\mods` with its checksum verified.
- [ ] D3. Update the status doc (what changed, and what the owner still needs to
      check in the client). Ask the owner to test drag, typing and the skills
      browser.

### Later (not P0)
- [ ] The player picks a skill that the LLM must use. It needs a planning-side
      contract (how a forced skill enters Skill Context and the plan draft), so it
      gets its own design.
