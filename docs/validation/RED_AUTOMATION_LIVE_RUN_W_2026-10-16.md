# Run W — minimum-prompt delegated red-science trial

One owner-authorized trial ran for **21.04 wall minutes** at frozen source
`9e00fc5c69ca70acb11d95f59cf33cc64471f0ee`. It ended on the current goal's
unchanged **six-resume limit**, before the approved 60-minute construction cap.
Red production was **zero** and the unattended measurement never started.
The broader E2E goal remains **paused**. No second trial, production fix, push
or deployment was performed.

## Objective and supervision

The only gameplay objective was:

> !luna Build a fully automated factory producing at least one automation-science-pack per game minute from natural resources.

The owner approved this minimum prompt, one 60-minute construction cap, a
one-trial 40% weekly-remaining floor and a subagent supervisor. Measurement
requirements stayed in the external supervisor, outside the gameplay prompt:
parent-reviewed native topology/readiness, paused AI mutations, empty task and
crafting queues, enemies removed and expansion disabled for measurement,
five wall minutes at 2x, at least ten game minutes and ten NEW red packs at
at least one pack per game minute, with verified upstream ore/fuel/item paths
and real steam power. Construction stayed at speed 1. No measurement gate was
reached, so no unattended or full-chain throughput claim is supported.

Fresh actor 10, seed 2988699423 and goal `goal_17w7q2h_1` started at
19:11:21.972Z. Zero humans were present. The original starter was granted once;
there were no operator gameplay actions afterward, corrective prompts,
manual resumes or provider retries. The supervisor owned observation,
terminal classification, paired stop and checkpoint preparation; the parent
owned release verification, independent evidence review and cleanup approval.

## Verified interpretation, delegation and native progress

The planner interpreted the minimum objective as a long-horizon goal with
`production_rate` for `automation-science-pack`, `per_minute:1` and
`window_minutes:1`. Its roadmap covered steam/electronics, a powered lab,
automation research, automatic mining/fuel/smelting, gears/red production
and sustained output without manual feeding. This verifies goal interpretation;
it does not establish reliable end-to-end execution from a minimum prompt.

- Actual provider wire: Sol 6.1 planner **10/10**, Luna executor **65/65**;
  total **75/75**, zero provider errors. Jev **48/48**. Both roles used the
  dedicated `cli-proxy` profile with open and closed decisions. Closed Luna
  requests retained 40 tools and explicit `none`; Sol closed requests retained
  40 tools or the exclusive one-schema checkpoint contract.
- Native production: **50 new iron plates and ten copper plates**, after
  mining 50 iron ore, ten copper ore and 20 coal. The furnace finished 60
  products. Handcraft bootstrap consumed ten gears; automatic gears remain
  unproven.
- Placed: furnace 19, pump 20, boiler 21 and poles 22/23. Pump and boiler
  have reciprocal water connectivity. Final boiler contains 200 water,
  200 steam at 165C and eight coal; its steam output is unconnected.
- One steam engine remains in inventory. No engine placement was admitted.
  There is no working electric power, lab or automatic science chain;
  red production is zero.

## Terminal authority and exact remaining blocker

At 19:32:12.021Z, `recovery.auto_resume_exhausted` identified the current
goal/plan/step and `limit_kind:goal`, `goal_attempts:6`, `goal_limit:6`,
`reason:goal_limit_reached`, request `recovery_mvbd4fvb`. Step attempts were
zero after native progress reset the step counter; the goal-wide limit remained
exhausted. The shared supervisor classifier used this scoped event as stop
authority. This was not Run V's premature stop on a recoverable pause or a
diagnostic string containing “exhausted.” The cap and usage floor did not fire;
weekly remaining was 44% at the final check.

Independent offline review corroborated a model omission/misreading:

1. At 19:30:43Z, Luna requested broad steam-engine placement candidates using
   center/radius, without `connects_to`. Native returned 484 legal placements,
   with eight candidate rows. The subsequent closed request delivered those
   rows and full boiler steam-port geometry. Generic placement legality does
   not establish a connected steam site.
2. Luna then supplied coal and placed poles. No engine placement was submitted
   or natively refused. A targeted read with an attached checkpoint was
   correctly rejected as `read_cannot_edit_or_complete_plan`.
3. The final 19:31:56.333Z request contained fresh inventory with one steam
   engine, rebased boiler geometry and fresh nearby geometry. The final
   19:32:11.669Z reply nevertheless claimed the engine was absent. That claim
   contradicts delivered facts; missing inventory/baseline context is not
   demonstrated here. Response ID:
   `resp_00b7b9fa4fde92a0016ad27bac511c87d1900779b3bdb45730`.

The next useful offline check is to replay the saved layout before and after
pole placement with the existing connection-specific engine query for boiler
21, steam storage 2, under unchanged budgets. Verify admitted placement,
actual steam generation and load power. A connected site remains unproven.
A scripted better model choice alone would not prove a harness defect;
production changes need evidence of a dropped/misrouted fact or wrongly refused
valid request. This review made no production changes or extra live calls.

## Release, stop, save and cleanup proof

Actual server image:
`sha256:0b063ef303c5f5358ae99b83d16e27872e84a295949e1b9810c28b0d151f2b68`.
Preparation passed 40 offline helper tests, ten JavaScript syntax checks and
six PowerShell parse checks. Independent helper review and actual deployed
50-module/prompt/manifest, compiled-mod, both-role serializer, cold-world and
single-attempt model-catalog checks passed before live release. These preflight
checks made no upstream inference. Existing `.env` values were untouched.

Fresh cancel at 19:32:23.819Z and same-goal operator pause at 19:32:23.828Z
confirmed cleared intake, native idle, queue zero and empty crafting at
19:32:24.129Z. The fresh **883,308-byte** checkpoint was written afterward;
Factorio's named-save start and `Saving finished` were verified, along with
archive stability, all **56 entries**, full CRC/decompression and complete
same-root native split-save contents. Parent independently verified stop/save
proof before releasing isolated shutdown.

- Save SHA256: `4288b6027bb1d116c6c0ee929482466438d74aaf1c3dc70ccce35d9e0264fd3f`.
- Result SHA256: `4718ba7f2a47763b2a541010164160c2f2f4a76ae75eb6eb27cdce0fa1192c7f`.
- Only project `red-automation-20261016w` was brought down at 19:34:46Z;
  zero owned containers remain. Its trial-owned tunnel was removed after
  exact process/start/listener checks at 19:35:39Z. Saves and traces remain.
- The one-trial 40% reserve exception ended; future trials require their own
  authorization under the ordinary 50% boundary.

Ignored local evidence is under
`test-results/red-automation-live-2026-10-16w/`: release/preflight packets,
raw provider/behavior/decision traces, native state/snapshots, terminal result,
save proof/archive, cleanup proofs, diagnostic and final handoff. Private
overlay/configuration files are excluded from the public evidence manifest.
The reviewed preflight helper freeze is retained separately from final mutable
status/milestone evidence. Parent verified all 76 final manifest hashes/sizes.
Manifest SHA256:
`bc2660fdc3d399aee78f95eaf1b351648439d981bd0b9809d9593d6ae223207c`.
Final summary SHA256:
`198dc7f405c23b9c1ff5706d887b5dcf311e2f4ee9bf1acb2df526ade7c73087`.
The final seal is recorded alongside the evidence.
