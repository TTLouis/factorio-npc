# Native factory endpoint facts — October 29, 2026

Problem: dependency reconciliation cannot identify a miner's item drop, an exact
inventory, a runtime fluidbox or a heat service from declared registry metadata
alone. Numeric prototype fluidbox indexes can differ from runtime indexes.

Owner: parent `/root`, Astra implementation, independent Sol review. Task branch
`feat/factory-native-endpoints`, source
`0d84b7d09be8ce8503708ce1552940a5b27d7e7a`. The parent owns containers, validation,
commits and integration. This task adds observations only; registry/CAS work has
a separate owner. No assignment, port, dependency, goal, plan, authority, model
tool or RPC changes are included.

`observe_factory_cell` retains its existing exact world/actor/surface/force,
idle, member identity and visibility boundary. Its additive `endpoint_facts`
uses the enclosing member identity and reports:

- Successful native inventory indexes, observed roles and bounded current slot
  filters. Unclassified inventories remain explicit unknown roles. Empty filters,
  unsupported filtering and getter failures are distinct.
- The existing visibility-fenced item drop route, without inventing a receiver
  inventory or claiming delivery.
- Runtime fluidbox indexes, the native prototype definitions behind each box,
  current dynamic filter and locked fluid. Recipe-to-endpoint association remains
  unknown; no numeric-index equivalence is inferred.
- Electricity and heat service facts separately. Electric network identity is
  current evidence, explicitly not a stable endpoint or proof of supply.
- Actual selected recipe quality from the second native `get_recipe()` return.
  Missing quality is unknown. Quality compatibility is unverified.

All output/work bounds are software limits. Existing consumable input requirements
and burner category semantics are unchanged. This is not full dependency
reconciliation, generalized enrollment, admission or bounded recovery completion.

Evidence is private outside Git under
`test-results/factory-tracker-stack-20261029/factory-native-endpoints/` in the
shared workspace. Probe inputs were fresh copies of the retained earlier native
save and exact compiled native mod. The parent records hashes and cleanup.

- `probe-01/results/native-endpoints-probe.json`: Factorio 2.0.77, actual active
  mods recorded, zero humans/providers, paused tick unchanged. Native userdata
  indexes, merged prototype definitions, dynamic filters, heat service presence,
  and an actual changed selected quality were observed. Optional wagon creation
  failed and established no filter-positive proof.
- `probe-02/results/native-endpoints-probe.json`: populated native fuel filter
  returned item name, quality name and comparator. The declared normal-speed
  setup advanced **one native tick**, 697 to 698, over 527 ms; 120 ticks/3 seconds
  were limits. Pause was restored before all observations. The miner still
  returned nil for its native drop target; this task does not claim a positive
  connected miner target from that fixture. No extra retry was performed.

Acceptance: source unit tests exercise independent getter errors, nil, bounds,
merged indexes, quality/filter refresh and real observation fences. The native
runner's `--phase verify` compares every projected fact with the corresponding
live getter, checks known empty Lua-table normalization, changed quality, filter
selectors, identity fences and unchanged observation bookkeeping. Containerized
unit/type/Lua checks, full offline gate, native projection proof and independent
review are pending at this checkpoint.

Checkpoint: implementation and deterministic driver prepared; host syntax and
whitespace checks pass. Parent must run gates and compiled-native verification
before freezing a candidate. No gameplay success, sustained supply, complete
tracker or E2E readiness claim follows from this endpoint layer.

Continuation checkpoint, October 29: the typed route-array binding is retained
and documented so Lua compilation uses the array helper. Long dynamic and
prototype fluid filters and locked-fluid names retain explicit truncation
diagnostics. Getter exceptions have `state: error` with bounded diagnostic codes;
missing/malformed/unverified facts remain `unknown`, unsupported services remain
`not_applicable`, and native nil/empty results remain known absence. A known
inventory/fluidbox enumeration identifies the endpoints only; consumers must
also check each relevant nested role, filter, prototype and quality fact.

The native projection driver now compares the full projected filter, definition,
locked-fluid, network and heat states to live getters. The productive
`factory_cell_observation_factorio.mjs` fixture additionally checks, in both
prepare and reload phases, that the exact drill's projected drop route equals
its existing `item_routes` entry and that its full target identity equals the
exact observed receiver. This is deterministic fixture evidence, not autonomous
recovery. Newly compiled execution and independent review remain required;
the earlier probes and failed compilation are not proof for this revision.

Verified continuation addendum, October 29: evidence under the shared workspace's
`test-results/factory-tracker-stack-20261029/continuation-endpoints/` supersedes
the pending execution statements above for this endpoint candidate:

- `gate-01.log` / `gate-01.exit`: full candidate offline gate passed, including
  104 agent, 4,675 runtime and 1,757 mod tests, type checking, Lua compilation
  and generated-Lua verification. `lint-01.log` / `lint-01.exit` passed.
- `native-02/projection/native-endpoints-verify.json`: newly compiled Factorio
  2.0.77 endpoint verification passed all 30 member comparisons across initial
  and refreshed observations, with zero provider calls.
- `native-02/productive/factory-cell-prepare.json` and
  `native-02/productive/factory-cell-reload.json`: productive prepare and exact
  saved-world reload passed, each positively checking the full exact receiver
  identity and equality with the existing item drop route. Both recorded zero
  provider calls. Full ZIP integrity checks passed before and after reload;
  execution and archive-check output is retained in `native-02/native.log`.
- `native-01` stopped at the fresh-console acknowledgement setup boundary,
  before projection verification; its empty JSON response was a fixture setup
  failure, not a passing endpoint proof. Its owned container was removed, as
  recorded in `native-01/cleanup.json`; the retained evidence remains local.

Final independent evidence review and integration gates remain required. These
results verify the endpoint prerequisite, not whole-tracker completion,
commissioning, sustained delivery or autonomous E2E readiness.
