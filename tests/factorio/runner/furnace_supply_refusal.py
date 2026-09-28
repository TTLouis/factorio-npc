"""Real-Factorio regression: one refused furnace supply must not cancel its siblings.

Steam-power run 2026-09-26 (docs/validation/E2E_STEAM_POWER_2026-09-26.md,
regressions 1 and 2): a supply batch to three furnaces failed on its first move
with a bare ``nothing_moved`` and the mod cancelled all six moves.

Fixed layout, deterministic assertions:

* three stone furnaces in reach of the NPC; furnace C (supplied first) holds a
  foreign item (copper ore) in its source slot;
* one batch: ``supply_entity`` C, A and B with iron ore and coal each;
* A and B receive their ore and coal, C receives its coal, and C's iron-ore
  move is refused with a concrete cause in the receipt (held count, target
  inventory contents), not a bare ``nothing_moved``;
* no iron ore ever lands in a furnace result (output) slot, including when a
  supply asks for more ore than the source slot can hold.

Fixture notes: the world (furnaces, the foreign copper ore, the NPC's starting
items) is created by script, as in the other core gates. The moves under test
run only through the mod's public ``supply_entity`` operation. The furnaces are
``disabled_by_script`` so smelting does not consume ore while the runner reads
their inventories; insertion is unaffected by that flag.
"""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json
from runtime import operation_status_command, wait_until_idle


ORE_PER_FURNACE = 20
COAL_PER_FURNACE = 5
FOREIGN_ITEM = 'copper-ore'
FOREIGN_COUNT = 10
SEED_IRON_ORE = 160
SEED_COAL = 15
OVERSUPPLY_ORE = 95
OUTPUT_INVENTORY_NAMES = {'furnace_result', 'crafter_output', 'assembling_machine_output'}
# Factorio 2.0 names a furnace's source slot crafter_input (1.1: furnace_source).
INPUT_INVENTORY_NAMES = {'furnace_source', 'crafter_input'}


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def inventory_count(furnace: dict, inventory_name: str, item_name: str) -> int:
    total = 0
    for inventory in furnace.get('inventories') or []:
        if inventory.get('name') != inventory_name:
            continue
        for item in inventory.get('contents') or []:
            if item.get('name') == item_name:
                total += int(item.get('count') or 0)
    return total


def output_count(furnace: dict, item_name: str) -> int:
    return sum(inventory_count(furnace, name, item_name) for name in OUTPUT_INVENTORY_NAMES)


def input_count(furnace: dict, item_name: str) -> int:
    return sum(inventory_count(furnace, name, item_name) for name in INPUT_INVENTORY_NAMES)


def refused_batch_problems(status: dict, *, refused_unit: int, sibling_units: list[int], held_before: int) -> list[str]:
    """Check the batch/receipt contract for one refused move among independent siblings."""
    problems: list[str] = []
    if status.get('task_state') != 'idle' or status.get('queue_length') != 0:
        problems.append('batch did not drain')

    batch = status.get('last_cancelled_batch') or {}
    if batch.get('outcome') != 'refused':
        problems.append(f"failed batch outcome is {batch.get('outcome')!r}, expected 'refused'")
    if batch.get('task_count') != 2 * (1 + len(sibling_units)):
        problems.append(f"batch task_count is {batch.get('task_count')!r}")
    if batch.get('refused_count') != 1:
        problems.append(f"refused_count is {batch.get('refused_count')!r}, expected 1")
    if batch.get('completed_count') != 2 * (1 + len(sibling_units)) - 1:
        problems.append(f"completed_count is {batch.get('completed_count')!r}")
    reason = batch.get('reason') or ''
    if not reason.startswith('moving_items:nothing_moved:input_slot_holds_other_item'):
        problems.append(f'batch reason does not name the cause: {reason!r}')
    refusals = batch.get('refusals') or []
    if len(refusals) != 1 or refusals[0].get('target_unit_number') != refused_unit:
        problems.append(f'batch refusals do not name the refused move: {refusals!r}')

    result = (status.get('basic_operation') or {}).get('last_result') or {}
    expected = {
        'type': 'moving_items',
        'accepted': False,
        'completed': False,
        'code': 'nothing_moved',
        'target_unit_number': refused_unit,
        'item_name': 'iron-ore',
        'moved_count': 0,
        'requested_count': ORE_PER_FURNACE,
        'to_entity': True,
        'held_count': held_before,
        'refusal_cause': 'input_slot_holds_other_item',
    }
    for key, value in expected.items():
        if result.get(key) != value:
            problems.append(f'receipt {key} is {result.get(key)!r}, expected {value!r}')
    if result.get('tick') != batch.get('tick'):
        problems.append('receipt is not published at the batch-close tick')
    if not isinstance(result.get('refusal_tick'), int):
        problems.append('receipt lacks refusal_tick')

    inventories = result.get('target_inventories') or []
    source = next((inv for inv in inventories if inv.get('role') == 'input'), None)
    if source is None:
        problems.append(f'receipt has no input inventory snapshot: {inventories!r}')
    else:
        contents = {item.get('name'): item.get('count') for item in source.get('contents') or []}
        if contents.get(FOREIGN_ITEM) != FOREIGN_COUNT:
            problems.append(f'input slot contents do not show the foreign item: {source!r}')
        if source.get('empty_slots') != 0:
            problems.append(f'input slot is not reported full: {source!r}')
    if any(inv.get('role') == 'output' and inv.get('can_insert') for inv in inventories):
        problems.append('an output inventory is reported as an insert target')
    return problems


