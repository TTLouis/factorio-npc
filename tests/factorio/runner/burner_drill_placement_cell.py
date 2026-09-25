#!/usr/bin/env python3
"""Harness proof for candidate-based drill -> furnace placement (production canary).

The burner-drill canary places a burner mining drill on iron ore and a stone
furnace on the drill's output. The planner is meant to do this through the
harness candidate system instead of typing coordinates:

    getPlacementCandidates(burner-mining-drill, target_resource=iron-ore)
        -> place_candidate
    getPlacementCandidates(stone-furnace, covers_position=<drill output>)
        -> place_candidate

Unit tests mock prototypes, and four defects on this path only showed in the
live engine (2026-09-24): a prototype key 2.0 lacks, a quality argument passed
by a compiled method call, an untyped array compiled to a nil `.length`, and
array-form prototype vectors. This cell runs the whole chain against real
Factorio. The fixture (ore patch, items) is scripted; the behavior under test
goes through the NPC's remote interfaces.

It also checks the rate facts the planner uses to size production
(docs/PARALLEL_PRODUCTION_WORK_PLAN.md W1): the harness figures must equal the
engine's own prototype values, and the running pair must produce at the rate
the harness computed.

Gates:
    RATES       recipe_details / mining_details / production_estimate report
                the stone furnace and burner drill rates and fuel burn that the
                engine prototypes give (and the known 2.0 base values)
    CANDIDATES  the drill query returns ore-covering candidates with an output
                tile; the furnace query returns only placements covering it
    BUILT       place_candidate places both entities
    CONNECTED   the drill's drop_target is exactly that furnace
    OPERATING   once fuelled through supply_entity, plates appear in the furnace
    MEASURED    over a fixed window, ore mined and plates smelted (force
                production statistics) match the computed rate within one unit
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle

ORE_AMOUNT = 1000
FUEL_COUNT = 5
TARGET_PLATES = 2
ROUND_TICKS = 300
ROUNDS = 20
# Ten burner-drill cycles (4 s each) at game speed 4.
MEASURE_TICKS = 2400
RATE_EPSILON = 0.001

# Factorio 2.0 base data: stone furnace speed 1 at 90 kW, iron-plate 3.2 s,
# burner drill speed 0.25 at 150 kW, iron ore 1 s, coal 4 MJ.
KNOWN_FURNACE_PLATES_PER_MINUTE = 18.75
KNOWN_DRILL_ORE_PER_MINUTE = 15
KNOWN_FURNACE_COAL_PER_MINUTE = 1.35
KNOWN_DRILL_COAL_PER_MINUTE = 2.25


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def close(a: object, b: float) -> bool:
    return isinstance(a, (int, float)) and abs(a - b) <= RATE_EPSILON


def named(entries: object, name: str) -> dict:
    for entry in entries or []:
        if isinstance(entry, dict) and entry.get('name') == name:
            return entry
    return {}


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'scenario': 'burner-drill-placement'}

    def flush() -> None:
        evidence['transcript'] = transcript
        (results / 'burner-drill-placement-cell.json').write_text(json.dumps(evidence, indent=2))

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
        flush()
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        admission = json_command(
            '/silent-command local result=' + expression + '; '
            'local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            'else accepted=result==true end; '
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))',
            f'{context} admission',
        )
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        status = wait_until_idle(operation_status, context, timeout)
        receipt = (status.get('basic_operation') or {}).get('last_result') or {}
        require(receipt.get('completed') is True and receipt.get('code') == 'completed', {'context': context, 'receipt': receipt})
        return receipt

    def candidates(request: str, context: str) -> dict:
        result = json_command(lua_json(remote_call('autorio_tools', 'get_placement_candidates', request)), context)
        require(result.get('ok') is True, {'context': context, 'result': result})
        require(len(result.get('candidates') or []) > 0, {'context': context, 'message': 'no candidates', 'result': result})
        return result

    # ---- fixture: a small iron-ore patch beside the NPC, and its items ----
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-10,oy-10},{ox+10,oy+10}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-10,ox+10 do for y=oy-10,oy+10 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        'for x=ox+3,ox+6 do for y=oy-2,oy+1 do '
        f"s.create_entity{{name='iron-ore',position={{x+0.5,y+0.5}},amount={ORE_AMOUNT}}} end end; "
        'local inv=a.get_main_inventory(); inv.clear(); '
        "inv.insert{name='burner-mining-drill',count=1}; inv.insert{name='stone-furnace',count=1}; "
        f"inv.insert{{name='coal',count={FUEL_COUNT * 2}}}; "
        'game.speed=4; '
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,position=a.position}))',
        'burner drill placement fixture',
    )
    ox, oy = fixture.get('ox'), fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    evidence['fixture'] = fixture
    ore_center = f'{{x={ox + 5},y={oy}}}'

    # ---- RATES: harness rate facts equal the engine prototypes -----------
    engine = json_command(
        "/silent-command local f=prototypes.entity['stone-furnace']; local d=prototypes.entity['burner-mining-drill']; "
        "local r=prototypes.recipe['iron-plate']; local o=prototypes.entity['iron-ore']; local c=prototypes.item['coal']; "
        'local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name=\'character\'}) do '
        f'if e.unit_number=={actor_id} then a=e end end; '
        # 2.0 removed LuaEntityPrototype.crafting_speed; record whether reading it raises.
        'local legacy_ok=pcall(function() return f.crafting_speed end); '
        'rcon.print(helpers.table_to_json({furnace_speed=f.get_crafting_speed(),plate_energy=r.energy,'
        'furnace_watts=f.get_max_energy_usage()*60,furnace_effectivity=f.burner_prototype.effectivity,'
        'drill_speed=d.mining_speed,drill_watts=d.get_max_energy_usage()*60,drill_effectivity=d.burner_prototype.effectivity,'
        'ore_time=o.mineable_properties.mining_time,coal_value=c.fuel_value,'
        'productivity=a.force.mining_drill_productivity_bonus,legacy_crafting_speed_key_readable=legacy_ok}))',
        'engine prototype rates',
    )
    evidence['engine_prototypes'] = engine
    furnace_rate = engine['furnace_speed'] / engine['plate_energy']
    drill_rate = engine['drill_speed'] / engine['ore_time'] * (1 + engine['productivity'])
    furnace_coal = engine['furnace_watts'] * 60 / (engine['coal_value'] * engine['furnace_effectivity'])
    drill_coal = engine['drill_watts'] * 60 / (engine['coal_value'] * engine['drill_effectivity'])

    plate = json_command(lua_json(remote_call('autorio_knowledge', 'recipe_details', repr('iron-plate'), '1', repr('coal'))), 'iron plate rates')
    plate_recipe = named(plate.get('recipes'), 'iron-plate')
    stone = named(plate_recipe.get('crafting_machines'), 'stone-furnace')
    evidence['recipe_rates'] = stone
    require(close(stone.get('crafting_speed'), engine['furnace_speed'])
            and close(stone.get('crafts_per_second'), furnace_rate)
            and close(stone.get('seconds_per_craft'), 1 / furnace_rate)
            and close(named(stone.get('products_per_minute'), 'iron-plate').get('per_minute'), furnace_rate * 60)
            and close(stone.get('energy_watts'), engine['furnace_watts'])
            and close((stone.get('fuel') or {}).get('per_minute'), furnace_coal), {
        'message': 'stone furnace rate facts differ from the engine prototypes', 'reported': stone, 'engine': engine,
    })
    require(close(furnace_rate * 60, KNOWN_FURNACE_PLATES_PER_MINUTE) and close(furnace_coal, KNOWN_FURNACE_COAL_PER_MINUTE), {
        'message': 'engine stone furnace values differ from the 2.0 base data', 'engine': engine,
    })

    mining = json_command(lua_json(remote_call('autorio_knowledge', 'mining_details', repr('iron-ore'), repr('coal'))), 'iron ore mining rates')
    ore = named(mining.get('resources'), 'iron-ore')
    burner = named(ore.get('drills'), 'burner-mining-drill')
    evidence['mining_rates'] = {'resource': {key: ore.get(key) for key in ('mining_time', 'category', 'infinite')}, 'drill': burner, 'hand': ore.get('hand_mining')}
    require(close(ore.get('mining_time'), engine['ore_time'])
            and close(burner.get('mining_speed'), engine['drill_speed'])
            and close(burner.get('productivity_bonus'), engine['productivity'])
            and close(named(burner.get('products_per_minute'), 'iron-ore').get('per_minute'), drill_rate * 60)
            and close(burner.get('energy_watts'), engine['drill_watts'])
            and close((burner.get('fuel') or {}).get('per_minute'), drill_coal), {
        'message': 'burner drill rate facts differ from the engine prototypes', 'reported': burner, 'engine': engine,
    })
    require(close(drill_rate * 60, KNOWN_DRILL_ORE_PER_MINUTE) and close(drill_coal, KNOWN_DRILL_COAL_PER_MINUTE), {
        'message': 'engine burner drill values differ from the 2.0 base data', 'engine': engine,
    })

    estimate = json_command(lua_json(remote_call('autorio_knowledge', 'production_estimate',
        "{target='iron-plate',count=100,steps={"
        "{item='iron-plate',machine='stone-furnace',machine_count=1,fuel='coal'},"
        "{item='iron-ore',machine='burner-mining-drill',machine_count=1,fuel='coal'}}}")), 'iron plate estimate')
    evidence['estimate'] = estimate
    # One drill limits one furnace: 100 ore at 4 s, then one 3.2 s smelt.
    expected_total = 100 / drill_rate + 1 / furnace_rate
    require(estimate.get('ok') is True
            and (estimate.get('bottleneck') or {}).get('item') == 'iron-ore'
            and close(estimate.get('total_seconds'), expected_total)
            and close((estimate.get('one_more_on_bottleneck') or {}).get('total_seconds'), 100 / furnace_rate + 1 / drill_rate), {
        'message': 'production estimate does not follow the engine rates', 'estimate': estimate, 'expected_total': expected_total,
    })
    print(f'PASS: RATES - stone furnace {furnace_rate * 60:g} plates/min and {furnace_coal:g} coal/min, '
          f'burner drill {drill_rate * 60:g} ore/min and {drill_coal:g} coal/min; 100 plates with 1+1 take '
          f"{estimate['total_seconds']:g} s, {estimate['one_more_on_bottleneck']['total_seconds']:g} s with a second drill "
          f"(legacy crafting_speed key readable: {engine['legacy_crafting_speed_key_readable']})", flush=True)

    # ---- CANDIDATES + BUILT: drill -----------------------------------------
    drills = candidates(
        f"{{entity_name='burner-mining-drill',center={ore_center},radius=4,target_resource='iron-ore',limit=3}}",
        'drill candidates',
    )
    drill = drills['candidates'][0]
    coverage = {entry.get('name'): entry.get('entities') for entry in drill.get('resource_coverage') or []}
    require((coverage.get('iron-ore') or 0) > 0, {'message': 'drill candidate does not cover iron ore', 'candidate': drill})
    output = drill.get('item_output_position')
    require(isinstance(output, dict) and 'x' in output and 'y' in output, {'message': 'drill candidate has no output tile', 'candidate': drill})
    print(f"PASS: CANDIDATES - drill {drill['id']} at {drill['position']} covers {coverage['iron-ore']} ore tiles, output {output}", flush=True)
    run_operation(remote_call('autorio_operations', 'place_candidate', repr(drills['candidate_set_id']), repr(drill['id'])), 'place drill', 60.0)

    # ---- CANDIDATES + BUILT: furnace on the drill output -----------------
    furnaces = candidates(
        f"{{entity_name='stone-furnace',covers_position={{x={output['x']},y={output['y']}}},limit=4}}",
        'furnace candidates',
    )
    for candidate in furnaces['candidates']:
        position = candidate['position']
        require(abs(position['x'] - output['x']) < 1 and abs(position['y'] - output['y']) < 1, {
            'message': 'furnace candidate does not cover the drill output', 'candidate': candidate, 'output': output,
        })
    furnace = furnaces['candidates'][0]
    print(f"PASS: CANDIDATES - {len(furnaces['candidates'])} furnace candidates all cover the drill output", flush=True)
    run_operation(remote_call('autorio_operations', 'place_candidate', repr(furnaces['candidate_set_id']), repr(furnace['id'])), 'place furnace', 60.0)

    placed = json_command(
        '/silent-command local s=game.surfaces[1]; '
        "local d=s.find_entities_filtered{name='burner-mining-drill'}[1]; "
        "local f=s.find_entities_filtered{name='stone-furnace'}[1]; "
        'rcon.print(helpers.table_to_json({drill=d and {unit=d.unit_number,position=d.position,drop=d.drop_position} or nil,'
        'furnace=f and {unit=f.unit_number,position=f.position} or nil}))',
        'placed entities',
    )
    require(placed.get('drill') and placed.get('furnace'), {'message': 'drill or furnace missing after placement', 'placed': placed})
    evidence['placed'] = placed
    print(f"PASS: BUILT - drill at {placed['drill']['position']}, furnace at {placed['furnace']['position']}", flush=True)

    # ---- OPERATING + CONNECTED ------------------------------------------
    for key in ('drill', 'furnace'):
        run_operation(
            remote_call('autorio_operations', 'supply_entity', str(placed[key]['unit']), f"{{{{item_name='coal',count={FUEL_COUNT}}}}}"),
            f'fuel {key}',
        )
    samples = []
    for _ in range(ROUNDS):
        time.sleep(ROUND_TICKS / 60 / 4)
        sample = json_command(
            '/silent-command local s=game.surfaces[1]; '
            "local d=s.find_entities_filtered{name='burner-mining-drill'}[1]; "
            "local f=s.find_entities_filtered{name='stone-furnace'}[1]; "
            'rcon.print(helpers.table_to_json({tick=game.tick,drop_target=d.drop_target and d.drop_target.unit_number or 0,'
            "plates=f.get_output_inventory().get_item_count('iron-plate')}))",
            'operating sample',
        )
        samples.append(sample)
        if sample.get('drop_target') == placed['furnace']['unit'] and (sample.get('plates') or 0) >= TARGET_PLATES:
            break
    evidence['samples'] = samples
    last = samples[-1]
    require(last.get('drop_target') == placed['furnace']['unit'], {'message': 'drill does not drop into the placed furnace', 'samples': samples})
    print('PASS: CONNECTED - the drill drop_target is the placed furnace', flush=True)
    require((last.get('plates') or 0) >= TARGET_PLATES, {'message': 'furnace produced too few plates', 'samples': samples})
    print(f"PASS: OPERATING - {last['plates']} iron plates smelted from drill output", flush=True)

    # ---- MEASURED: the running pair produces at the computed rate --------
    # The furnace outpaces one drill, so both ore and plates flow at the drill
    # rate. A periodic process counted between two instants is off by at most
    # one unit, so the tolerance is one ore and one plate.
    stats_command = (
        '/silent-command local s=game.surfaces[1]; local a=nil; '
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f'if e.unit_number=={actor_id} then a=e end end; '
        'local st=a.force.get_item_production_statistics(s); '
        "rcon.print(helpers.table_to_json({tick=game.tick,ore=st.get_input_count('iron-ore'),plates=st.get_input_count('iron-plate')}))"
    )
    window_start = json_command(stats_command, 'production statistics start')
    time.sleep(MEASURE_TICKS / 60 / 4)
    window_end = json_command(stats_command, 'production statistics end')
    seconds = (window_end['tick'] - window_start['tick']) / 60
    computed_per_second = named(burner.get('products_per_minute'), 'iron-ore').get('per_minute') / 60
    expected = computed_per_second * seconds
    mined = window_end['ore'] - window_start['ore']
    smelted = window_end['plates'] - window_start['plates']
    evidence['measured'] = {'start': window_start, 'end': window_end, 'seconds': seconds, 'expected': expected, 'ore': mined, 'plates': smelted}
    flush()
    require(seconds >= 20, {'message': 'measurement window too short', 'measured': evidence['measured']})
    require(abs(mined - expected) <= 1 and abs(smelted - expected) <= 1, {
        'message': 'measured production differs from the computed rate', 'measured': evidence['measured'],
    })
    print(f'PASS: MEASURED - {mined} ore and {smelted} plates in {seconds:g} s game time; computed {expected:g}', flush=True)
    evidence['status'] = 'pass'
    flush()


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
        (args.results / 'burner-drill-placement-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
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
