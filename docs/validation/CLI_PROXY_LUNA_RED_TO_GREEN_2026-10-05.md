# CLI proxy Luna red-to-green guided trial — October 5, 2026 (Toronto)

Result: **guided native red-to-green progression succeeded**. This is a guided NPC gameplay checkpoint, not autonomous factory-production proof.

## World and candidates

- Separate Compose project `luna-red-green-e2e`; ignored evidence at `test-results/luna-red-green-2026-10-05/`. Seed 2250556770, actor 10, zero connected humans, normal generated world, speed 1. The first goal was new (`goal_12otrtf_1`, request `req_muw0mkcw_1`).
- Started from `6439c996e3964d1ffcac14f49db2054206078258`, Factorio 2.0.77. One declared vanilla starter kit: 8 iron plates, 1 burner drill, 1 stone furnace, pistol and 10 magazines. No later item grants, terrain edits, teleports, or research grants in this world.
- Owner selected the CLI proxy on Tailscale and permitted `gpt-6-luna`, local API method, at `http://proxy.example-tailnet.ts.net:18317/v1`. Compose loaded the client key opaquely; `.env` was neither read nor rewritten. Jev disabled; guard 60 provider requests/hour and 32,000 output units/turn.
- Owner narrowed the result to producing red science and using it to unlock green science, with manual crafting and hand-fed machines permitted. After repeated model pauses, the operator used the existing structured operation schema, read-only preflight, live actor/epoch guard, native receipts and verified inventory/world facts. The immutable paused model plan was not manually advanced to claim completion.
- Checkpointed the same world with its actual mined ore and recreated only this isolated container on `d8fa2a1c147aa80327adb71bdced1080025c1136`. Actor 10 and inventory survived; epoch and batch generation advanced to 2. Supported full local build used `-NoEnvUpdate` and pinned Factorio 2.0.77.
- Deployment verification: committed provider-base SHA256 `ecb8e8ea1359053ea91b4a87eab34a1197c79f80d73ff5124ff8515c4a9700af`; supervisor `09eb06b66ebebddcf9a69fab8415c4fa5157383aa36b47dbffd40e25a608d330`; compiled release and actual running mod `control.lua` both `71e4a74861b5fd437b03dde21e4babf3af4e40883765b790cf644e2f728bdce9`.

## Provider finding and model portion

Three explicitly approved additional diagnostic replays followed the separately authorized first replay. Those three calls are exhausted. A JSON-only replay contained a small valid plan plus an unsolicited base64 image, crossing 1 MiB. This explains that replay's oversize; the original failed body was not retained, so attributing its exact cause remains an inference.

