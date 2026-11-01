# Factorio NPC agent

This package contains the structured LLM/tool layer used by Factorio NPC development and the ordinary agent path.

It talks to Factorio through the RCON API layer and exposes bounded, structured tools for observations and actions. Production facts such as recipes, production scope, transport capacity, and construction intent should come from deterministic Factorio-side helpers rather than being guessed by the model.

Computer vision and YOLO are not required by this package.

## Development

Copy the package environment template and provide a development provider configuration:

```bash
cp packages/agent/.env.example packages/agent/.env.local
```

Then run the agent from the repository root:

```bash
pnpm --filter @factorio-npc/agent dev
```

The Factorio-side mod/runtime must be reachable through the configured RCON API service when using the interactive development path.

Useful checks are:

```bash
pnpm --filter @factorio-npc/agent typecheck
pnpm --filter @factorio-npc/agent test
pnpm --filter @factorio-npc/agent test:prompt
```

For the managed headless-server runtime, Pterodactyl packaging, and zero-player NPC E2E flow, use the repository-level documentation under `deploy/pterodactyl/` and `tests/factorio/` rather than treating this package as the server launcher.