FIXTURE_LUA = r"""
local s=game.surfaces[1]; local a=nil
for _,e in pairs(s.find_entities_filtered{name='character'}) do if e.unit_number==__ACTOR__ then a=e end end
assert(a)
remote.call('autorio_operations','cancel_all_tasks')
local inv=a.get_main_inventory(); inv.clear()
local p=a.position
for _,e in pairs(s.find_entities_filtered{position=p,radius=10}) do if e~=a then e.destroy() end end
local tiles={}
for dx=-10,10 do for dy=-10,10 do tiles[#tiles+1]={name='landfill',position={x=math.floor(p.x)+dx,y=math.floor(p.y)+dy}} end end
s.set_tiles(tiles,true,false,true)
local fx=math.floor(p.x)+3; local fy=math.floor(p.y)
local function furnace(dy)
  local f=s.create_entity{name='stone-furnace',position={x=fx,y=fy+dy},force=a.force}
  assert(f)
  f.disabled_by_script=true
  return f
end
local c=furnace(-3); local fa=furnace(0); local fb=furnace(3)
local source=c.get_inventory(defines.inventory.furnace_source)
local foreign=source.insert{name='__FOREIGN__',count=__FOREIGN_COUNT__}
local chest=s.create_entity{name='wooden-chest',position={x=math.floor(p.x)-3,y=fy},force=a.force}
local iron=inv.insert{name='iron-ore',count=__SEED_IRON__}
local coal=inv.insert{name='coal',count=__SEED_COAL__}
local function probe(e)
  local out=e.get_output_inventory(); local fuel=e.get_fuel_inventory(); local burnt=e.get_burnt_result_inventory()
  local rows={}
  for i=1,e.get_max_inventory_index() do
    local x=e.get_inventory(i)
    if x then
      rows[#rows+1]={index=i,name=x.name,slots=#x,
        can_insert_iron=x.can_insert{name='iron-ore'},insertable_iron=x.get_insertable_count('iron-ore'),
        can_insert_coal=x.can_insert{name='coal'},insertable_coal=x.get_insertable_count('coal'),
        contents=x.get_contents()}
    end
  end
  return {unit_number=e.unit_number,type=e.type,output_index=out and out.index or nil,output_name=out and out.name or nil,
    fuel_index=fuel and fuel.index or nil,burnt_result_index=burnt and burnt.index or nil,inventories=rows}
end
local chest_ok,chest_probe=false,'no chest'
if chest then chest_ok,chest_probe=pcall(probe,chest) end
rcon.print(helpers.table_to_json({actor_id=a.unit_number,c=c.unit_number,a=fa.unit_number,b=fb.unit_number,
  foreign=foreign,iron=iron,coal=coal,
  probe={empty_furnace=probe(fa),foreign_furnace=probe(c),chest=chest_ok and chest_probe or {error=tostring(chest_probe)}}}))
"""

