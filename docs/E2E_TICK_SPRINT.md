# Accelerated E2E construction: tick-sprint preparation

Owner decision: October 23, 2026. Source:
`d33e9697dab4b96cbaebf21c8d551822d941dabb`; task `docs/e2e-tick-sprint`.

Status: **approved direction; implementation and native validation pending**.
This prepares future runner changes. It does not enable acceleration, authorize
another trial, or change an already frozen run. Run AO keeps its 1× construction
contract and controls. Existing runners must not be used at 4× until the adoption
gates below pass.

## Profiles and initial limits

Freeze one construction profile before the objective:

| Setting | `normal` | `accelerated` initial profile |
| --- | --- | --- |
| Baseline construction speed | 1× | 1× |
| Maximum sprint speed | 1× | 4× |
| Maximum ticks per burst | None | 600 (10 game seconds at 60 ticks/second) |
| Maximum wall time per burst | None | 3 seconds, including supervision delay |
| Maximum sprint ticks per wait episode | None | 3,600 |
| Construction wall cap | Reviewed run cap | Same reviewed cap; currently 60 minutes |
| Model/Jev/recovery allowances | Existing limits | Same limits and accounting |

These are initial engineering defaults, frozen with the profile. Enforce the tick
bound in an engine-resident guard and the wall bound with a host watchdog.
Requested speed multiplied by wall time is not proof of actual ticks advanced.
Normal-speed results remain the baseline; accelerated results are a separate
class. Advancing the world does not shorten LLM requests or repair a missing wake.

## Harness ownership and eligibility

Only the harness admits, renews and restores sprints. Models and overwatch cannot
change speed or mint leases. No model-generated Lua or gameplay repair is added.
A sprint requires fresh authoritative proof of all the following:

1. The frozen profile is `accelerated`; run, actor/epoch, goal, plan/version and
   active step match. Zero humans, healthy actor, no pause/cancellation, structural
   blocker, terminal condition or unresolved native effects.
2. There is useful tick-driven work: a confirmed admitted native operation, an
   explicit native production wait, or verified relevant producers operating
   while an owned model request is outstanding. An idle NPC or in-flight LLM
   request alone is insufficient. Unknown admission/effects prohibit sprinting.
3. No observation, response application, new admission, step/plan transition,
   measurement, stop or save boundary is in progress. Fresh threat facts show no
   combat, actor damage or nearby threat; unknown threat state prohibits a sprint.
   Existing construction enemy rules remain unchanged.
4. The durable wait-episode budget remains. An episode belongs to one exact
   native batch/wait, or pending provider request plus producer binding. Polling,
   restage, restart and duplicate callbacks cannot renew the same allowance.
   Genuinely new admitted work has a new episode; global guards remain unchanged.

Persist allowance expenditure before changing speed. Admit one serialized lease
with run/source/profile, actor/epoch, goal/plan/step, episode ID, native start/end
ticks, monotonic wall deadline and speed. The native guard verifies it. Leases
cannot overlap, survive restart or follow a replacement actor/goal.

## Observation and action boundaries

Use this ordered transition:

`eligible at 1× → persist allowance → arm native guard → sprint → restore 1×
→ confirm speed/identity → refresh facts → normal harness continuation`.

- End at the earliest tick/wall cap, operation completion, relevant native event,
  provider response arrival, boundary request, player arrival, threat, owner
  change, cancellation or terminal decision. Restoration cannot depend on the
  ordinary 90-second E2E observation cadence.
- Every observation tool, new admission and provider-response application must
  acquire the same boundary barrier. Restore and confirm 1× before reading or
  applying anything. Buffer replies while acquiring the barrier if necessary.
- Refresh affected inventory, exact entity, topology and checkpoint facts.
  Existing admission/completion validators remain authoritative. Cached dynamic
  pre-sprint state or speculative predictions cannot authorize execution.
- The native guard independently restores 1× at the end tick and safety events,
  even after a host disconnect. The host watchdog handles wall expiry. Failure
  triggers restoration and safe stop; unconfirmed restoration fails the run.
- Recheck eligibility and budget before each burst. No unlimited renewal,
  corrective prompt, manual resume, duplicate mutation or extra provider retry.

## Clocks, terminal policy and acceptance

Keep provider/Jev deadlines, recovery/no-progress guards, quota checks and the
construction cap on their existing wall/monotonic clocks. Never reset or extend
them after sprinting. Native work and throughput use actual native tick deltas.
Record wall time and game time separately.

