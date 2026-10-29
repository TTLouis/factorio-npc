# Native factory input requirements — 2026-10-29

Problem: exact-member factory observations exposed recipes, buffers and burner
categories, but lacked a bounded projection of the other process inputs. Empty
buffers, dormant recipes and network identity cannot establish absent inputs or
a verified supplier.

Owner: parent `/root` integrates and owns tests/native resources; Astra implements
this bounded native projection; Sol reviews. Branch:
`feat/factory-input-requirements`, based on Jev
`36431a95522e62093c7fc2664f1a7f212f182487`. The source remains uncommitted at this
checkpoint; the parent records the reviewed candidate and integration commits.

This is one prerequisite of the full production-cell tracker. Parallel work owns
revisioned assignments, ports, dependency bindings and host reconciliation. This
change does not implement those stages, physical updates, retirement, cleanup or
bounded same-goal recovery, and does not authorize an E2E trial.

## Contract

The existing `sgluna_factory.observe` response adds `input_requirements` only
after exact visible member resolution and the existing world, actor, surface,
force and native-idle fences. There is no new model tool or RPC. The existing
`burner_fuel_requirement` helper and its Lua userdata handling are preserved.

Each `material`, `fluid`, `power` and `fuel` domain has `state`, `required`,
`scope`, bounded `inputs`, `truncated`, and an explanatory `code` when unknown.
States distinguish complete known inputs, known nonapplicability, and unknown
coverage. Current recipe ingredients supply item/fluid identities and native
amounts and temperature constraints. Unset, failed, malformed or excessive
recipes keep both domains unknown. Visible mineable resources supply native
mining-fluid requirements; repeated deposit tiles do not multiply the amount.
Boiler/generator input fluidbox filters provide process-fluid requirements.

Native energy-source prototypes distinguish the proved electric consumer,
charging-storage, producer and heat-input cases. Other priorities are unknown.
Fuel categories are alternatives for one fuel input, never invented item names
or separate mandatory deliveries. A native fluid energy source is explicitly
unsupported/unknown until its selector semantics have independent proof.

`coverage.complete` means complete **current process consumable-input coverage
within the stated scopes**. It does not establish all operating constraints,
quality compatibility, rates, sizing, available deposits, delivery, supply,
automation, external sources or commissioning. Transport contents remain route
facts rather than consumable requirements. Unsupported process types remain
unknown. Consumers must preserve these qualifications and bind facts to their
own exact cell revision/session/actor epoch before use.

Lua's JSON encoder represents empty arrays as `{}`. Host consumers may normalize
an object with zero own keys only at validated array fields; a nonempty dictionary
is not an array. Omitted fields from old responses remain unknown.

No registry, assignments, declared ports, dependency edges, accepted goals,
committed plans or gameplay objects are changed by observation. Getter faults in
legacy observation facets now produce explicit per-facet unknown results.

## Acceptance and evidence

- [x] Exact native API availability probe before implementation.
- [x] Bounded projection, synthetic shape/fault tests and actual observation-boundary tests.
- [x] Real Factorio 2.0.77 static native projection proof with 16 fixtures.
- [ ] Final full offline gate and lint on the frozen candidate (parent).
- [ ] Independent final review and resolution of actionable findings.
- [ ] Integration and merged verification on the owned Jev checkout.

All raw evidence and full logs remain local and untracked under the workspace's
`test-results/factory-tracker-stack-20261029/factory-input-requirements/`:

| Evidence | Result and scope |
| --- | --- |
| `probe-02/results/input-requirements-probe.json` and transcript | API preflight passed on 41 prototype rows, including actual Lua userdata and nil/error distinctions. |
| `gate-01.log` / `.exit` | Exit 1: units/typecheck/build passed, generated-Lua checker caught an untyped array length. The implementation now types that array and uses explicit numeric length comparisons. |
| `gate-02.log` / `.exit` | Exit 0. Final long-name and observation-boundary test additions still require the parent's final gate. |
| `native-01/results/input-requirements-native.json` and transcript | Passed all 16 static fixtures and identity fences; native tick remained 697, zero humans/providers. |
| `native-source-hashes-02.json` | Current two production modules and their two test files exactly match this frozen source manifest at this checkpoint. |
| `native-image-02.json` | Compiled native image `sha256:f1add9332f4a152d90b41a7b7645d57f603d3f01eceb49abf3a7fca180212b9f`. Parent owns image cleanup and compiled-file export. |

The native lane compares selected current recipes, amounts and temperatures
directly against the engine, including a recipe change and fresh re-observation.
It covers item/fluid recipes, dormant furnace, filtered boiler/generator fluids,
heat/electric/storage requirements, wet/dry mining deposits, unsupported process,
known nonapplicability, and a synthetic recipe exceeding the software input bound.
It verifies world/actor/surface/force refusal, hidden-member omission and refusal
to substitute a replacement entity at the same position. Unit tests additionally
exercise native-busy routing, getter faults, malformed values, name bounds and
fluidbox traversal bounds. The fluidbox-overflow and fluid-energy-source fault
shapes are not claimed as native-engine fixtures.

Active native mods were `base`, `elevated-rails`, `quality`, and `space-age`
2.0.77; `autorio` 0.1.0; and the optional test fixture mod 0.0.1. This is not a
base-only proof. The fixture mod dynamically chooses actual item prototypes for
one deliberately synthetic oversized recipe. Its arbitrary fixture quantities
are not NPC knowledge, game guidance or production sizing. It must not ship in
the runtime payload or an E2E profile.

The native driver also recorded the second return of `get_recipe()`: all four
selected recipe fixtures returned userdata with a readable quality name. This
proves the getter shape for those selections only. Production does not yet
project that quality selector or claim nondefault-quality compatibility; a later
quality-aware binding needs explicit native evidence rather than a default.

Native fixtures were created only in the parent's isolated copied world while
paused. Parent reported the exact run container removed; final original-save
hash verification and image cleanup receipts belong to the parent's closeout.
This static observation proof establishes no production rate, sustained supply,
automated output, autonomous gameplay success or full-tracker completion.

## Files and checkpoint

Production: `packages/autorio/src/factory_input_requirements.ts` and
`packages/autorio/src/factory_cell_observation.ts`. Tests are their adjacent
`.test.ts` files. Native drivers are
`tests/factorio/runner/factory_input_requirements_probe.mjs` and
`tests/factorio/runner/factory_input_requirements_factorio.mjs`; the optional
data-stage fixture is `tests/factorio/fixtures/factory-input-requirements/`.

Next owner action: freeze the candidate, run the final gate/lint, complete Sol
review, and integrate through the existing Jev procedure. No provider call,
deployment, push or E2E trial was performed by this implementer.