WORLD_LUA = r"""
local s=game.surfaces[1]; local a=nil
for _,e in pairs(s.find_entities_filtered{name='character'}) do if e.unit_number==__ACTOR__ then a=e end end
assert(a)
local furnaces={}
for _,e in pairs(s.find_entities_filtered{name='stone-furnace',position=a.position,radius=12}) do furnaces[e.unit_number]=e end
local function furnace(unit)
  local e=furnaces[unit]; assert(e and e.valid)
  local rows={}
  for i=1,e.get_max_inventory_index() do
    local x=e.get_inventory(i)
    if x then rows[#rows+1]={index=i,name=x.name,insertable_iron=x.get_insertable_count('iron-ore'),contents=x.get_contents()} end
  end
  return {unit_number=unit,inventories=rows}
end
rcon.print(helpers.table_to_json({actor={iron_ore=a.get_item_count('iron-ore'),coal=a.get_item_count('coal')},
  c=furnace(__C__),a=furnace(__A__),b=furnace(__B__)}))
"""


def supply_call(unit: int, ore: int, coal: int | None) -> str:
    items = f"{{item_name='iron-ore',count={ore}}}"
    if coal is not None:
        items += f",{{item_name='coal',count={coal}}}"
    return f"remote.call('autorio_operations','supply_entity',{unit},{{{items}}})"


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    record: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id}
    started = time.monotonic()

    def save() -> None:
        (results / 'furnace-supply-refusal.json').write_text(json.dumps({**record, 'transcript': transcript}, indent=2))

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
        save()
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def lua(template: str, **values: object) -> str:
        text = template
        for key, value in values.items():
            text = text.replace(f'__{key}__', str(value))
        return '/silent-command ' + ' '.join(line.strip() for line in text.strip().splitlines())

    fixture = json_command(lua(
        FIXTURE_LUA,
        ACTOR=actor_id,
        FOREIGN=FOREIGN_ITEM,
        FOREIGN_COUNT=FOREIGN_COUNT,
        SEED_IRON=SEED_IRON_ORE,
        SEED_COAL=SEED_COAL,
    ), 'three-furnace fixture')
    record['fixture'] = fixture
    save()
    require(fixture.get('actor_id') == actor_id, fixture)
    require(fixture.get('foreign') == FOREIGN_COUNT, fixture)
    require(fixture.get('iron') == SEED_IRON_ORE and fixture.get('coal') == SEED_COAL, fixture)
    unit_c, unit_a, unit_b = fixture['c'], fixture['a'], fixture['b']

    # Observe the furnaces through the mod's observation tool first, as the
    # planner does: exact-unit transfers resolve identities it has observed
    # (stone furnaces are not indexed by game.get_entity_by_unit_number).
    observed = json_command(
        "/silent-command rcon.print(helpers.table_to_json("
        "remote.call('autorio_tools','get_nearby_entities',12,'stone-furnace')))",
        'observe fixture furnaces',
    )
    observed_units = {entity.get('unit_number') for entity in observed.get('entities') or []}
    record['observed_units'] = sorted(unit for unit in observed_units if isinstance(unit, int))
    save()
    require({unit_c, unit_a, unit_b}.issubset(observed_units), observed)

    def world(context: str) -> dict:
        return json_command(lua(WORLD_LUA, ACTOR=actor_id, C=unit_c, A=unit_a, B=unit_b), context)

    # One batch: the refused target first, as in the live run.
    admission = json_command(
        '/silent-command '
        f'local c={supply_call(unit_c, ORE_PER_FURNACE, COAL_PER_FURNACE)}; '
        f'local a={supply_call(unit_a, ORE_PER_FURNACE, COAL_PER_FURNACE)}; '
        f'local b={supply_call(unit_b, ORE_PER_FURNACE, COAL_PER_FURNACE)}; '
        'rcon.print(helpers.table_to_json({c=c,a=a,b=b}))',
        'three-furnace supply admission',
    )
    record['admission'] = admission
    save()
    for key in ('c', 'a', 'b'):
        require(isinstance(admission.get(key), list) and admission[key][0] is True, admission)

    batch_status = wait_until_idle(operation_status, 'three-furnace supply batch', 20.0)
    after_batch = world('world after three-furnace batch')
    record['batch_status'] = batch_status
    record['after_batch'] = after_batch
    save()

    # Over-supply the clean furnace A: only the free source capacity may move,
    # and nothing may land in the result (output) slot.
    source_free = next(
        (inv.get('insertable_iron') for inv in after_batch['a']['inventories'] if inv.get('name') in INPUT_INVENTORY_NAMES),
        None,
    )
    oversupply_admission = json_command(
        f'/silent-command rcon.print(helpers.table_to_json({supply_call(unit_a, OVERSUPPLY_ORE, None)}))',
        'furnace over-supply admission',
    )
    oversupply_status = wait_until_idle(operation_status, 'furnace over-supply', 20.0)
    after_oversupply = world('world after furnace over-supply')
    record['oversupply'] = {
        'source_free_before': source_free,
        'admission': oversupply_admission,
        'status': oversupply_status,
        'after': after_oversupply,
    }
    save()

    # Assertions (after every observation has been recorded for diagnosis).
    problems = refused_batch_problems(
        batch_status,
        refused_unit=unit_c,
        sibling_units=[unit_a, unit_b],
        held_before=SEED_IRON_ORE,
    )
    for name, unit in (('a', unit_a), ('b', unit_b)):
        furnace = after_batch[name]
        if input_count(furnace, 'iron-ore') != ORE_PER_FURNACE:
            problems.append(f'sibling furnace {unit} did not receive its {ORE_PER_FURNACE} iron ore: {furnace!r}')
        if inventory_count(furnace, 'fuel', 'coal') != COAL_PER_FURNACE:
            problems.append(f'sibling furnace {unit} did not receive its {COAL_PER_FURNACE} coal: {furnace!r}')
    furnace_c = after_batch['c']
    if input_count(furnace_c, FOREIGN_ITEM) != FOREIGN_COUNT:
        problems.append(f'refused furnace lost its foreign item: {furnace_c!r}')
    if input_count(furnace_c, 'iron-ore') != 0:
        problems.append(f'refused furnace has iron ore in its source: {furnace_c!r}')
    if inventory_count(furnace_c, 'fuel', 'coal') != COAL_PER_FURNACE:
        problems.append(f'refused furnace did not receive its independent coal move: {furnace_c!r}')
    for name in ('a', 'b', 'c'):
        if output_count(after_batch[name], 'iron-ore') != 0:
            problems.append(f'iron ore landed in the output slot of furnace {name}: {after_batch[name]!r}')
    actor = after_batch['actor']
    if actor.get('iron_ore') != SEED_IRON_ORE - 2 * ORE_PER_FURNACE:
        problems.append(f'actor iron ore after batch is {actor!r}')
    if actor.get('coal') != SEED_COAL - 3 * COAL_PER_FURNACE:
        problems.append(f'actor coal after batch is {actor!r}')

    # Measured on Factorio 2.0.77: a script insert into a furnace's
    # crafter_input may overfill the slot past one stack (20 + 50 -> 70 iron
    # ore) although get_insertable_count reported 30. So the moved count is
    # checked against what actually changed hands, not a stack-size estimate.
    oversupply_result = (oversupply_status.get('basic_operation') or {}).get('last_result') or {}
    held_before_oversupply = SEED_IRON_ORE - 2 * ORE_PER_FURNACE
    moved = oversupply_result.get('moved_count')
    input_gain = input_count(after_oversupply['a'], 'iron-ore') - input_count(after_batch['a'], 'iron-ore')
    actor_loss = held_before_oversupply - int(after_oversupply['actor'].get('iron_ore') or 0)
    record['oversupply']['measured'] = {'moved_count': moved, 'input_gain': input_gain, 'actor_loss': actor_loss}
    if oversupply_result.get('code') != 'completed' or not isinstance(moved, int) or moved <= 0:
        problems.append(f'over-supply did not complete with a positive move: {oversupply_result!r}')
    elif moved != input_gain or moved != actor_loss:
        problems.append(f'over-supply moved_count {moved} does not match the input slot gain {input_gain} and NPC loss {actor_loss}')
    if oversupply_result.get('held_count') != held_before_oversupply:
        problems.append(f'over-supply receipt held_count is {oversupply_result.get("held_count")!r}')
    if output_count(after_oversupply['a'], 'iron-ore') != 0:
        problems.append(f'over-supply put iron ore into the furnace result slot: {after_oversupply["a"]!r}')

    record['problems'] = problems
    save()
    require(not problems, {'problems': problems})

    record['status'] = 'pass'
    save()
    print(
        'PASS: one refused furnace supply (foreign item in the source slot) reported '
        f"cause={batch_status['basic_operation']['last_result'].get('refusal_cause')} with held count and slot contents, "
        'its independent sibling moves still ran, and no ore reached a furnace result slot',
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'furnace-supply-refusal-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
