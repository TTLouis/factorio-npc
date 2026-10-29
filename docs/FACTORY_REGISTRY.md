# Factory registry

The factory registry records persistent production assignments and declared
dependencies. The native game remains authoritative for physical state; the
registry is authoritative only for accepted assignments. A declaration does not
prove that a machine is configured, connected, supplied or producing.

This implements the first stage of the production-block observation direction
in [the production validation ladder](NPC_PRODUCTION_VALIDATION_ROADMAP.md#7-production-block-observation-and-diagnostics).
Goal, plan and authorization ownership remain defined by the
[planning roadmap](NPC_PLANNING_ROADMAP.md) and
[macro execution contract](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md).

## Stage 1 boundary

The foundation includes world identity, stable cell IDs, immutable assignments,
exact member identities, declared input/output ports, dependency validation,
reverse consumer lookup and canonical-memory persistence. Guarded runtime
enrollment is separate from provider submissions. No model JSON operation writes
the registry.

Stage 1 ships the guarded runtime API and its persistence/admission integration;
no production caller currently initializes or enrolls cells automatically. A
trusted host integration must supply the explicit world identity, current runtime
context and retained exact native placement receipt lookup. Installing this stage
alone does not populate the registry or protect legacy hardware as assigned cells.
Automatic population and model-facing declarations belong to later stages.

Native commissioning, automatic enrollment, legacy adoption, cell expansion or
conversion, retirement, temporary-building cleanup, public model lookup tools and
automatic gameplay correction are later stages. This foundation is not evidence
that the BH autonomous failure has been repaired.

## Identity and assignments

A registry has an explicit world identity independent of actor, request, goal,
plan, map seed and cell labels. Each cell has a stable allocated ID and a scoped
surface/force identity. Native member locators include exact unit, prototype and
position; a prototype name alone does not identify a machine. IDs are not reused
when the NPC receives a new goal or the runtime restores a saved snapshot.

Assignment records describe the cell's intended products, purpose and method.
Origin records identify the accepted task and placement history; they are
provenance, not a substitute for current authority. Production members cannot be
assigned to another cell through another registration. Observed products cannot
change the assigned job. Stage 1 provides no reassignment or retirement shortcut.

A commissioned copper cell must eventually remain a copper supplier across plan
slices. It must not become free construction hardware because a later plan omits
it from `preserve`. Registered members are excluded from the direct-feed bootstrap
pool of placed machines. This does not yet classify every legacy unregistered
structure or certify a supplier's actual output.

Cell identity does not make the cell private to its originating goal. Later tasks
can query its assignment without rewriting the original goal or committed plan.
The registry never completes a task, advances a step or grants world-operation
permission.

## Dependencies

Each dependency names an input port and one supplier: another cell's output port,
an explicitly named external boundary, manual support, or an unresolved source.
Ports distinguish material, fuel, fluid and power needs. Their resource identity
is explicit where applicable. Delivery records describe the intended mechanism;
all stage-1 connections remain unverified.

Cell-to-cell connections must reference existing ports in the correct directions,
with compatible resources and scope. A material supplier's declared product must
match the output port. Power is a service, not an invented item. Multiple
suppliers can serve an input, but duplicate consumer/supplier declarations are
rejected. Shared infrastructure must not be represented by assigning one
production machine to several cells.

Cycles are permitted. Reciprocal fuel supply can be a legitimate design; declaring
its edges still does not prove startup, flow or sustainment. Reverse consumer
queries terminate on cycles and report declared impact, not measured physical
dependency or permission to interrupt a consumer.

Fuel and material supply are recorded separately from whether the cell runs
automatically. A cell can be automatic and still depend on external fuel, power
or ingredients. Neither stored capacity nor a static recipe bill is evidence of
current supply. Future validators must obtain facts from native tools.

## Runtime and persistence

The canonical memory facade owns the registry snapshot and restore path. An absent
legacy field does not adopt existing entities. An explicitly malformed record
creates a durable fault; it must not silently turn assigned machines into free
hardware. Queries return defensive copies. Runtime mutations check current world,
actor, task, request and revision ownership through the guarded facade.

Enrollment requires recorded NPC placement identities and exact scoped provenance.
The old placement list alone lacks sufficient world and task detail for automatic
adoption. No provider-supplied `source` or evidence label grants enrollment or
asserts successful native commissioning.

Current registration authority and historical placement provenance are distinct.
A cell can be assembled across several requests and steps; each member retains
its original native placement history. The current active task authorizes the
registration. Stage 1 enrollment is explicit and limited to retained receipts
within that goal and the same world/surface/force. This restriction does not erase
already registered cells when a later goal begins. Broader legacy adoption needs
its own validated protocol.

Registered destructive or reconfiguration operations are refused at the existing
admission boundary until a later authorized change protocol exists. Ordinary
operations still pass through existing authority, stock, preservation and native
preflight checks. An unchanged assignment is not permission to bypass those checks.
Natural area clearing independently excludes placed buildings in the native
implementation. Compound construction is placement-only with clearance refused;
the registry does not claim to validate a complete new construction design.

## Updating a cell in later stages

Keep a stable cell ID for expansion or modification that preserves its job. The
future change protocol must retain immutable revisions, compare expected revision,
record exact affected assets and consumers, and reconcile every partial native
effect. A failed modification cannot publish a new verified revision. An
interrupted old installation must be reported as degraded rather than advertised
as still producing.

Changing the job requires explicit conversion and lineage. Retirement requires
consumer migration or explicit cessation, safe contents handling and native
removal receipts. Temporary assets require beneficiaries and removal conditions.
No stage-1 method implements those transitions or erases their future obligations.

## Validation claims

Foundation tests must cover scoped identity, duplicate assignments, defensive
queries, dependency directions/resources, external/manual/unresolved suppliers,
valid cycles, reverse impact, corrupt restore, stale owners and cross-goal
persistence. The original goal and committed plan must remain unchanged by
registration, observations and dependency additions.

Bootstrap and admission regressions must exercise their actual runtime entry
points. New APIs missing on an old baseline are not proof of the original BH
failure. Later correction stages must satisfy
[E2E repair requirements](E2E_REPAIR_REQUIREMENTS.md), including injected residual
miss, safe automatic continuation, native proof, restart and exhaustion. Native
mechanics and autonomous production success are separate claims from this
foundation's host-side persistence and enforcement.