Runner and external supervisor share one tested speed policy: 4× is valid only
with the exact current native guard and unexpired lease for the frozen profile.
A blanket whitelist of 1× and 4× is insufficient. Unexpected speed, stale/absent
leases and unknown guard state remain invariant failures. Normal mode stays 1×.

Return to confirmed 1× before paired cancellation/operator pause, native
idle/empty-queue proof, save and exact-version load verification. Measurement
remains a separate declared phase using its reviewed speed, duration, native
topology and fresh automated-output contract. Construction leases cannot operate
during measurement or authorize its speed. Throughput uses actual game time;
placement, hand feeding and model claims cannot establish automation.

## Required report evidence

Preserve the frozen profile, controller/guard versions and complete speed history.
Each sprint records request/run/episode/lease IDs, actor/epoch, goal/plan/step,
trigger, requested/observed speed, start/end wall times and ticks, exit reason,
budget expenditure, 1× restoration proof and post-sprint freshness outcome.
Include refused attempts and faults. Human and machine-readable reports separate:

- Model/Jev latency, native operations and explicit waiting, with overlap shown.
- Game time, construction wall time, sprint wall/tick totals, burst counts, speed
  distribution, restoration failures and the original construction wall cap.
- Model observation tools from harness/guard polling, including known caches.
  Give polling a fixed budget; it cannot bypass model observation rate limits or
  disappear from tool accounting.
- Measured durations from any estimated saving. A 1× equivalent derived from
  ticks is an estimate, not measured end-to-end wall savings or a fair comparison
  with a different seed/profile.

Existing [E2E repair requirements](E2E_REPAIR_REQUIREMENTS.md), complete plan/API
accounting, immutable evidence and exact owned-resource cleanup still apply.

## Adoption gates before an accelerated provider trial

- [x] Implement the bounded native guard and harness boundary barrier.
- [x] Integrate runner, external classifier, snapshot/identity manifest,
      emergency stop and save paths around the same profile/lease contract.
- [x] Deterministic lifecycle tests cover eligibility/refusal, concurrent reply/
      read/admission, stale owners, duplicate callbacks, durable exhaustion,
      host/native faults, pause and restart.
- [x] Native exact-version proof at 4× covers real craft/smelt/wait progress,
      tick limits, completion restoration, threat/damage events, host disconnect
      fallback and confirmed 1× at observations and save.
- [x] Negative controls reject 4× normal mode, forged/expired leases, unknown
      effects, idle-with-no-work sprinting and construction leases in measurement.
- [ ] Offline gates, independent review and a new frozen candidate/profile pass.
      Further agents and live trials require their own applicable authorization.

The zero-human profile additionally proves native arrival-safety-hook restoration,
registered join-handler source wiring and the per-tick connected-human refusal.
The arrival hook is invoked synthetically: real engine join delivery, networking
and peer-load synchronization remain unvalidated. They are not claimed by this
bounded adoption. Native proof loads an explicitly saved active lease while
paused, invalidates it before unpause and preserves expenditure.

Implementation evidence and remaining promotion gates are recorded in
[the controller checkpoint](validation/E2E_TICK_SPRINT_CONTROLLER_2026-10-23.md).
These gates do not authorize another live trial or publication.

## Startup clock gate after Run AP

Server auto-pause is a launch setting. Factorio2.0.77 rejects `/config set auto-pause false`; manual unpause and a positive tick delta after console traffic do not prove an independently running world. Accelerated startup first restores1x and replicates pause/lease invalidation, saves and cleanly reloads that same paused world under authoritative `auto_pause:false`, then reconciles the actor before any clock advance. Before constructing or waking the NPC, sample a quiet1000ms native interval with no intervening observations and require at least30ticks/s, speed1, zero humans, idle queues and no active lease. Repeat the quiet proof before opening the ready fence. This is a liveness floor, not a60UPS performance claim.

A residual stalled clock permits one run/source-scoped, fsynced harness correction. Persist attempted/completed/exhausted outcomes. Interrupted or exhausted correction blocks restaging before another restart even if the clock later appears healthy. Unsafe, busy, stale, ambiguous and storage-failure cases remain paused; no provider/Jev retry owns this recovery. Prove prevention, injected native settings miss, successful automatic continuation and durable exhaustion through the actual Session with zero inference. Native10 failed this startup gate; its positive-delta assertion is superseded by the actual-Session lane and exact Run AP regression.
