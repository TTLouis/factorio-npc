# Factorio NPC migration tracker

This tracker covers the transition from the historical `airi-factorio` fork identity to the independent **Factorio NPC** project.

The goal is to preserve useful Git history and MIT attribution while removing tooling, CI, runtime assumptions, and branding that no longer match the headless-first autonomous NPC architecture.

## Ground rules

- Preserve Git history; do **not** rewrite the repository just to hide its origin.
- Preserve upstream MIT attribution and explicitly document the original AIRI/`autorio` lineage.
- Keep cleanup isolated from NPC behavior changes.
- Prove old components unused before deleting them.
- Internal protocol, save, and runtime identifiers were renamed to SGLuna naming on 2026-09-29 with no aliases and no save migration (worlds are disposable test worlds). AIRI names remain accepted only as settings and input aliases, listed in the inventory below.
- Factorio simulation state and deterministic helpers are authoritative; vision is optional research infrastructure, not a core runtime dependency.
- Treat the current learning/skill stack as project-owned NPC functionality unless a future audit proves a specific piece is obsolete.

## Phase 0 — Project identity

- [x] Adopt **Factorio NPC** as the project-facing name.
- [x] Define the project as headless-first and standalone-NPC-first.
- [x] Document that CV/YOLO is not required by the current runtime.
- [x] Move root package identity away from `@proj-airi/autorio-workspace`.
- [x] Preserve upstream lineage and MIT attribution.
- [x] GitHub repository description is `Headless-first autonomous NPC runtime and planning harness for Factorio servers.`
- [x] Repository is `TTLouis/factorio-npc`.
- [x] Repository is no longer a GitHub fork (`fork: false`, verified 2026-09-17).

## Phase 1 — Active architecture to keep

The following are current project-owned architecture and must remain intact during cleanup:

- [x] `packages/agent/`
- [x] `packages/autorio/`
- [x] `deploy/pterodactyl/`
- [x] `deploy/docker/`
- [x] `tests/factorio/`
- [x] `packages/tstl-plugin-reload-factorio-mod/` while `packages/autorio` depends on it.
- [x] Current NPC harness/status/architecture/validation docs.
- [x] `factory_area_learning*`, `learning_pipeline*`, `learning_opportunities*`, `skills*`, and `skill_verification*`; commit history confirms these are current Factorio NPC learning/skill work rather than inherited AIRI baggage.

## Phase 2 — Legacy AIRI vision/developer stack

Reference audit showed that these components are not part of the current headless NPC runtime. They were removed during the detach cleanup:

- [x] `models/factorio-yolo-v0/`.
- [x] `pixi.toml` / `pixi.lock` YOLO/Python environment.
- [x] `.github/workflows/python.yml`, which existed for the inherited model tree.
- [x] `packages/factorio-rcon-snippets-for-node/` YOLO dataset collector.
- [x] `packages/factorio-rcon-snippets-for-vscode/` YOLO/dev snippets.
- [x] legacy root `docker/` GUI/X11/noVNC-oriented stack; current deployment is `deploy/docker/`.
- [x] `packages/vscode-factorio-rcon-evaluator/` and its root VSCode launch/build hooks.
- [x] `packages/factorio-wrapper/`, superseded by the current supervisor/Pterodactyl runtime.
- [x] Adapt `scripts/bootstrap.ts` so it no longer creates `factorio-wrapper` configuration.
- [x] Rename the devcontainer service/project identity to `factorio-npc`.
- [x] Remove unreferenced upstream README/banner assets.
- [x] Verify typecheck/tests/build/deployment packaging remain green after syncing the cleanup into `feat/npc-transition-work`.
- [ ] Regenerate `pnpm-lock.yaml` so stale importer entries for deleted workspaces are actually pruned rather than merely tolerated by frozen install.

Vision may return later as a **separate optional sensor package** rather than as a core workspace dependency.

## Phase 3 — Compatibility names still intentionally retained

These names are compatibility surface and should be migrated separately with aliases/tests instead of being changed during architecture cleanup:

- [x] Migrate `@proj-airi/factorio-agent` to `@factorio-npc/agent` and update root filters.
- [ ] Migrate the TSTL plugin package name away from `@proj-airi/*`; this requires a lockfile-safe dependency rename.
- [x] Introduce `SGLUNA_SOURCE_REF`, `SGLUNA_ACTOR_MODE`, and `SGLUNA_CHAT_PLAYERS` as preferred deployment variables while retaining `AIRI_*` compatibility fallbacks with deterministic SGLuna precedence.
- [x] Migrate Pterodactyl egg filenames, display labels, startup/rollback helpers, and operator-facing deployment branding to SGLuna.
- [x] Make `sgluna-config.json`, `sgluna-behavior.jsonl`, and `sgluna-prompts.jsonl` canonical while retaining legacy config/trace compatibility reads.
- [x] Move deployment source/bootstrap URLs to `TTLouis/factorio-npc` while preserving immutable pin semantics.
- [ ] internal Factorio compatibility identifiers such as the `autorio` mod id and `autorio_*` remote interfaces; rename only with explicit migration aliases because saves, deployment scripts, tests, or external callers may depend on them.

## Final SGLuna compatibility inventory

