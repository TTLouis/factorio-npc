# Units 17 and 18: remote integration and local packaging checks

October 15, 2026. Louis authorized integration into `experiment/jev-agent-architecture`, remaining local checks and a remote push. No live provider run was authorized or started.

## Integration

- [x] Units 17 and 18 independently reviewed and merged locally (`14a03571`, `e39eea27`). No code changed during this final promotion.
- [x] Refreshed `origin`; remote target `3b1bbaeb` is an ancestor of the reviewed integration candidate.
- [x] Fast-forward pushed **`451bd0e160d69c3188b310799f3e0dd10b3b9b3f`** to `origin/experiment/jev-agent-architecture`; remote-tracking SHA matched afterward. No history rewrite or force push.
- [x] Existing canonical full Docker gate passes: **2,353 runtime/staging tests and 1,142 mod tests across 128 files**, plus typecheck, Lua build and generated-Lua validation; exit 0. The merged code is unchanged since that gate.
- [x] Existing frozen-image engine pool passes: **recovery-loop, production, craft-trigger, native-admission and steam-lab**; exit 0. Its code/test candidate `4783226c` has the same runtime/mod/engine sources as the pushed integration candidate.

The clean integration worktree is `.claude/worktrees/peaceful-saha-a52c6f` on `og-port-integration`, tracking the requested remote branch. The older root checkout still has its original local `experiment/jev-agent-architecture` ref and uncommitted documentation. It was deliberately left untouched; nothing was stashed, reset or incorporated from it. The remote branch contains both units.

## Remaining local checks completed

- [x] `scripts/build-docker-local.ps1 -NoEnvUpdate` built the full server image from pushed candidate `451bd0e1`, exit 0. No provider settings were read by the agent or edited, and no existing server was restarted. The build used the existing Factorio 2.0.77 archive cache and verified its published checksum.
- [x] Actual Docker image identity: **`sha256:820172a26f4e564bd14cbc6bc9da37186410651ccbb8ba0317bf03a7b854fce5`**, tag `factorio-npc:local`. This is the daemon-addressable image digest, distinct from the build log's config digest.
- [x] In a network-disabled inspection container, the production `verifyManifest` check passed. All **51 shipped runtime/prompt files** matched checkout source after CR normalization. All **31 packaged mod files** matched the compiled mod from the passing unit-18 engine image (text normalized for CR; binary assets compared exactly). File sets were also equal. No runtime overlay was applied.
- [x] The exact image started in a fresh disposable container with network mode `none`, no published ports, dummy provider settings, no Jev key and no gameplay objective. It reached `SGLuna Factorio ready` with its standalone actor. Neither main-model nor decision-provider budget reservation files were created.
- [x] SIGINT shutdown requested native `/quit`, emitted Factorio `Goodbye` and `SGLuna Factorio stopped cleanly`, exited **0**, and produced a non-empty native save. Logs and save were copied out before removing only the disposable smoke container and its anonymous volume.
- [x] Installer bootstrap source/copy list is unchanged; its pin remains valid and generated-payload tests passed in the canonical gate.

Uncommitted local evidence in the integration worktree: `unit18-integration-all.log`, `unit17-18-server-build.log`, `unit17-18-image-verification.log`, `unit17-18-startup-smoke.log`, and `test-results/unit17-18-integration/` (comparison script, tested mod and native smoke save). Full native recovery evidence remains in the unit-18 worktree as documented in its [checkpoint](UNIT18_RECOVERY_ENGINE_2026-10-15.md). The source-file verification and offline startup smoke are local packaging/deployment evidence; they are not a new clean installation through the Pterodactyl egg loader.

## Before any live run

The local code, native regression and packaged-image gates are green. Documentation commits after `451bd0e1` do not change executable image contents. Do not silently rebuild or run a different code candidate using this evidence.

Louis's explicit go for run J is still required. Once authorized, perform the cold-world preflight and verify files in the actual chosen live-run container, including any runtime mounts/overrides, before sending a gameplay goal. No current live stack was started or changed, no Pterodactyl server was deployed, and autonomous green science remains unproven.
