# SGLuna external harness v0.1.0-pre.1

Connect a local AI harness to a standalone Factorio NPC through MCP. This
checkpoint promotes the external-harness workflow to `main`, with portable setup
instructions, native Windows and Windows-host-to-Docker support, guarded
operations, and a local knowledge/method library.

Source: `c4108ab1a485274db9b950bd9041bc1cc8da860e`.

---

## Set up your harness

Give an agent with local command access and automatic setup enabled this prompt:

```text
Set up https://github.com/TTLouis/factorio-npc/tree/c4108ab1a485274db9b950bd9041bc1cc8da860e
for this harness. Follow the repository setup instructions and stop when ready
for my goal.
```

Follow the [portable setup guide](https://github.com/TTLouis/factorio-npc/blob/c4108ab1a485274db9b950bd9041bc1cc8da860e/docs/EXTERNAL_HARNESS_SETUP.md).
Setup stops ready for your goal; it does not start gameplay.
This is a source-based external-harness checkpoint. The existing Docker image
and Pterodactyl egg belong to the historical built-in server release and are not
external-harness release assets. Internal planner/Jev development remains on
`experiment/jev-agent-architecture`.

---

## Demonstrated progress

The [dated proof and four actual in-game screenshots](https://github.com/TTLouis/factorio-npc/blob/c4108ab1a485274db9b950bd9041bc1cc8da860e/docs/proofs/2026-10-31-red-science.md)
record 12 red science packs produced in a two-minute hands-off window at normal
speed. The agent manually fuelled burner machines and the boiler; science was
collected in a chest, not supplied to a lab. The formal trial failed a furnace
observation check. This is semi-automated production, not sustained full automation.
The trial tested an earlier source; later electric-miner support is not a new
successful gameplay proof.

---

## Validation and limits

Focused library/contract checks passed (13 tests), generated deployment payloads
matched, and Windows catalog-byte preservation was verified. Prior native and
bridge results were reused for unchanged implementation. Documentation links and
all four screenshots were checked. No additional gameplay trial was run for this
publication. This checkpoint is experimental; repeatable autonomous science
production and an automatically sustained science-to-research loop remain unproven.

---

## CI repairs before this prerelease

The first publication candidate failed lint and a mod unit test. The electric
miner's test fixture lacked its item-output position, so the preservation guard
correctly refused it. The fixture now includes the native output geometry; no
guard was relaxed. Lint cleanup removes unused declarations, makes fixtures and
control-character handling explicit, and declares constants before their uses.

Focused verification passed: lint on all eleven repaired files, 100 affected mod
tests, 127 affected runtime/library tests, and nine installer-pin tests. The
installer bootstrap was repinned separately as required by the packaging contract.
The release publisher also requires the pinned source's CI, security and
Pterodactyl release-gate workflows to complete successfully before publication.

[Source CI results](https://github.com/TTLouis/factorio-npc/actions/runs/41277832067),
[security results](https://github.com/TTLouis/factorio-npc/actions/runs/41277832098),
and [packaging/native results](https://github.com/TTLouis/factorio-npc/actions/runs/41277832144).
