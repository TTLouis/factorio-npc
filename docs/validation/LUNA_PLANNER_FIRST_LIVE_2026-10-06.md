# Planner-first Luna live trial — October 6, 2026

## Outcome

The owner authorized one fresh Luna + Jev run and removed the old 60 Luna / 120 Jev trial call caps. At frozen candidate `6b268031c8a2023a7ca973557022b3cd84e221c1`, Luna authored a plan without operations, the harness committed its validated completion contracts, and C3 created a fresh executor context. The executor then reported a missing-facts blocker before any gameplay admission. The harness paused the board and retained the active canonical goal. Autonomous red-to-green acceptance **failed**.

Trial start: October 6 at 22:32:17 Toronto (`2026-10-07T02:32:17Z`). Observation duration: 60.239 seconds. Five Luna requests/responses and five Jev requests/responses. Native red production and consumption: zero; green research and recipe: false. No operator gameplay after the starter kit, corrective operator prompts, external provider retries, human joins, or identity changes. The server was stopped after evidence capture.

## Candidate and run controls

- Clean, pushed HEAD; previously passed official Docker all gate (1,812 runtime and 1,036 mod tests), typechecks, generated Lua, full build and nine payload checks.
- Rebuilt through `scripts/build-docker-local.ps1 -NoEnvUpdate`, Factorio 2.0.77. No supervisor-only overlay or mixed release.
- Compared all 41 runtime modules explicitly shipped by the installer against clean source hashes: no mismatches. Active `control.lua` matches the compiled release, SHA256 `d9434a7652c9c9cee836d06b96e17065c77d9805be2b479cf31b259ed23c8f17`.
- Proxy root and authenticated model list returned HTTP 200 from Docker over `http://ttdocker.tail9fa03b.ts.net:18317/v1`; Luna available, dedicated Jev token present. No credentials printed or persisted in this record.
- Removed the previous stopped Factorio test container; used a separate empty bind directory and freshly generated map, seed `1062277438`, standalone actor 9, epoch 1, speed 1, zero humans. Initial inventory empty, no machines, no board, no research unlocks.
- Existing starter: eight iron plates, one burner mining drill, one stone furnace, one pistol and ten magazines. No further operator supply.
- One raw `!luna` objective: produce red science and use it to research `logistic-science-pack`, with native mechanics/natural resources; hand crafting and hand-fed machines allowed, factory automation optional.
- Kept 45-minute wall bound, recovery/identity/admission guards and existing output allowance. No trial call-count stop. Runtime rate guards set to their supported maximum, 1,200/hour for each provider; output allowance 100,000 units. These guards were not reached. `.env` unchanged; overrides confined to this trial.

## Captured sequence

1. Intake accepted new goal `goal_0mqy4p0_1`. Planner observed `getResearchStatus`, `getRecipeDetails(logistic-science-pack)` and `getResearchPath(logistic-science-pack)`.
2. The research path returned exact native triggers: electronics needs ten copper plates; steam-power needs fifty iron plates; automation science needs one lab after those prerequisites; logistic science needs 75 red packs through lab research. These are engine observations, not a walkthrough supplied by the operator.
3. Jev's bounded observation allowance was exhausted. Luna's first plan had three descriptions but only one completion declaration. The harness rejected it and requested a structured correction. A later deterministic requirements-grounding round supplied the live prerequisite facts. These were automatic harness corrections; operator corrective prompts remained zero.
4. Luna returned one current step, “Complete the electronics and steam-power research triggers,” with aligned `research_completed` contracts and no operations. `plan.delegation_committed` recorded reason `validated_plan_without_initial_batch`; immutable plan `goal_0mqy4p0_1_p3` committed with validation scope `completion_contracts`.
5. C3 restaged to executor (`ho_1ceab243a24e`), packet 2,323 characters versus the prior conversation's 78,313 characters; planner parked. No synthetic receipt or world progress occurred.
6. The executor packet carried the committed research contract, a green-science recipe fact, and three fresh counts for green science, belts and inserters. It omitted the research path and exact trigger facts the planner had received. Its decision envelope still said `observation_budget_remaining=0` and `observation_families=research_state`.
7. The executor's provider request had tools with `tool_choice: auto`, but Luna selected a BLOCKED control reply: it needed the exact live research-trigger requirements before performing the step safely. It made no fresh observation or gameplay batch. The harness returned `recoverable_provider_failure:provider_reported_blocker`, board paused at 0/1, canonical goal still active. No false retirement or completion occurred.

## Attribution and next bounded repair

The captured packet confirms loss of relevant research facts at the handoff. The inherited zero observation allowance also discouraged reacquiring them, despite the provider request allowing tools. This is strong evidence of a harness context/observation-lifecycle gap behind this pause; it does not establish that Luna would finish the game after that gap is repaired. Luna also required an automatic correction for mismatched declaration count before commitment.

The next repair should select executor facts from the active contract's technology subjects, carry or freshly read their authoritative research paths/triggers, and derive relevant inventory subjects from those facts. It should give a new executor decision a bounded way to obtain missing required observations without resetting the shared provider/campaign allowance. Replay this retained packet unchanged, then prove continuation with corrected scripted responses. Preserve committed IDs/contracts and actor/epoch/handoff fences. Do not hard-code the assisted red-to-green sequence or resume this trial with corrective operator prompts.

The log checker returned no findings over 65 behavior rows, zero parse errors. That is a limit of its current signatures, not evidence of autonomous success.

## Usage and retained evidence

Luna reported 109,582 input units (53,760 cached; 55,822 uncached) and 1,656 output units, total 111,238. Four planner rounds and one executor round. This failed trial supplies usage evidence, not a fair efficiency comparison against the old controller. All five recorded Jev exchanges returned; the narrower terminal Jev health summary covers three contracts and reports zero fallbacks.

Ignored local evidence: `test-results/luna-planner-first-live-2026-10-06/`. It includes the pinned build, exact run/verification scripts, deployment report, starter/run contract, before/final/periodic world snapshots, persisted NPC state, behavior/prompt/decision logs, server console, diagnostic events, usage summary and log-check report. `evidence-manifest.json` hashes 15 captured evidence files. Account weekly usage read 44% at closeout; the previous recorded checkpoint was 39%.

No production deployment, new runtime change, multiplayer acceptance claim or additional live run occurred.
