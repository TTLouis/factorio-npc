# Run BF preservation repair

Owner: Codex /root chat01a18531. Task: fix/item-route-container-preservation.
Base: 3a1827ae5face33f619289ddcd8a290b380cc7e6.

BF A admitted belt43 mining despite preserved inserter44 naming it as its drop
endpoint. BF B rejected an ordinary chest while capturing successor obligations.
The sealed BF reports and original evidence remain unchanged.

## Changes and limits

The shared admission boundary checks recorded item pickup/drop targets and
positions for both proof versions, at preflight and immediately before transport.
It covers exact removal/rotation, matching prototype removal, opaque clearance,
and placement tile coverage. Unknown geometry fails closed. It refuses the whole
batch and preserves the original operation list and immutable obligations.

An unsent miss uses the existing authoritative zero-send reconciliation and one
durable same-semantic-step argument correction. The model may propose a different
operation; the harness owns admission, completion, allowance and native receipts.
A changed or already-mined protected identity cannot be recreated as that entity:
it remains a guard pause with before/after projection evidence.

Ordinary containers now expose native preservation capability and support fresh
identity/scope/geometry capture. Stock is not frozen. Unsupported types fail with
a preservation error, without a misleading provider classification or repeated
model retry. A transient unreadable initial capture permits one durable read-only
recapture of exactly the same intent under settled native and ownership fences.
Repeated failure or a spent claim pauses. Restart cannot refund either allowance.

The scope is recorded direct endpoints and open ports, not the entire transitive
belt network. Incoming routes to a passive container require preserving their
source machines, as BF B did with drill29 and chest30. Logistic containers remain
unsupported. No live trial, deployment, push or historical BF success is claimed.

## Proof

- `bf-preservation-baseline.test.mjs` fails both positive expectations on the exact
  original source: the endpoint-removal predicate misses belt43 and ordinary
  chest projection is unsupported. The same tests pass on the repair.
- `item-preservation.test.mjs` drives original A's exact eleven operations through
  real request/final admission after deliberately bypassing early preflight.
  The entire batch is unsent. Original B's description, outcome and [29,30]
  preserve IDs capture, commit and continue through ordinary receipt handling,
  including one deliberately malformed capture response.
- Composed lifecycle tests verify automatic continuation, unchanged committed
  plan/proof, durable exhaustion/restore, and refusal on cancellation, new intake,
  amendment, wrong step, actor change, native work or uncertain journal state.
  Capture-specific tests cover ownership changes during the first failed read,
  a newer busy native reply, failed recapture and spent same-intent restart.
- `run-check.mjs` recognizes original BF A/B terminal shapes and new capture
  failures. Successful recovery events alone do not count as terminal failures.
- `tests/factorio/runner/item_preservation_factorio.mjs`, included in the existing
  entity-observation lane, passes on Factorio 2.0.77. Both native cases reject
  removal, collect the required coal via exact native receipts, retain the belt,
  chest and inserter identities/routes, and complete the immutable goal. One case
  injects both an early-preflight miss and a lost capture reply. Each spends one
  argument correction; the injected capture spends one successful recapture.

Native fixtures are new isolated worlds with scripted replies, not resumed BF.
The original reply replay substitutes outer goal/library context and unavailable
nonendpoint geometry explicitly. The native open-port boundary test substitutes
a point between actual native tile and collision boxes. New fixture memory seeds
its ordinal from the settled native journal so preceding lane cases remain intact.

Independent review approved the final code after five findings were corrected:
tile coverage, exact original replay, B residual recovery, initial ownership
capture, and validation of the newer native-status response.

Local full logs, native transcripts, metrics and review evidence are retained at
`test-results/item-route-container-preservation-20261028` in the shared workspace,
outside Git. `baseline-negative2.log` is the exact two-test negative control;
`native-smoke.log` and `native-results/item-preservation.json` record native PASS.
The final gate and integration SHAs are recorded in that directory's closeout.
Earlier gate4 passed all 4403 runtime tests but had two existing mod setup-hook
timeouts; those failures are retained and are not counted as a successful gate.

The final candidate gate uses the unchanged suite with mod worker concurrency
capped at four, retaining the normal hook timeout and every assertion. Runtime
4403/4403, agent104/104 and mod1703/1703 pass; type/Lua/generated checks and
the command exit are recorded in `gate6.log`. Scoped lint also passes.
