# Live OpenRouter manual test, 2026-10-01

This was the first live run of the runtime through OpenRouter (`AI_API_METHOD=router`, capability profile `openrouter`). Until this run the router profile had only unit-test coverage.

The owner played it by hand in the local Docker stack, from a cold start.

**Setup:**
- Build: `ec47e0aa`. All 35 runtime-v8 files in the container's release matched `git show HEAD`, compared with CR stripped.
- Model: `deepseek/deepseek-v4-flash`. This is the April 2026 V4 Flash, not V4.1 Flash, so it isn't the same model as the 09-29 direct run.
- Jev: on.
- World: fresh, with an NPC character (unit 5) at 0,0 holding an empty inventory, and no task board.

## What happened (UTC)

| Time | Event |
|---|---|
| 07:55:05 | The owner sent the objective "lets start to automate red sciences." in chat (`request_id req_mup8oayz_1`). |
| 07:55:54 | `goal_16t14uo_1` was defined as long-horizon. It had a done-when of `entity_working assembling-machine-1 ≥ 1`, three Roadmap Shelf nodes and a 4-step plan slice. |
| 07:55:54 – 07:58:53 | Step 1's gather batch ran on the real engine: 30 iron ore, 20 copper ore, 15 stone and 10 coal. |
| 07:58:56 | `post_step_observe`. Round 0 (tools on) made observation calls. |
| 07:59:03 | Round 1 (`decide`, tools off) returned malformed DSML tool-call text instead of a plan. |
| 07:59:07 – 07:59:14 | All three `recovery_continue_low` rounds returned a complete JSON plan inside a ```json fence. One had prose before the fence. All three were classified `provider_content_invalid_json`. |
| 07:59:14 | `goal.paused` with cause `provider_recovery_exhausted`. |

**Totals:** 8 provider calls; 147,490 input tokens, 62,208 of them cached; 5,962 output tokens, 4,188 of them reasoning. At OpenRouter list prices that is about $0.005, or 0.006 CAD.

**Run-check:** `run-check.mjs` reported "No known failure signatures", because this failure was new.

**End state:** the owner stopped the test. The world save and the paused goal were kept.

## Findings

1. **The OpenRouter profile removed the tool list on closed rounds.**
   - The direct `deepseek` profile keeps the list, sent with `tool_choice: "none"`. Live finding 3 of 09-26 showed that without the list, DeepSeek flash writes its tool calls as DSML text.
   - This run reproduced that through OpenRouter. The DSML was also malformed: it used a `<｜DSML｜tool_calls>` container and nested `invoke` elements as parameters. The strict parser correctly rejected it.
2. **Valid fenced plans were rejected.**
   - The fence and prose extractor (`normalizeProviderPlanContent`) validated each candidate with the strict plan parser. That parser refuses plan-surface extension keys, and it refused the shape this model produced: a plan object with the `submitPlan` tool arguments nested inside it.
   - So the fenced text reached `strictJson` unchanged and failed.
   - The recovery prompt gave the model no hint about the expected shape.

## Fixes

Two commits on branch `fix-openrouter-deepseek-closed-round`:
- `e2f28b2c`: DeepSeek-family models behind OpenRouter keep the tool block on closed rounds, with `tool_choice: "none"`.
- `4afc265f`:
  - fenced and prose-wrapped plans are accepted;
  - a nested `submitPlan` is unwrapped only when it doesn't contradict the outer object, and is otherwise refused with a named reason;
  - DSML rejections get named reasons;
  - new trace events: `provider.plan_content_unwrapped`, `provider.plan_content_refused`, `provider.dsml_rejected`.

The four verbatim live replies are the regression fixtures, in `fixtures/openrouter-deepseek-closed-round-2026-10-01.json`.

**Not proven yet:** whether DeepSeek's upstream behind OpenRouter honours `tool_choice: "none"`. The next OpenRouter run is that check.

## Follow-ups

- **Model choice.** The next manual OpenRouter run should use the owner's chosen models.
  - Automated e2e uses DeepSeek V4.1 Flash via the DeepSeek API only (owner rule, AGENTS.md).
  - This run's model, V4 Flash, is older than the 09-29 baseline, V4.1 Flash.
- **Client mod sync.** Copy the mod zip into the client's mods folder whenever the server image changes the mod. This run first failed to connect with "Mods mismatch detected", caused by a stale 09-26 client zip.
