# Testing the main snapshot

Current development tests are documented on the
[Jev branch](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/docs/TESTING.md).
Use them from that branch. This older `main` has no `scripts/test-local.sh` or
cloud-engine wrapper; do not copy those commands into this checkout.

## Supported environment

Run from an isolated Linux/container environment with the package manager pinned
in [package.json](../package.json). The [main CI configuration](../.github/workflows/ci.yml)
owns its Node selection and complete checks. Shared Windows dependency folders
may be WSL symlinks: do not run host package installation, tests or hook setup.
Offline tests use no production provider credentials.

In your supported environment, useful checks from the repository root are:

```sh
pnpm install --frozen-lockfile
pnpm run lint
pnpm run test --run
pnpm run build
pnpm run typecheck
node --test deploy/pterodactyl/staging/*.test.mjs deploy/pterodactyl/runtime-v8/*.test.mjs
node deploy/pterodactyl/build-payload.mjs --check
```

For deterministic native-engine coverage, the existing package script is
`pnpm test:npc`; it builds [the Factorio test image](../tests/factorio/Dockerfile)
and runs it with Docker. Builds can download dependencies and Factorio. Preserve
logs and record exact versions/SHAs. Own and clean up resources under workspace
rules; do not start live providers to validate deterministic changes.

Documentation-only changes need link/path/command checks and `git diff --check`.
Unit/type checks do not establish engine semantics; placement and a clean command
exit do not establish autonomous production. Keep full logs and real exit codes,
and report unavailable checks instead of claiming a pass.
