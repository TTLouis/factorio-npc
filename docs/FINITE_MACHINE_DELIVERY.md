# Finite machine output in an exact chest

`machine_output_delivered` is a finite native acceptance condition. It does not
prove sustained automation or require a transport layout. Manual input and fuel
feeding are permitted. The target item and minimum come from the owner's goal;
recipe products and yields come only from the running engine.

After any declared starter grant and before inference or construction, the trusted host calls
`armMachineDeliveryCommand({acceptance_key, item_name, minimum,
producer_type: 'furnace'})` from
`deploy/pterodactyl/runtime-v8/machine-delivery.mjs`. The acceptance key is the
actual plan goal ID, or the fixed external/pursuit goal key. Arming captures the
authorized actor, epoch, session, force and surface, a bounded complete census
of existing target stock, and native production counters. A repeated identical
arm cannot reset the baseline. Unsupported census coverage refuses arming.

The model selects a destination with the metadata-only `bindMachineDelivery`
tool (`{unit_number}`); the trusted host adds the acceptance key. Alternatively,
its first successful exact target-item deposit into an eligible new chest binds
that chest. The native placement must have a matching admitted operation/batch
identity after arming. Selection is immutable: the evaluator never searches for
a convenient matching chest. Explicit selection also supports automated output.

The native module observes newly actor-placed furnaces each tick. It derives
target yields from live recipes and native completed-craft counters, retaining
the last live recipe witness when a furnace clears its recipe after its final
craft. Unobserved recipe transitions or variable/probabilistic yields fail
closed. Global native target production must agree with the observed furnace
output. Target hand crafting/mining invalidates this strict proof; manual
feeding of other items and fuel does not. Existing target stock is subtracted
in full from the exact chest's contents, so stock substitution cannot count as
newly produced output. Aliased baseline inventories may overcount excluded stock;
the destination is read once through its exact chest inventory.

Plan definitions use `{kind:'machine_output_delivered', item_name, minimum}`.
The trusted host precommits this exact owner condition in the immutable plan
goal definition before the first inference, using the same goal ID as arming;
arming alone does not replace a model-authored generic completion condition.
The existing plan evaluator supplies the goal ID. External and pursuit hosts
use `evaluateMachineDelivery(spec, command)` to read the same native condition.
On the external main host, `bindMachineDelivery` is an actual public MCP tool
with exactly `{unit_number}`. It runs through the serialized runtime and
`NativeBridge`, with ownership snapshots and an atomic native session/actor/epoch
fence. The fixed `autorio_tools.bind_current_machine_delivery` endpoint supplies
the already armed window's immutable key; the model cannot choose a key, arm or
reset a window. This metadata write is separate from world operations and
observations, is never observation-cached, and grants no execution or completion
authority. Repeating the same binding is idempotent; selecting a different chest
is refused. The shared spec validators, command renderers and evaluator remain
unchanged. Main does not import the built-in plan's binding dispatcher, notebook
budgets or typed `Session` owner-intake lifecycle.
No host may replace its result with inventory totals, a model claim or a wrapper
exit. Preserve the returned native evidence before cancellation changes the
authorized epoch. Actor/epoch/world changes, missing evidence and unbound or
removed destinations remain unsatisfied. State persists with the save.

The initial contract supports one armed goal per isolated save. A different
key or target cannot replace it, even after stop or reload; this deliberately
provides no model- or host-accessible baseline reset. A later multi-goal lifecycle
requires a separately reviewed retirement contract.
