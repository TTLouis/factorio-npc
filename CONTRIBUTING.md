# Contributing to Factorio NPC

**Contribute to
[`experiment/jev-agent-architecture`](https://github.com/TTLouis/factorio-npc/tree/experiment/jev-agent-architecture).**
It is the current development branch, and it works without enabling Jev. The
main LLM provider is still required; Docker users can leave `JEV_TYPESAFE_API_KEY`
blank. `main` is an older snapshot, not the current contributor starting point.

Use the [current contribution guide](https://github.com/TTLouis/factorio-npc/blob/experiment/jev-agent-architecture/CONTRIBUTING.md)
for setup, first changes and pull requests. Helpful bounded contributions include
setup feedback, clearer explanations and deterministic regressions for reproducible
failures. New implementation and ordinary pull requests target the Jev branch.
A maintainer-approved documentation backport to `main` is separate from runtime promotion.

## Report a reproducible issue

Include the exact branch/SHA, platform, Factorio version, minimal steps, expected
result and actual result. State whether the failure was offline, deterministic
native-engine or provider-backed. Supply a small sanitized excerpt or fixture,
with request/operation IDs where relevant. Never attach `.env`, credentials,
private endpoints or an unreviewed data/save/trace bundle.

## If you maintain this main snapshot

Read [AGENTS.md](AGENTS.md), [TESTING.md](docs/TESTING.md) and the
[development workflow](docs/DEVELOPMENT_WORKFLOW.md). Current Jev test scripts,
configuration names and future design documents are not automatically present
here. Keep a documentation backport focused and preserve historical evidence.
Record unavailable checks honestly. Shared Windows dependency symlinks must remain
untouched; do not install packages or hooks through host Node/pnpm.