| Category | Remaining / migrated AIRI surfaces | Decision |
| --- | --- | --- |
| Safe to migrate now | Pterodactyl variables/labels, config filename, startup/rollback helpers, `!luna`, trace defaults, Docker/Compose examples, console/debug branding | Canonical SGLuna names are now used. |
| Compatibility aliases (settings and input only) | `AIRI_SOURCE_REF`, `AIRI_ACTOR_MODE`, `AIRI_CHAT_PLAYERS`, older chat-player aliases, `airi-config.json`, `start-airi.sh`, `rollback-airi.sh`, `!airi`, legacy trace env/file inputs, Docker AIRI build args | Accepted; equivalent SGLuna values win on conflict. |
| Protocol/save/runtime identity | actor name/id `SGLuna`/`sgluna`, `npc:sgluna`, `sgluna_deployment`, `SGLUNA_RESULT_*`, `SGLUNA_CONFIG_*`, `SGLUNA_UI_*`, `.sgluna/`, Factorio `storage.sgluna_*`, GUI/sprite/prototype ids, all user-facing and model-facing strings | **Migrated 2026-09-29** with no aliases and no save migration. Still unchanged: the Autorio mod id and `autorio_*` interfaces (upstream naming), the `-airi/*` TSTL plugin namespace, and our own workspace package names and lockfile (build identity). |
| Historical/upstream attribution | `moeru-ai/airi-factorio`, original Autorio/AIRI lineage, dated validation records and historical repo notes | Must remain for provenance and MIT attribution. |

The internal `.sgluna/` directory is authoritative for managed releases, operation locking, provider budget, durable NPC state, rollback metadata, and runtime temp directories. It replaced `.airi/` on 2026-09-29; nothing reads or migrates the old directory. There is no deployment and every world is disposable, so the installer simply refuses a volume whose start/rollback helper still points into `.airi/releases/` ("unexpected target"); reinstall on a fresh volume.

## Phase 4 — Repository detach

Repository-level identity/detach is complete: the repository is named `factorio-npc`, has the intended description, and GitHub reports `fork: false`. No repository recreation or history rewrite is required.

Remaining administrative cleanup is optional/non-architectural:

- [ ] Add repository topics if desired: `factorio`, `npc`, `llm`, `agents`, `headless`, `factorio-mod`.
- [ ] Confirm long-lived local/deployment clones use the current repository remote rather than relying on redirects.

## Phase 5 — Architecture cleanup after detach

This is separate from de-fork identity work and should continue through ordinary feature/audit changes:

- [x] Confirm the learning/skill subsystem is current project-owned work rather than inherited cleanup material.
- [x] Audit and document learning/verification ownership, including the canonical verification queue record and verifier-only verified-skill promotion authority.
- [x] Document `deploy/pterodactyl/staging/` versus `runtime-v8/` source-of-truth layering without renaming deployed paths.
- [x] Document provider/tool ownership and guard the ordinary-agent/runtime-v8 Factorio contract against silent drift.
- [x] Keep task-board/project/debug UI as projections of canonical runtime state rather than parallel state stores.
- [ ] Complete the remaining single-NPC E2E gates before broadening architecture scope.

## Validation gates

Cleanup is not considered complete merely because dead files are gone. The relevant checks are:

```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
pnpm --filter autorio.ts build
node deploy/pterodactyl/build-payload.mjs --check
node --test deploy/pterodactyl/build-payload.test.mjs deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
docker compose config
pnpm test:npc
```

Heavy Factorio/Pterodactyl smoke remains authoritative for runtime packaging behavior.

## Decision log

### 2026-09-29

- Owner decision: there is no deployment and every world is a disposable test world, so the AIRI to SGLuna rename covers internal identifiers too, with no save migration and no aliases for internal ids.
- Renamed: actor name/id (`SGLuna`/`sgluna`), `npc:sgluna` memory keys, the `sgluna_deployment` remote interface and guard, `SGLUNA_RESULT_*`/`SGLUNA_CONFIG_*`/`SGLUNA_UI_*` protocol markers (mod and runtime together), Factorio `storage.sgluna_*` keys, GUI element names, sprite/prototype ids, the `.sgluna/` runtime state directory, temp/cache paths, and every user-facing and model-facing string. The LIVE/PAUSED activity-feed state is now `live` (previously `follow`); the FOLLOW button that makes the NPC follow the player is unrelated and unchanged.
- Kept as compatibility aliases for settings and input only: the `AIRI_*` deployment and trace environment variables, `airi-config.json`, `start-airi.sh` / `rollback-airi.sh`, the `!airi` chat command, and the Docker AIRI build args.
- Kept as attribution/lineage: `moeru-ai/airi-factorio`, the original Autorio/AIRI lineage, dated validation records, third-party `@proj-airi/*` packages.
- Deferred (build identity): our own workspace package names and `pnpm-lock.yaml`; the TSTL plugin namespace; the `autorio` mod id and `autorio_*` interfaces.

### 2026-09-17

- Architecture cleanup is consolidated onto `feat/npc-transition-work` instead of merging the divergent cleanup branches wholesale.
- `contracts/factorio-tool-contract.json` is the provider-surface review/test manifest; independent adapters remain valid where surfaces intentionally differ.
- `staging/structured-policy.mjs` remains the shared Pterodactyl base and `runtime-v8` remains its extension layer; directory renaming is intentionally deferred.
- Learning opportunities, verification runs, and verification queue records remain separate lifecycle layers; the queue record type is owned canonically by learning.
- Verified-skill promotion is trusted only from the live verifier; caller-supplied `put_definition` records cannot self-assert verified status.
- Repository identity facts from the historical cleanup line were re-audited against GitHub before being marked complete.

### 2026-09-16

- The project is now **Factorio NPC**, not an AIRI product extension.
- Preferred repository name: `factorio-npc`.
- Primary runtime target: headless Factorio servers.
- Preserve Git history and upstream attribution; do not history-rebase for cosmetic separation.
- YOLO/CV is not a required runtime and is removed from the core repository.
- Existing feature branches must survive repository detach unchanged.
- The current factory-learning and verification stack is protected from de-fork deletion.
- The Factorio mod id `autorio`, `autorio_*` remote interfaces, and deployed `AIRI_*` names remain compatibility interfaces for now, not project identity.
