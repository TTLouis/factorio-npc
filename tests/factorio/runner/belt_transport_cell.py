#!/usr/bin/env python3
"""A1 harness proof for belt/inserter production transport (roadmap B2 transport half).

AUTONOMY RUNG: A1 (`docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` section 2).

    The exact layout below is a TEST-ONLY HARNESS FIXTURE, exactly like
    powered_assembler_cell.py. It proves harness and game mechanics only. It is
    NOT a blueprint library and MUST NEVER reach the model through prompts,
    observations, retrieval or A2/A3 context (roadmap section 2.1).

Scope note: roadmap B2 is a belt-FED ASSEMBLER. The assembler half of B2 is
currently blocked by the runtime defect that makes
autorio_operations.set_machine_recipe fatal (see powered_assembler_cell.py).
This gate therefore proves the transport half on its own:

    source chest -> inserter -> transport belt run -> inserter -> destination chest

What is proven against real Factorio through authoritative game state:

    BUILT       belts and inserters exist at the exact positions/directions
    CONNECTED   belt_neighbours form one continuous downstream chain, the
                inserters pick up and drop on the intended tiles, and every
                powered entity shares one electric network
    OPERATING   inserters are powered and never report no_power
    MOVING      items are observed riding the belt, and the destination chest
                inventory rises while the source inventory falls
    MEASURED    the planning tools read the running line through the engine:
                live belt-lane and inserter throughput measurements complete
                with items counted, and factory area analysis reads every cell
                entity in its factory-graph scope (all but the solar panels,
                which have no item or fluid transfers) and their transfer
                relations (these tools crashed in the
                engine on untyped generated Lua; see
                docs/validation/AUTORIO_GENERATED_LUA_ENGINE_DEFECTS_2026-09-25.md)

Placement-only success is explicitly NOT accepted as a pass.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


ITEM = 'iron-plate'
SOURCE_ITEMS = 30
TARGET_TRANSPORTED = 20
ROUND_TICKS = 300
ROUNDS = 12
MEASURE_WARMUP_TICKS = 60
MEASURE_WINDOW_TICKS = 600
MEASURED_BELT = 'belt_3'

# Factorio 2.0 direction constants. A transport belt moves items toward its
# `direction`; an inserter's `direction` points at the tile it picks up from.
EAST = 4
WEST = 12

BELT_KEYS = ['belt_1', 'belt_2', 'belt_3', 'belt_4']

# A1 harness fixture layout. Tile offsets from the cleared build origin.
# Test-only coordinates; never a reusable AIRI blueprint (roadmap section 9).
CELL = [
    {'key': 'source_chest', 'name': 'wooden-chest', 'dx': -6, 'dy': 0, 'direction': None},
    {'key': 'source_inserter', 'name': 'inserter', 'dx': -5, 'dy': 0, 'direction': WEST},
    {'key': 'belt_1', 'name': 'transport-belt', 'dx': -4, 'dy': 0, 'direction': EAST},
    {'key': 'belt_2', 'name': 'transport-belt', 'dx': -3, 'dy': 0, 'direction': EAST},
    {'key': 'belt_3', 'name': 'transport-belt', 'dx': -2, 'dy': 0, 'direction': EAST},
    {'key': 'belt_4', 'name': 'transport-belt', 'dx': -1, 'dy': 0, 'direction': EAST},
    {'key': 'destination_inserter', 'name': 'inserter', 'dx': 0, 'dy': 0, 'direction': WEST},
    {'key': 'destination_chest', 'name': 'wooden-chest', 'dx': 1, 'dy': 0, 'direction': None},
    {'key': 'pole', 'name': 'medium-electric-pole', 'dx': -2, 'dy': 2, 'direction': None},
    {'key': 'solar_a', 'name': 'solar-panel', 'dx': -4, 'dy': 5, 'direction': None},
    {'key': 'solar_b', 'name': 'solar-panel', 'dx': -1, 'dy': 5, 'direction': None},
]

ACTOR_STANCE = (-2, -3)

CONSTRUCTION_ITEMS = [
    ('wooden-chest', 2),
    ('inserter', 2),
    ('transport-belt', 4),
    ('medium-electric-pole', 1),
    ('solar-panel', 2),
    (ITEM, SOURCE_ITEMS),
]

POWERED_KEYS = ['source_inserter', 'destination_inserter', 'pole', 'solar_a', 'solar_b']


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def close_enough(a: float, b: float) -> bool:
    return abs(float(a) - float(b)) < 1e-6


def tile_of(position: dict) -> tuple[int, int]:
    return (int(math.floor(float(position['x']))), int(math.floor(float(position['y']))))


def cell_probe_command(specs: dict[str, dict]) -> str:
    # Authoritative world read. Identity is confirmed through the exact
    # unit_number; the positional lookup is a fallback index because
    # game.get_entity_by_unit_number() does not resolve entities the NPC has
    # just created (recorded per probe as `unit_number_index`).
    rendered = ','.join(
        "{{k='{key}',id={id},n='{name}',x={x},y={y}}}".format(
            key=key, id=spec['unit'], name=spec['name'], x=spec['x'], y=spec['y'])
        for key, spec in specs.items()
    )
    return (
        '/silent-command local s=game.surfaces[1]; local specs={' + rendered + '}; '
        'local out={}; local idx={}; '
        'for _,sp in pairs(specs) do local e=game.get_entity_by_unit_number(sp.id); '
        'local direct=e~=nil and e.valid; idx[sp.k]=direct; '
        'if not direct then e=nil; '
        'for _,c in pairs(s.find_entities_filtered{position={sp.x,sp.y},radius=0.2,name=sp.n}) do '
        'if c.valid and c.unit_number==sp.id then e=c end end end; '
        'local k=sp.k; '
        'if e and e.valid then '
        'local d={name=e.name,type=e.type,x=e.position.x,y=e.position.y,direction=e.direction,unit_number=e.unit_number}; '
        "if e.type=='inserter' or e.type=='solar-panel' or e.type=='electric-pole' then "
        'd.network=e.electric_network_id; d.status=e.status; '
        'for n,v in pairs(defines.entity_status) do if v==e.status then d.status_name=n end end; end; '
        "if e.type=='inserter' then d.pickup={x=e.pickup_position.x,y=e.pickup_position.y}; "
        'd.drop={x=e.drop_position.x,y=e.drop_position.y}; d.energy=e.energy; '
        'd.held=e.held_stack.valid_for_read and e.held_stack.name or nil; end; '
        "if e.type=='transport-belt' then local bn=e.belt_neighbours; d.outputs={}; d.inputs={}; "
        'for _,n in pairs(bn.outputs or {}) do d.outputs[#d.outputs+1]=n.unit_number end; '
        'for _,n in pairs(bn.inputs or {}) do d.inputs[#d.inputs+1]=n.unit_number end; '
        'd.line_items=e.get_transport_line(1).get_item_count()+e.get_transport_line(2).get_item_count(); end; '
        "if e.type=='container' then d.items=e.get_item_count('" + ITEM + "'); end; "
        'out[k]=d; end; end; '
        'rcon.print(helpers.table_to_json({cell=out,unit_number_index=idx,'
        'tick=game.tick,speed=game.speed}))'
    )


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'rung': 'A1', 'scenario': 'B2-transport'}

    def flush() -> None:
        evidence['transcript'] = transcript
        (results / 'belt-transport-cell.json').write_text(json.dumps(evidence, indent=2))

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({
            'elapsed_seconds': round(time.monotonic() - started, 3),
            'command': text,
            'response': response,
        })
        flush()
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def operation_admission(expression: str, context: str) -> dict:
        return json_command(
            '/silent-command local result=' + expression + '; '
            'local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            'else accepted=result==true end; '
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))',
            f'{context} admission',
        )

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        admission = operation_admission(expression, context)
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        status = wait_until_idle(operation_status, context, timeout)
        return (status.get('basic_operation') or {}).get('last_result') or {}

    # ---- fixture ---------------------------------------------------------
    inserts = ' '.join(f"inv.insert{{name='{name}',count={count}}};" for name, count in CONSTRUCTION_ITEMS)
    counts = ','.join(f"{name.replace('-', '_')}=a.get_item_count('{name}')" for name, _ in CONSTRUCTION_ITEMS)
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-12,oy-8},{ox+10,oy+10}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-12,ox+10 do for y=oy-8,oy+10 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        'local inv=a.get_main_inventory(); inv.clear(); ' + inserts + ' '
        f'a.teleport({{ox+({ACTOR_STANCE[0]})+0.5,oy+({ACTOR_STANCE[1]})+0.5}}); '
        'game.speed=4; '
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,force=a.force.name,'
        'position=a.position,speed=game.speed,counts={' + counts + '}}))',
        'belt transport cell fixture',
    )
    ox = fixture.get('ox')
    oy = fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    for name, count in CONSTRUCTION_ITEMS:
        require(fixture['counts'][name.replace('-', '_')] == count, fixture)
    evidence['fixture'] = fixture
    evidence['origin'] = {'x': ox, 'y': oy}
    flush()

    def expected_position(spec: dict) -> dict[str, float]:
        return {'x': ox + spec['dx'] + 0.5, 'y': oy + spec['dy'] + 0.5}

    # ---- BUILT -----------------------------------------------------------
    unit_numbers: dict[str, int] = {}
    receipts: dict[str, dict] = {}
    for spec in CELL:
        target = expected_position(spec)
        direction = spec['direction']
        args = [repr(spec['name']), repr(target['x']), repr(target['y'])]
        if direction is not None:
            args.append(str(direction))
        receipt = run_operation(
            remote_call('autorio_operations', 'place_entity', *args),
            f"place {spec['key']} ({spec['name']})",
            20.0,
        )
        require(receipt.get('completed') is True and receipt.get('code') == 'completed', {
            'message': 'exact placement did not complete',
            'key': spec['key'], 'expected_position': target, 'receipt': receipt,
        })
        placed = receipt.get('placed_position') or {}
        require(close_enough(placed.get('x', 1e9), target['x']) and close_enough(placed.get('y', 1e9), target['y']), {
            'message': 'entity was not placed at the exact requested position',
            'key': spec['key'], 'expected_position': target, 'receipt': receipt,
        })
        require(receipt.get('placed_direction') == (direction or 0), {
            'message': 'entity was not placed with the exact requested direction',
            'key': spec['key'], 'expected_direction': direction or 0, 'receipt': receipt,
        })
        unit = receipt.get('placed_unit_number')
        require(isinstance(unit, int) and unit > 0, receipt)
        unit_numbers[spec['key']] = unit
        receipts[spec['key']] = receipt
        evidence['placement_receipts'] = receipts
        evidence['unit_numbers'] = unit_numbers
        flush()

    probe_specs = {
        spec['key']: {
            'unit': unit_numbers[spec['key']],
            'name': spec['name'],
            'x': expected_position(spec)['x'],
            'y': expected_position(spec)['y'],
        }
        for spec in CELL
    }
    probe_command = cell_probe_command(probe_specs)

    def probe(context: str) -> dict:
        observed = json_command(probe_command, context)
        cell = observed.get('cell') or {}
        require(len(cell) == len(CELL), {'message': 'cell entity missing from world', 'observed': observed})
        return observed

    built = probe('belt cell built state')
    evidence['built'] = built
    flush()
    for spec in CELL:
        entity = built['cell'][spec['key']]
        target = expected_position(spec)
        require(entity['name'] == spec['name'], {'key': spec['key'], 'entity': entity})
        require(close_enough(entity['x'], target['x']) and close_enough(entity['y'], target['y']), {
            'message': 'authoritative game state disagrees with the requested position',
            'key': spec['key'], 'expected': target, 'entity': entity,
        })
        require(entity.get('direction', 0) == (spec['direction'] or 0), {
            'message': 'authoritative game state disagrees with the requested direction',
            'key': spec['key'], 'entity': entity,
        })
    print(f'PASS: BUILT - {len(CELL)} transport entities exist at the exact requested positions/directions', flush=True)

    # ---- CONNECTED: belt continuity --------------------------------------
    continuity = []
    for index in range(len(BELT_KEYS) - 1):
        upstream = built['cell'][BELT_KEYS[index]]
        downstream_unit = unit_numbers[BELT_KEYS[index + 1]]
        continuity.append({
            'from': BELT_KEYS[index], 'to': BELT_KEYS[index + 1],
            'outputs': upstream.get('outputs'), 'expected': downstream_unit,
        })
        require(downstream_unit in (upstream.get('outputs') or []), {
            'message': 'belt run is not continuous downstream',
            'edge': continuity[-1], 'upstream': upstream,
        })
    evidence['belt_continuity'] = continuity
    flush()
    print(f'PASS: CONNECTED - {len(BELT_KEYS)} belts form one continuous downstream run', flush=True)

    # ---- CONNECTED: inserter geometry ------------------------------------
    geometry = {
        'source_inserter': {'pickup': (ox - 6, oy), 'drop': (ox - 4, oy)},
        'destination_inserter': {'pickup': (ox - 1, oy), 'drop': (ox + 1, oy)},
    }
    observed_geometry = {}
    for key, expected in geometry.items():
        entity = built['cell'][key]
        pickup_tile = tile_of(entity['pickup'])
        drop_tile = tile_of(entity['drop'])
        observed_geometry[key] = {'pickup_tile': pickup_tile, 'drop_tile': drop_tile, 'entity': entity}
        require(pickup_tile == expected['pickup'], {
            'message': 'inserter pickup geometry does not reach the intended source tile',
            'key': key, 'expected_pickup_tile': expected['pickup'], 'observed': observed_geometry[key],
        })
        require(drop_tile == expected['drop'], {
            'message': 'inserter drop geometry does not reach the intended destination tile',
            'key': key, 'expected_drop_tile': expected['drop'], 'observed': observed_geometry[key],
        })
    evidence['geometry'] = observed_geometry
    flush()
    print('PASS: CONNECTED - both inserters bridge chest <-> belt on the intended tiles', flush=True)

    # ---- CONNECTED: one electric network ---------------------------------
    networks = {key: built['cell'][key].get('network') for key in POWERED_KEYS}
    evidence['networks'] = networks
    flush()
    require(all(isinstance(value, int) for value in networks.values()), {
        'message': 'a powered entity is not attached to any electric network', 'networks': networks,
    })
    require(len(set(networks.values())) == 1, {
        'message': 'power source and inserters are on different electric networks', 'networks': networks,
    })
    print(f'PASS: CONNECTED - inserters and power source share electric network {list(networks.values())[0]}', flush=True)

    # Observation step: populates the runtime entity-reference hints that exact
    # operations resolve through, because game.get_entity_by_unit_number() does
    # not resolve freshly placed entities in this runtime.
    observation = json_command(
        lua_json(remote_call('autorio_tools', 'get_nearby_entities', '20')),
        'observe the constructed transport line',
    )
    observed_units = {
        entity.get('unit_number')
        for entity in (observation.get('entities') or [])
        if isinstance(entity.get('unit_number'), int)
    }
    missing = {key: unit for key, unit in unit_numbers.items() if unit not in observed_units}
    require(not missing, {
        'message': 'observation did not return the entities the NPC just built',
        'missing': missing, 'observation': observation,
    })

    # ---- load the source -------------------------------------------------
    supply = run_operation(
        remote_call(
            'autorio_operations', 'move_items_exact',
            repr(ITEM), str(unit_numbers['source_chest']), str(SOURCE_ITEMS), 'true',
        ),
        'load source chest',
        20.0,
    )
    require(supply.get('completed') is True and supply.get('code') == 'completed', supply)
    require((supply.get('moved_count') or 0) > 0, supply)

    baseline = probe('transport baseline')
    evidence['baseline'] = baseline
    flush()
    source_baseline = baseline['cell']['source_chest'].get('items') or 0
    destination_baseline = baseline['cell']['destination_chest'].get('items') or 0
    require(source_baseline >= SOURCE_ITEMS - 2, {
        'message': 'the NPC did not deliver the input material into the source chest',
        'source_chest': baseline['cell']['source_chest'],
    })

    # ---- MEASURED (start): sample the line while items move ---------------
    def start_measurement(request: str, context: str) -> int:
        started = json_command(lua_json(remote_call('autorio_planning', 'throughput_measurement_start', request)), context)
        require(started.get('ok') is True and started.get('state') == 'running', {'context': context, 'result': started})
        return started['measurement_id']

    window = f'warmup_ticks={MEASURE_WARMUP_TICKS},window_ticks={MEASURE_WINDOW_TICKS}'
    measurements = {
        f'{MEASURED_BELT} lane {lane}': start_measurement(
            f"{{kind='belt_lane',unit_number={unit_numbers[MEASURED_BELT]},lane_index={lane},item_name='{ITEM}',{window}}}",
            f'start {MEASURED_BELT} lane {lane} measurement',
        )
        for lane in (1, 2)
    }
    measurements['destination_inserter'] = start_measurement(
        f"{{kind='inserter_instance',unit_number={unit_numbers['destination_inserter']},item_name='{ITEM}',{window}}}",
        'start destination inserter measurement',
    )
    capacity = json_command(
        lua_json(remote_call('autorio_planning', 'capacity', f"{{kind='inserter_instance',unit_number={unit_numbers['destination_inserter']}}}")),
        'destination inserter capacity',
    )
    require(capacity.get('ok') is True and capacity.get('unit_number') == unit_numbers['destination_inserter'], {
        'message': 'inserter capacity did not resolve the observed inserter', 'capacity': capacity,
    })

    # ---- OPERATING + MOVING ----------------------------------------------
    observed = baseline
    rounds_used = 0
    belt_items_seen = 0
    no_power_seen: list[dict] = []
    for attempt in range(ROUNDS):
        delivered = (observed['cell']['destination_chest'].get('items') or 0) - destination_baseline
        if delivered >= TARGET_TRANSPORTED:
            break
        run_operation(
            remote_call('autorio_operations', 'wait', str(ROUND_TICKS)),
            f'observe transport round {attempt + 1}',
            40.0,
        )
        observed = probe(f'transport round {attempt + 1}')
        rounds_used = attempt + 1
        belt_items_seen = max(
            belt_items_seen,
            sum(observed['cell'][key].get('line_items') or 0 for key in BELT_KEYS),
        )
        for key in ['source_inserter', 'destination_inserter']:
            if observed['cell'][key].get('status_name') == 'no_power':
                no_power_seen.append(observed['cell'][key])
        evidence['last_round'] = observed
        evidence['rounds_used'] = rounds_used
        evidence['belt_items_seen'] = belt_items_seen
        flush()

    require(not no_power_seen, {
        'message': 'an inserter lost power during the observation window', 'samples': no_power_seen,
    })

    delivered = (observed['cell']['destination_chest'].get('items') or 0) - destination_baseline
    source_left = observed['cell']['source_chest'].get('items') or 0
    require(delivered >= TARGET_TRANSPORTED, {
        'message': 'belt transport did not deliver the expected items within the bounded tick window',
        'expected_delivered': TARGET_TRANSPORTED, 'delivered': delivered,
        'rounds_used': rounds_used, 'tick_budget': ROUNDS * ROUND_TICKS,
        'cell': observed['cell'],
    })
    require(source_left <= source_baseline - TARGET_TRANSPORTED, {
        'message': 'the source inventory did not fall in step with the delivered items',
        'source_baseline': source_baseline, 'source_left': source_left, 'delivered': delivered,
    })
    require(belt_items_seen > 0, {
        'message': 'no item was ever observed riding the belt run, so belt transport is unproven',
        'cell': observed['cell'],
    })

    # ---- MEASURED (finish) -------------------------------------------------
    results_by_name: dict[str, dict] = {}
    for attempt in range(ROUNDS):
        results_by_name = {
            name: json_command(lua_json(remote_call('autorio_planning', 'throughput_measurement_status', str(measurement_id))), f'{name} measurement status')
            for name, measurement_id in measurements.items()
        }
        if all(result.get('state') != 'running' for result in results_by_name.values()):
            break
        run_operation(remote_call('autorio_operations', 'wait', str(ROUND_TICKS)), f'wait for measurements {attempt + 1}', 40.0)
    evidence['measurements'] = results_by_name
    flush()
    for name, result in results_by_name.items():
        require(result.get('ok') is True and result.get('state') == 'complete', {'message': f'{name} measurement did not complete', 'result': result})
    belt_items_measured = sum(results_by_name[f'{MEASURED_BELT} lane {lane}'].get('measured_items') or 0 for lane in (1, 2))
    require(belt_items_measured > 0, {'message': 'belt-lane measurements counted no items on a moving line', 'measurements': results_by_name})
    inserter_delivered = (results_by_name['destination_inserter'].get('inserter') or {}).get('delivered_items') or 0
    require(inserter_delivered > 0, {'message': 'inserter measurement counted no deliveries on a moving line', 'measurement': results_by_name['destination_inserter']})

    area = f'{{area={{left_top={{x={ox - 7},y={oy - 1}}},right_bottom={{x={ox + 2},y={oy + 7}}}}}}}'
    analyzed = json_command(lua_json(remote_call('autorio_skills', 'analyze_area', area)), 'analyze the transport cell area')
    require(analyzed.get('ok') is True, {'message': 'factory area analysis failed on the cell', 'result': analyzed})
    # Area analysis reads the factory graph (transport, storage, inserters, poles,
    # machines); solar panels have no item or fluid transfers and are out of scope.
    # The cleared area holds nothing else, so the count is exact.
    graph_entities = [spec for spec in CELL if spec['name'] != 'solar-panel']
    require(analyzed.get('entity_count') == len(graph_entities) and (analyzed.get('relation_count') or 0) > 0, {
        'message': 'factory area analysis missed cell entities or their transfer relations',
        'expected_entity_count': len(graph_entities), 'result': analyzed,
    })
    evidence['area_analysis'] = analyzed
    print(
        f'PASS: MEASURED - belt lanes counted {belt_items_measured} {ITEM}, the inserter delivered {inserter_delivered} '
        f'in a {MEASURE_WINDOW_TICKS}-tick window, and area analysis read {analyzed["entity_count"]} entities '
        f'and {analyzed["relation_count"]} relations',
        flush=True,
    )

    command('/silent-command game.speed=1; rcon.print("true")')
    evidence.update({
        'status': 'pass',
        'delivered': delivered,
        'source_baseline': source_baseline,
        'source_left': source_left,
        'belt_items_seen': belt_items_seen,
        'rounds_used': rounds_used,
        'final': observed,
    })
    flush()
    print(
        f'PASS: MOVING - A1 belt transport delivered {delivered} {ITEM} chest -> inserter -> '
        f'{len(BELT_KEYS)} belts -> inserter -> chest (source {source_baseline}->{source_left}, '
        f'peak {belt_items_seen} items observed on the belt run) within {rounds_used} bounded rounds',
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
        (args.results / 'belt-transport-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        try:
            if client:
                client.command('/silent-command game.speed=1')
        except Exception:
            pass
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