Keeping the original function schema and explicit `tool_choice: none` returned HTTP 200, 1,064 bytes, a valid plan and no image, without changing effort or adding format instructions. `8a60ba43` applies that closed-round contract to local GPT-6-family models; the byte guard stays intact. Current upstream [CLIProxyAPI translator](https://github.com/router-for-me/CLIProxyAPI/blob/main/internal/translator/codex/openai/chat-completions/codex_openai_request.go) supports copying tool choice, while its client token-cap mapping is disabled. Installed proxy revision remains unverified.

The narrowed run made 47 provider calls with 47 complete captured usage reports: 868,217 input units, including 441,856 cached input units; 6,861 output units, including 391 reasoning units; 875,078 total. This excludes separate smoke/diagnostic/failed-trial usage and is not a billed-dollar total. No additional provider calls were needed for the guided finish or after the image replacement.

Luna gathered and smelted the first iron/copper batches, but missing-fuel transfers, duplicate transfers, stale wait observations, the continuation ceiling and a no-action continuation failure prevented autonomous completion (`req_muw17okc_4`). Those planning/recovery limits remain open. The earlier empty-board intake issue is separately retained in the [blocked first trial](CLI_PROXY_LUNA_RED_SCIENCE_2026-10-06.md).

## Craft-trigger repair

A real standalone character crafted the first lab, but Factorio 2.0.77 did not record its product in force production input statistics or fire player craft events. `automation-science-pack` therefore stayed locked despite its genuine inventory lab and researched steam-power/electronics prerequisites.

A network-isolated copy showed that adding the missing lab production flow lets the engine complete the craft trigger on a later tick. `dd81485e` connects this bridge only to confirmed decreases of the request-owned native crafting queue, for an enabled, unresearched craft-item trigger whose prerequisites are ready. The existing cancellation and actor checks remain in force. A durable overlap counter prevents goal evaluation from counting that flow and the hand-crafted item twice. No historical craft backfill is performed.

A second genuine native lab craft in the live world unlocked red science. Trace: `crafting.trigger_flow request_id=native_craft/10/196560 reason=completed_native_craft item_name=lab count=1`. Ordinary hand-crafted products still use the completion counter; red pack production must be read from that counter and actual inventory/consumption, rather than assuming raw engine input statistics include standalone crafts.

Validation: 1,629 runtime tests, 970 mod tests, typecheck, Lua build/generated-Lua check, 9 payload tests, and the Docker `craft-trigger` engine lane passed. That isolated fixture seeds only prerequisite technologies and ingredients; its target red technology is never granted. It verifies first-lab native trigger completion, second-lab exact goal count, and zero humans. A separate bounded reviewer found no blocking issues. Normal-quality crafting is covered; broader quality comparator behavior is not promoted by this checkpoint. Payload repin is `d8fa2a1c`.

## Guided world operations and final proof

The operator mined 216 more iron ore and 91 copper ore, harvested a natural rock for 20 stone, mined 30 coal, harvested a tree for 4 wood, and hand-crafted four additional furnaces. The nearest stone resource failed with `mining:mining_rejected`; the existing bounded natural-rock harvest succeeded. The failed resource target remains a diagnostic follow-up.

Three new furnaces smelted 72 iron plates each; the original furnace smelted 91 copper plates. Refills respected native ore-stack input capacity. Together with existing genuine plates, the inventory reached 238 iron and 92 copper. After the second lab and power items, 160 iron and 75 copper remained for science (10 iron spare).

Native recipe costs and fluid-port geometry determined the layout. Pump (-36.5,-24.5), direction 4; boiler (-38.5,-25), direction 0; engine (-38.5,-28.5), direction 0. Their ports connect directly, without scripted fluid insertion. Two poles and two labs were placed on native legal land positions; the boiler was fed coal retrieved from the furnace. Lab energy and engine steam were observed before research.

At tick 230978, the world had actor 10, zero humans and speed 1. Native completion-counter proof recorded exactly **75 red packs crafted** (`production_statistics=0`, `hand_crafted=75`, overlap 0); force consumption statistics recorded **75 packs consumed**. `logistic-science-pack.researched` and its recipe's `enabled` were both true. Correlated native research request 1 completed at tick 230921 with `by_script=false`. Labs 24 and 25 used the steam network; there was no research-progress assignment or technology grant.

The controller finished successfully and created `data/saves/luna-red-green-success.zip`: 939,872 bytes, 56 readable ZIP entries, SHA256 `052a11b6dc603686242f120eeb7faba95c3e79ce7396f6cadc59743508b8c322`. The isolated container is stopped and its retained overlay resumes this successful save. The read-only model `run-check` exited 0 over 4 requests/712 rows, with no parse errors or findings. That limited trace check does not certify autonomous goal completion; the guided world-state proof above is the completion evidence.

## Evidence and limits

Local evidence: `data/logs/e2e-guided-operations.jsonl`, `e2e-red-to-green-success.json`, native behavior/prompts/world snapshots, `provider-usage-summary.json`, `craft-trigger-cell.json`, `trigger-final-gates.log`, `trigger-engine.log`, `trigger-payload.log`, and `fixed-live-build.log` under the ignored test directory. The source controllers and isolated Compose overlay are retained there. RCON is published only on host loopback 127.0.0.1:27017; existing user saves and other stacks were untouched.

This proves guided native red-to-green progression in the CLI-proxy test world. It does not prove a fully autonomous Luna finish, automated science production, repeatability across fresh seeds, or broader fluid/assembler transport capability. Proxy credential priority/routing was not changed or independently audited. Existing planning and recovery findings remain separate work.