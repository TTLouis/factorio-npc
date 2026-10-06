# Luna + Jev resumed trial — October 6, 2026 (Toronto)

Result: **ten copper ore genuinely mined, then a recoverable pause after Luna twice omitted semantic step completion.** Red science was not produced and green research remains locked. This retry did not reach the whole-goal retirement failure from the preceding trial. UTC timestamps below match the captured logs.

## Setup and assistance

The owner requested a join port and resumed testing after cleanup, then requested installation of the matching mod into their Factorio client folder. One new Docker project, `luna-jev-resume-20261006`, runs locally on Windows Docker Desktop. Gameplay is UDP 34201; RCON remains loopback-only at 27019. Local join address: `127.0.0.1:34201`; the host's verified Tailscale address is `100.98.209.103:34201`.

HEAD remains `1eb6172f75089d89122b101cd56aaccbeafafcd3`. The previous image had been removed, so the repository's supported `build-docker-local.ps1 -NoEnvUpdate` rebuilt committed HEAD, pinned to Factorio 2.0.77. The three documentation-only working-tree changes were backed up, temporarily restored to committed content for the clean-tree build requirement, then restored with matching hashes. `.env` was not read, printed or modified. Prior successful gates at the same source revision were reused; no production source was changed.

All 39 shipped top-level runtime modules matched checkout source after CR normalization. The active mod's `control.lua` matched the rebuilt release byte-for-byte, SHA256 `23bc84db05b51c381abd13737c4bba34c976dfec635d6de9abcfbd4169526ea9`. The rebuilt artifact has a different byte hash from the prior trial; this check compared it to its own compiled release. The exported client zip contains that exact control file. It was installed as `C:/Users/Louis/AppData/Roaming/Factorio/mods/autorio_0.1.0.zip`, with the existing zip backed up. Installed zip SHA256: `e74e96d8b2e11f6e02b2e890612cd2c89bff5f555ff43ea84da3c7f9f5e57c24`.

Fresh natural world: seed 1196625720, standalone NPC actor 25, initially zero humans, speed 1, empty inventory, no board and no production machines. The same declared starter kit and exact red-to-green objective were submitted once at `08:33:10`. Main model `gpt-6-luna` through the owner's CLI proxy, local method; Jev enabled through the dedicated Compose token mapping. Bounds remained 45 minutes, 60 main-provider calls and 120 decision calls. No corrective operator prompt or gameplay operation followed the starter kit. The owner connected during the run; this therefore is not a zero-connected-human trial throughout.

## Observed failure

Jev routed a new goal (`goal_09t2z1e_1`, request `req_muwf8k82_1`). After normal goal-definition and prerequisite-grounding validation, Luna committed a prose gathering step and chose `gather_resource(copper-ore, 10, search_radius=4096)`. Native walking/mining batch 1 completed at tick 13081; actor 25 retained ten copper ore.

At `08:34:47.857Z`, Luna returned the unchanged plan with no operations, saying it could not submit the step-completion confirmation. The harness requested a bounded act-or-block repair and explicitly explained `semanticCompletion`. At `08:35:05.641Z`, Luna again returned the unchanged plan with no operations and no semantic completion or truthful `BLOCKED:` reason. The runtime emitted `request.failed` at `08:35:05.696Z` with `provider_action_omission_repair_failed`, preserving the goal in a paused state.

The captured final provider request had `tool_choice: none`, no `response_format`, and a retained `submitPlan` schema that includes `semanticCompletion`; three messages contained that field's instructions. No diagnostic replay was made, so the precise cause of Luna's refusal is unproven. A recorded receipt/prompt/reply fixture should cover this continuation failure before another live retry.

The read-only repository log checker exited **1**, reporting `stale_step_tracker_behind_batch`: the gathering step remained active/unverified after the completed native batch. It scanned one request / 88 rows with no parse errors. This is a failed gameplay trial, not a passing completion check.

## Observer correction and final evidence

The initial observer selected the first `character` entity. After the human joined, this became the player's actor 48; the observer incorrectly labelled the run `trial_invariant_changed` and stopped observing. This did not cause the preceding runtime failure. Original snapshots/results are retained unchanged. The observer template was corrected to resolve the controlled standalone NPC through `autorio_actor.status` and `game.get_entity_by_unit_number`.

A separate authoritative read at tick 20050 confirmed actor **25** remained healthy at approximately (19.05,-98.47), with ten copper ore and the original construction supplies. One human was connected, speed 1, no production machines placed, zero red produced/consumed, green unresearched and disabled. The board was paused with its unmet user goal preserved. `e2e-authoritative-final.json` is the corrected final observation; do not use the earlier player snapshot as NPC state.

Seven main-provider requests/responses: 149,355 input units, including 113,664 cached, and 1,866 output units. Seven Jev requests/responses, zero decision fallback/error events. These are reported usage units, not billed dollars.

Evidence remains ignored under `test-results/luna-jev-resume-2026-10-06/`, including deployment verification, fresh-world contract, prompt/behavior/decision logs, original and corrected observations, final NPC state, usage summary and failing `run-check.json`. At the end of this autonomous portion the server was available for inspection with work paused. Previous test containers and worlds were not restored.

The owner subsequently requested operator help. A separate [assisted finish](LUNA_GUIDED_RED_TO_GREEN_2026-10-06.md) reached green science using native operations; this autonomous failure and its original evidence remain unchanged.
