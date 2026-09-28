#!/usr/bin/env python3
"""Engine proof for waits from game data (plan 2.5).

The runtime keeps the planner asleep on a condition wait while a machine works
toward a step checkpoint, and takes the wake deadline from the expectation the
mod attaches to each condition answer (production_eta.ts: recipe energy over
the live crafting speed, the craft under way, loaded inputs and fuel). This
cell checks that expectation against what the engine then does.

A stone furnace (scripted fixture: coal and six iron ore) smelts plates. The
condition answers are read through the same remote the runtime polls
(autorio_tools.evaluate_condition), after the NPC observed the furnace.

Gates:
    TO_TARGET   entity_inventory_count (5 plates): eta.seconds_to_target equals
                the measured game time to the fifth plate within one tick per
                craft plus one polling step
    UNTIL_IDLE  entity_state working: eta.seconds_until_idle equals the
                measured game time until the loaded ore is used up
    LIMIT       a checkpoint beyond the loaded ore reports limited_by inputs;
                once met, the answer carries no expectation
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call

ORE = 6
TARGET = 5
TICK = 1 / 60
# Crafting machines finish a craft on a whole tick; RCON polling adds at most a
# few ticks at game speed 1.
POLL_TICKS = 3


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'scenario': 'machine-eta'}

    def flush() -> None:
        evidence['transcript'] = transcript[-200:]
        (results / 'machine-eta-cell.json').write_text(json.dumps(evidence, indent=2))

    def json_command(text: str, context: str, record: bool = True) -> Any:
        response = client.command(text)
        if record:
            transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
            flush()
        return decode_json(response, context)

    find_actor = (
        "local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
    )
    fixture = json_command(
        '/silent-command ' + find_actor +
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-6,oy-6},{ox+6,oy+6}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-6,ox+6 do for y=oy-6,oy+6 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); '
        "local f=s.create_entity{name='stone-furnace',position={ox+3,oy},force=a.force}; assert(f); "
        'local previous_speed=game.speed; game.speed=1; '
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,unit=f.unit_number,previous_speed=previous_speed}))',
        'machine eta fixture',
    )
    unit = fixture['unit']
    ox, oy = fixture['ox'], fixture['oy']
    evidence['fixture'] = fixture

    # The NPC observes the furnace, as a planner would before it waits on it.
    status = json_command(lua_json(remote_call('autorio_tools', 'get_entity_status', repr('stone-furnace'), '8')), 'observe furnace')
    require(status.get('found') is not False, status)

    furnace = f"local f=nil; for _,e in pairs(s.find_entities_filtered{{name='stone-furnace'}}) do if e.unit_number=={unit} then f=e end end; assert(f); "

    def condition(request: str, context: str, record: bool = True) -> dict:
        return json_command(
            '/silent-command ' + find_actor + furnace +
            f"local r=remote.call('autorio_tools','evaluate_condition',{request}); "
            "rcon.print(helpers.table_to_json({tick=game.tick,plates=f.get_output_inventory().get_item_count('iron-plate'),"
            "crafting=f.is_crafting(),result=r}))",
            context,
            record,
        )

    to_target = f"{{kind='entity_inventory_count',unit_number={unit},item_name='iron-plate',minimum={TARGET}}}"
    working = f"{{kind='entity_state',unit_number={unit},expected='working'}}"
    beyond = f"{{kind='entity_inventory_count',unit_number={unit},item_name='iron-plate',minimum={ORE + 10}}}"

    json_command(
        '/silent-command ' + find_actor + furnace +
        f"f.get_fuel_inventory().insert{{name='coal',count=2}}; f.get_inventory(defines.inventory.crafter_input).insert{{name='iron-ore',count={ORE}}}; "
        'rcon.print(helpers.table_to_json({tick=game.tick}))',
        'load furnace',
    )
    # First answer once the furnace is crafting, as a condition poll would see it.
    first_target = first_idle = None
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        sample = condition(to_target, 'first target answer', record=False)
        if sample['crafting'] and (sample['result'].get('eta') or {}).get('seconds_to_target') is not None:
            idle = condition(working, 'first working answer', record=False)
            if (idle['result'].get('eta') or {}).get('seconds_until_idle') is not None:
                first_target, first_idle = sample, idle
                break
        time.sleep(0.02)
    require(first_target is not None and first_idle is not None, {'message': 'furnace never started crafting', 'last': sample})
    evidence['first_target'] = first_target
    evidence['first_idle'] = first_idle
    limit = condition(beyond, 'beyond loaded ore')
    evidence['limit'] = limit
    eta_target = first_target['result']['eta']
    eta_idle = (first_idle['result'].get('eta') or {})
    require(isinstance(eta_idle.get('seconds_until_idle'), (int, float)), {'message': 'working furnace answered without seconds_until_idle', 'answer': first_idle})

    fifth_tick = sixth_tick = None
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        sample = condition(to_target, 'plate progress', record=False)
        if fifth_tick is None and sample['plates'] >= TARGET:
            fifth_tick = sample['tick']
            evidence['met'] = sample
        if sample['plates'] >= ORE:
            sixth_tick = sample['tick']
            break
        time.sleep(0.02)
    require(fifth_tick is not None and sixth_tick is not None, {'message': 'furnace did not smelt the loaded ore', 'last': sample})

    measured_target = (fifth_tick - first_target['tick']) / 60
    measured_idle = (sixth_tick - first_idle['tick']) / 60
    crafts = eta_target.get('crafts_needed') or TARGET
    evidence['measured'] = {'to_target_seconds': measured_target, 'until_idle_seconds': measured_idle}
    flush()

    tolerance_target = (crafts + POLL_TICKS) * TICK + 0.05
    require(abs(measured_target - eta_target['seconds_to_target']) <= tolerance_target, {
        'message': 'expected time to the checkpoint differs from the engine', 'eta': eta_target, 'measured': measured_target,
    })
    print(f"PASS: TO_TARGET - {TARGET} plates expected in {eta_target['seconds_to_target']} s "
          f"({eta_target.get('crafts_needed')} crafts at {eta_target.get('seconds_per_craft')} s), measured {measured_target:.3f} s", flush=True)

    tolerance_idle = (ORE + POLL_TICKS) * TICK + 0.05
    require(abs(measured_idle - eta_idle['seconds_until_idle']) <= tolerance_idle, {
        'message': 'expected time until the loaded ore runs out differs from the engine', 'eta': eta_idle, 'measured': measured_idle,
    })
    print(f"PASS: UNTIL_IDLE - loaded ore expected to run out in {eta_idle['seconds_until_idle']} s, measured {measured_idle:.3f} s", flush=True)

    require((limit['result'].get('eta') or {}).get('limited_by') == 'inputs', {'message': 'a checkpoint beyond the loaded ore must name inputs', 'answer': limit})
    met = condition(to_target, 'met checkpoint')
    require(met['result'].get('satisfied') is True and met['result'].get('eta') is None, {'message': 'a met checkpoint carries no expectation', 'answer': met})
    print('PASS: LIMIT - beyond the loaded ore reports limited_by inputs; a met checkpoint carries no expectation', flush=True)

    json_command(
        '/silent-command ' + find_actor +
        f"game.speed={fixture.get('previous_speed') or 1}; "
        f"for _,e in pairs(s.find_entities_filtered{{area={{{{{ox - 6},{oy - 6}}},{{{ox + 6},{oy + 6}}}}}}}) do "
        "if e.type~='character' then e.destroy() end end; rcon.print(helpers.table_to_json({cleaned=true}))",
        'machine eta cleanup',
    )
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
        (args.results / 'machine-eta-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
