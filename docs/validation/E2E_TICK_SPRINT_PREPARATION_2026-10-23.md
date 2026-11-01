# Future E2E tick-sprint preparation — October 23, 2026

Problem: native work may progress slowly while a model request is outstanding;
the current frozen runner correctly rejects construction speeds other than 1×.

Owner: side conversation `01a169e1`; task `docs/e2e-tick-sprint`; source
`d33e9697dab4b96cbaebf21c8d551822d941dabb`.

Requested result: prepare the accelerated-mode changes and update E2E rules.
This is a documentation/preparation task. No runtime, game, active Run AO helper
or evidence, model/provider configuration, deployment or integration checkout
is changed. No subagents or live trials are used.

The [prepared contract](../E2E_TICK_SPRINT.md) defines initial 4×/600-tick/3-second
bursts, a durable 3,600-tick episode allowance, native and host restoration,
freshness barriers, shared stop-policy changes, normal/accelerated reporting and
the required deterministic/native acceptance cases. Shared workspace E2E policy,
the task checkout's AGENTS.md, workflow and production-validation entry point
link these requirements.

Acceptance:

- [x] Current and sealed trials retain their speed and acceptance contracts.
- [x] Future profile has concrete owners, bounds, eligibility and stop/read fences.
- [x] Wall guards, native mechanics, completion authority and measurement remain
      explicit; sprinting is not a liveness-repair mechanism.
- [x] Reporting separates wall/game time, model latency, native work, polling and
      estimated savings; normal-speed baseline results remain separately labelled.
- [x] Implementation, lifecycle/native validation and integration gates are
      durable and clearly marked pending.

Validation: relative document links and changed-file whitespace checked locally;
no runtime code or executable configuration changed, so no gameplay capability
or accelerated native proof is claimed. The task remains separate from the
integration checkout for review/adoption after the main trial.

Next work: implement the native speed guard and serialized harness boundary
barrier; integrate both runner and external terminal classifier; prove fault and
restart cases in deterministic and real-engine lanes, then obtain independent
review and freeze a new trial candidate. Enabling speed directly in the existing
runner is not an acceptable shortcut.
