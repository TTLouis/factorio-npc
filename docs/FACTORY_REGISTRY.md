# Factory registry

The factory registry records persistent production assignments and declared
dependencies. The native game remains authoritative for physical state; the
registry is authoritative only for accepted assignments. A declaration does not
prove that a machine is configured, connected, supplied or producing.

The [October 31 completion addendum](validation/FACTORY_TRACKER_COMPLETION_2026-10-31.md)
records the combined candidate's native lifecycle evidence, recovery regressions,
current integration checks and remaining boundaries. Earlier stage notes below
describe their original prerequisite scope; they are not cumulative acceptance
claims for every later capability.

This implements the first stage of the production-block observation direction
in [the production validation ladder](NPC_PRODUCTION_VALIDATION_ROADMAP.md#7-production-block-observation-and-diagnostics).
Goal, plan and authorization ownership remain defined by the
[planning roadmap](NPC_PLANNING_ROADMAP.md) and
[macro execution contract](NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md).

## Implemented stages

### Receipt-backed use and physical lifecycle (integration validation pending)

The runtime also accepts `production_block` intents with exact member roles and
typed output roles. Repeated prototypes remain distinct members. Enrollment
requires retained native placement receipts and fresh native compatibility;
legacy `direct_feed` intent signatures retain their original representation.
Finite production can enroll an exact newly placed producer without a model
cell declaration. Its immutable job comes from the requested recipe and live
native outputs. An empty furnace startup requires a fresh native recipe-machine
capability, empty input/output inventories and zero crafting progress. Legacy
placement lists or arbitrary nearby machines cannot establish provenance.

Canonical commit, contract activation, admission and completion share typed cell
resolution with the actual loop's production, wait and pre-send paths. Missing
or null model fields do not exempt typed supply and operating requirements.
Read-only review and a production proposal awaiting normal admission grant no
use certificate. Certificates are ephemeral and fenced by world, owner, request,
registry and physical revisions; restart requires fresh evidence.

Supplier assignment, exact endpoint compatibility and delivered service are
separate results. A supported direct delivery window requires two owned native
frames, a complete sole incoming producer cut, and increased exact receiver
inventory or consumption from an initially empty receiver. A supported power
window requires a complete stable component with one capable producer, no
storage/interfaces/unknown sources, and increased consumer energy. These are
bounded delivery observations, not continuous-supply or whole-cell commissioning
claims. Stock, gauges, network IDs, cycles and empty graphs cannot substitute.

The private lifecycle ledger projects current installed members over immutable
birth history. Metadata updates bind the physical revision and validate the
installed member set; restore replays the corresponding lifecycle prefix.
Physical claims and receipts persist before further operations. Exact partial
removal custody may be reconciled from fresh native facts without refunding the
frozen action allowance; uncertainty remains held. Temporary support cells have
no fabricated product: their private pre-placement intent, beneficiaries and
retained receipt authorize classification and eventual cleanup. Shared step
close runs cleanup through ordinary admission and rechecks its checkpoint.

Factory resolution recovery consumes an aggregate allowance of three attempts
per unchanged goal before invoking the existing guarded structural successor
path. Request callbacks, requirement changes, slices and restart cannot renew it.
Focused host tests establish these boundaries; full native continuation and
integration acceptance remain separately required. See the
[lifecycle validation record](validation/FACTORY_CELL_LIFECYCLE_2026-10-29.md).

### Additive metadata revisions (host prerequisite)

`commitFactoryCellMetadata(agent, change)` in `factory-cell-tools.mjs` is an
internal host capability, not a model tool. It appends declared input ports,
exact member endpoint bindings and their dependency records as one transaction.
Existing output ports can acquire bindings; existing ports, bindings and edges
cannot be retargeted or removed. Cell IDs, assignment, physical membership,
enrollment, placement provenance and original origin remain immutable. Every
binding and dependency remains **unverified**. Inventory/fluidbox indices and
electric network IDs are declarations, not native endpoint proof. Electrical
bindings do not represent heat. Native requirements and a fresh evidence-bound
bridge are separate work; no fuel item or category is invented by this API.

The change contains `transaction_id`, `cell_id`, `expected_registry_revision`,
`expected_cells`, `input_ports`, `port_bindings` and `dependencies`. Every involved
cell, including cell suppliers, needs its expected revision and metadata head
digest. Endpoints include the exact existing member locator and one typed
inventory, fluidbox or electric-network identifier. Host code derives dependency
IDs and revision-bound endpoint digests. Validation covers the complete candidate
graph before publication. A matching repeated transaction is idempotent; reusing
its ID with another payload faults the store. There are at most 64 revisions per
cell and 1,024 metadata transactions globally, with no eviction or ID reuse.

Legacy revision-one snapshots retain their shape. Their immutable anchor is
derived when the first revision is appended. Every later entry hashes its full
normalized metadata, immutable identity digest and previous digest; observation
caches are excluded. Restore validates the entire chain, dependency joins and
current projection. A live store also compares the complete previously accepted
prefix. A cold process cannot detect replacement of the entire file with an
older self-consistent snapshot without an external durable watermark; this stage
does not claim that protection.

The guarded bridge binds world, surface, force, actor/epoch, session, request,
goal, committed plan/step and registry revision, with fresh native idle checks.
It first persists the old registry plus a pending publication marker, then the
complete candidate plus that marker. The marker contains transaction/request
digests, the complete predecessor and request, and captured owner scope. The live
view changes only after the candidate write and ownership fences succeed. The
next ordinary settled canonical save clears the marker. Cold restore validates
and recomputes the candidate once from the recorded predecessor and request. An
exact predecessor file discards the uncommitted intent; an exact candidate file
retains already-written, unverified metadata, including a lost rename acknowledgement.
Neither result replays gameplay or restores the old publication capability.
Unknown markers, mismatched files, explicit faults and restore during live
publication still fail closed. Reconciliation clears historical observations
and emits `factory_metadata.reconciled`; the next canonical save persists the
normalized outcome. This idempotent normalization has no world-action retry or
allowance to renew across restarts. Once a candidate write is staged,
failure retains that candidate behind the fault instead of rolling its history
back. Failure of the initial prepare write has no live registry effect.

Canonical persistence captures the latest snapshot inside its serialized write
queue and compares the complete payload again before rename. Changed payloads
receive at most three fresh snapshot attempts; capability and skill-handoff
writes receive one. Exhaustion is visible even for ordinary non-strict callers.
Operator pause requires a strict durable save, reports `goal.pause_save_failed`
on failure, and resets only its unchanged owner. The supervisor still cancels
that owner's native work after a save failure, with generation, actor, epoch,
session and goal fences across awaits. Operator pause and replacement goal
writes remain possible while publication is pending and preserve its marker.
Required skill-handoff records are rechecked at the actual write boundary. No
filesystem scheme can promise a new durable fault when all writes fail; the
already persisted marker supplies the restart fence. The tests inject filesystem
boundaries through the actual persistence method; they do not certify filesystem
power-loss durability or multiple independent file writers.

This prerequisite does not authorize physical updates, retirement, temporary
asset cleanup, commissioning, verified supply, recovery allowances or E2E success.
Those remain part of the subsequent tracker stages.

The foundation includes world identity, stable cell IDs, immutable assignments,
exact member identities, declared input/output ports, dependency validation,
reverse consumer lookup and canonical-memory persistence. Guarded runtime
enrollment is separate from provider submissions. No model JSON operation writes
the registry.

Stage 1 ships the guarded runtime API and its persistence/admission integration.
Stage 2 connects bounded native observations and read-only registry tools to the
runtime. The first use can initialize persistent world-identity metadata, but
cannot create production assignments or mutate gameplay structures. Automatic
enrollment and model-facing cell declarations remain later work. Existing
unregistered hardware is not silently adopted or protected as an assigned cell.

Stage 3a adds durable placement provenance, a prerequisite for controlled
enrollment. The production post-batch path snapshots original pending admission
and committed plan ownership before reading native status, then retains an exact
completed placement receipt before retiring that pending admission. It does not
add cell intent to a committed plan or automatically register any cell.

This bounded capture accepts only one `place_entity` or `place_candidate`
operation, one native placing task, a fully completed protocol-2 admission and
matching terminal journal, last-completed batch and placement result. The native
result supplies the actual world UUID, force, surface, unit, position and active
batch identity. The world must already have a native UUID and matching host
binding; placement never creates a UUID. Unbound worlds, legacy placements,
mixed batches, partial/refused/cancelled work, missing evidence and stale owners
remain unavailable for enrollment. These exclusions do not reclassify known
native effects or change ordinary operation settlement.

Canonical memory keeps at most 512 immutable receipt records, with defensive
host-only lookup. Duplicate polling is idempotent. Capacity refuses a new record
without evicting earlier facts; conflicting identity, corrupt or rewritten
restore, and capture persistence failure disable lookup with a durable fault.
Assignments remain protected independently. Captured contexts expire on restore;
already retained evidence remains historical and never proves current native
identity, commissioning or throughput. A persistence failure retains the pending
reconciliation authority and reports known applied effects separately.

The guarded runtime uses this retained lookup by default. Tests or trusted host
integrations may still supply an explicit receipt callback; model arguments never
select it. Legacy adoption remains a separate, unimplemented protocol.

## Committed pair enrollment (stage 3b)

A new planner may declare one optional `cellIntent` in a deterministic step's
execution guidance: `kind: direct_feed`, one `product`, distinct `sourceEntity`
and `targetEntity` prototype names, and a bounded `purpose`. Its existing
`materialSupply` must explicitly select `direct_feed` and the resource. All names
are claims checked against native facts. No recipes, ratios, flow rates or supply
assumptions are stored in the declaration. Old committed plans receive no intent.
An explicitly corrupt restored intent remains a fault and cannot disappear.

Before accepting this draft, the runtime requires an already bound host world
identity and a fresh matching native identity. The planner can initialize this
through `listFactoryCells`. A declaration grants no gameplay authority: normal
task, stock, preservation and native admission still apply. Both machines must be
placed in separate single-placement admissions; mixed batches and compound
construction do not qualify. The shared pre-send boundary now obtains an exact
native surface for eligible UUID-bound placements, including intentless ones.
Earlier stage-3a helper/native fixtures supplied that field explicitly; they did
not prove the former ordinary caller supplied it.
The intent-bearing step admits placement only of its declared source and target;
place ancillary infrastructure in a separate step. Expected draft and pre-send
factory refusals keep their exact harness guard classification through request
failure and supervisor pause. They mark only the current batch as unsent, and
do not reclassify previous native effects or authorize automatic retries.

The shared step-close boundary runs enrollment after the ordinary checkpoint and
preservation checks, before completion authority. It selects exactly one retained
placement for each prototype from the same goal and semantic step. Original
placement-plan intent must match the current immutable intent. Another step's
machines, old generic placement lists, multiple matching receipts or a later
model label cannot establish membership. Configuration may be completed before
enrollment; registered members then receive the existing reconfiguration guards.

A provisional bounded native observation must prove current exact identities,
compatible mining products, receiver recipe inputs/output and direct output route.
The declared item output requires a native item product; a fluid with the same
name is a mismatch, and an absent native product type remains unknown.
Mismatch or unknown facts refuse enrollment without changing the intended job.
A copper declaration cannot become iron because the observed source produces iron.
The registry records the original job and output port, with an atomic enrollment
identity and the two original receipt IDs. Identical repeats and restart reuse the
same cell; changed members or jobs refuse. Persistence failure faults enrollment
and prevents close while preserving already applied native placements.

If the original goal becomes satisfied early, a wholly unbuilt optional cell
intent may become moot. Any retained member placement makes the accepted intent
an obligation to protect before automatic goal completion: a complete compatible
pair enrolls first, while a partial or unverifiable pair safely pauses with the
original goal proof retained. This does not authorize building extra machines,
cleanup or recovery merely to finish enrollment.

Assignments remain `unverified`. Compatibility and enrollment do not establish
commissioning, throughput or sustained automated output. Dependencies remain
unverified; an empty declared dependency list does not establish independence or
self-supply. No expansion, conversion, retirement, legacy adoption, automatic
gameplay correction or general BH repair is implemented by this slice.

Native commissioning, automatic enrollment, legacy adoption, cell expansion or
conversion, retirement, temporary-building cleanup and automatic gameplay
correction are later stages. These foundations are not evidence that the BH
autonomous failure has been repaired.

## Native observations and lookup

`listFactoryCells` lists bounded, paginated assignment summaries. An empty list
means that no cells have been registered; it does not mean the native world has no
machines. `inspectFactoryCell` reads exact members from the registry through the
native factory observation interface. The Pterodactyl runtime owns these host
tools; they do not pretend to be standalone native registry lookups.

The native query checks world, actor, surface, force, unit, prototype, position and
current visibility. Member, resource, product, inventory and connection lists have
finite limits with explicit truncation or unknown states. It returns actual
mining products, recipes and route facts where readable. Unsupported or hidden
facts cannot become negative absence evidence or successful compatibility proof.
Recipes, products and sizing are read from the native game rather than authored
ingredient lists or model memory.

Each exactly matched visible member also carries `burner_fuel_requirement`, a
fresh read of its native burner prototype. This field covers burner fuel only,
not all power, fluid or material requirements. Successful native absence is
`not_applicable` with `required: false`; an existing burner stays `required: true`
even when its known category set is empty. Unreadable or malformed prototype
reads are `unknown`, never absence. Categories are sorted true keys from the
native boolean dictionary. Software bounds of 32 dictionary entries and 160
characters per name return explicit unknown/truncated coverage when exceeded;
incomplete sets are not published as complete accepted categories. Supply,
delivery and external source remain `unverified` in every state. These scoped
facts do not add dependency edges, revise ports or assignments, prove automation,
or commission a cell. An omitted field in an older response is unknown, not
evidence that a requirement is absent.

The host compares these facts with immutable assigned products. An optional
direct-feed binding identifies exact source and receiver members; its resource
requirement comes from the committed active step's material-supply choice. Tool
arguments cannot replace that choice or waive a compatibility check. Resource
entity identity and produced item identity remain distinct, including modded
resource/product mappings.

Compatibility is not commissioning. Observed configuration and a direct output
route do not prove sustained output, a complete dependency graph, sufficient
capacity, or an automated supply. Dependency declarations stay unverified until a
later port/member verification protocol exists. Native belt and fluid projections
must be distinguished from fully verified transport behavior.

The native save retains a fixed world UUID. On first use, a trusted host generates
a candidate and asks the native metadata interface to bind it once. Existing
native identity is read on resume; a different identity is refused rather than
overwritten. World identity cannot be derived from seed, actor, goal or a model
argument. A host snapshot's conflicting identity fails closed.

Observations retain the original request/session/actor/epoch/goal/plan/step and
registry revision across awaits. Newer world work, busy or uncertain native work,
changed authority or restore invalidates the read. Native request/reply evidence
belongs to its original request even when later validation refuses publication.
Saved summaries are historical only: restore, revision changes and new sessions
require fresh native reads before validation. Observation updates cannot revise
assignments, advance a checkpoint or renew recovery allowances.

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

Finite-production enrollment selects exact receipts from the active step or the
verified completed prefix of the same immutable plan/version. The historical
placement facade validates original actor/epoch, goal, world, surface, force and
locator; current authority and fresh native recipe/output evidence independently
control registration. Both explicit finite producers and automatic producer
binding use this selection. This does not broaden declared or inferred direct-feed
pair membership, which remains scoped to its unchanged semantic step.

An already admitted finite task missing that registration is a residual miss.
After proving custody and native capability, the harness durably spends the
existing same-goal factory recovery allowance (three aggregate attempts) before
publishing metadata, then resolves factory use again and continues the ordinary
production controller. Restart and duplicate wakes cannot renew the allowance.
Unproven custody, uncertain/busy work, lost ownership, failed persistence and
exhaustion remain guard failures; no placement or supply operation is replayed by
the correction. `factory_cell.enrollment_recovery_started`, `_completed`, `_failed`
and `_exhausted` retain request/plan/step, source receipt, allowance and disposition.
A completed correction means fresh factory use resolved, not completed gameplay.
Factory boundary errors retain their guard code through recovery-route commit;
they are not provider failures.

A registered finite furnace may clear its active recipe after a completed cycle
while its result slot still holds output. Continuation and exact collection can
reconcile that dormant state only against the existing immutable native-recipe
assignment, exact member, fresh enabled native recipe/capability, complete empty
input, zero progress and complete output containing only that recipe's assigned
products. Native `recipe.state = none` remains unchanged. This is an ephemeral
finite-job capability, not active production, delivery or commissioning proof;
new unselected-furnace enrollment remains empty-only and direct-feed/operating
checkpoints retain their stronger evidence requirements. The named
`factory_cell.dormant_output_recipe_evidence` trace records the actual output and
native recipe state separately from the expected recipe.


Registered destructive or reconfiguration operations require the exact frozen
physical lifecycle transaction at the existing admission boundary. Ordinary
operations still pass through existing authority, stock, preservation and native
preflight checks. An unchanged assignment is not permission to bypass those checks.
Natural area clearing independently excludes placed buildings in the native
implementation. Compound construction is placement-only with clearance refused;
the registry does not claim to validate a complete new construction design.

## Physical update invariants

Keep a stable cell ID for expansion or modification that preserves its job. The
change protocol must retain immutable revisions, compare expected revision,
record exact affected assets and consumers, and reconcile every partial native
effect. A failed modification cannot publish a new verified revision. An
interrupted old installation must be reported as degraded rather than advertised
as still producing.

Changing the job requires explicit conversion and lineage. Retirement requires
consumer migration or explicit cessation, safe contents handling and native
removal receipts. Temporary assets require beneficiaries and removal conditions.
The metadata API cannot grant those transitions or erase their obligations.

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
