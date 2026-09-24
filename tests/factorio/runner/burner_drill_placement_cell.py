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

Gates:
    CANDIDATES  the drill query returns ore-covering candidates with an output
                tile; the furnace query returns only placements covering it
    BUILT       place_candidate places both entities
    CONNECTED   the drill's drop_target is exactly that furnace
    OPERATING   once fuelled through supply_entity, plates appear in the furnace
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


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


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
