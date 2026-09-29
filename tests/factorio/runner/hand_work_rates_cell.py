#!/usr/bin/env python3
"""Engine proof for the NPC's own hand-mining and hand-crafting rates (plan 2.4).

The harness estimates the NPC's serial lane from prototypes: hand mining is the
resource's mining_time over the character's mining speed, hand crafting is the
recipe energy over the hand crafting speed, each speed scaled by
(1 + force manual modifier + character modifier). The estimate tool path
(mining_details / recipe_details / production_estimate, which the plan-time
estimate reads) must agree with what the engine actually does when the NPC
mines and crafts through its own operations, including the force modifiers.

The ore sits inside reach, so no walking is measured. Two numbers per run:
    per-cycle   slope of (items + current progress) over game ticks while the
                NPC works; independent of RCON polling
    end-to-end  game ticks from admission to the last item, per item; includes
                the operation's start and a polling step (at most a few ticks)

Measured on 2.0.77 (2026-09-28): iron ore 121 ticks per ore at the base speed
(formula 120) and 60 at +100% (formula 60); iron gear wheel 31 ticks per craft
(formula 30) and 16 at +100% (formula 15). The engine adds at most one tick per
cycle, so the tolerance is that tick plus half a tick of sampling slack per
cycle (1.5 ticks), not a percentage.

The unnamed hand-craft estimate request is exactly the one the plan-time
estimate sends; with Space Age loaded it was refused as ambiguous for gears
(locked scrap-recycling also yields them) until researched recipes came first.

Gates:
    HAND_MINING   iron ore by mine_resource_at, force manual mining modifier 0
                   and 1: measured seconds per ore == mining_time / speed
    HAND_CRAFTING  iron gear wheels by craft_item, force manual crafting
                   modifier 0 and 1: measured seconds per craft == energy / speed
    ESTIMATE       for each run, mining_details / recipe_details and the exact
                   production_estimate requests the plan-time estimate sends
                   report the same seconds per cycle, with the modifier applied
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle

ORE_AMOUNT = 5000
MINE_COUNT = 6
CRAFT_COUNT = 8
MODIFIERS = (0, 1)
# One game tick per cycle is the engine's time resolution.
TICK = 1 / 60
# The engine's one-tick overhead per cycle plus sampling slack; exactly one
# tick would fail on float rounding when the overhead is exactly one tick.
CYCLE_TOLERANCE = 1.5 * TICK


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def named(entries: object, name: str) -> dict:
    for entry in entries or []:
        if isinstance(entry, dict) and entry.get('name') == name:
            return entry
    return {}


def slope_seconds_per_item(samples: list[dict], target: int) -> float | None:
    """Seconds per item from (count + progress) between the first and last working sample."""
    working = [s for s in samples if s['count'] < target and (s['count'] + s['progress']) > 0]
    if len(working) < 2:
        return None
    first, last = working[0], working[-1]
    done = (last['count'] + last['progress']) - (first['count'] + first['progress'])
    if done <= 0:
        return None
    return (last['tick'] - first['tick']) / 60 / done


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'scenario': 'hand-work-rates', 'runs': []}

    def flush() -> None:
        evidence['transcript'] = transcript[-400:]
        (results / 'hand-work-rates-cell.json').write_text(json.dumps(evidence, indent=2))

    def json_command(text: str, context: str, record: bool = True) -> Any:
        response = client.command(text)
        if record:
            transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
            flush()
        return decode_json(response, context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

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
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        f"assert(s.create_entity{{name='iron-ore',position={{ox+1.5,oy+0.5}},amount={ORE_AMOUNT}}}); "
        'a.get_main_inventory().clear(); '
        'local previous_speed=game.speed; game.speed=1; '
        "rcon.print(helpers.table_to_json({ox=ox,oy=oy,position=a.position,previous_speed=previous_speed,"
        "reach=a.resource_reach_distance}))",
        'hand work fixture',
    )
    ox, oy = fixture.get('ox'), fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    evidence['fixture'] = fixture
    ore_x, ore_y = ox + 1.5, oy + 0.5

    def set_modifiers(mining: float, crafting: float) -> dict:
        return json_command(
            '/silent-command ' + find_actor +
            f'a.force.manual_mining_speed_modifier={mining}; a.force.manual_crafting_speed_modifier={crafting}; '
            'a.character_mining_speed_modifier=0; a.character_crafting_speed_modifier=0; '
            'local p=a.prototype; '
            "rcon.print(helpers.table_to_json({mining_speed=p.mining_speed,crafting_speed=p.get_crafting_speed(),"
            'force_mining=a.force.manual_mining_speed_modifier,force_crafting=a.force.manual_crafting_speed_modifier,'
            "ore_time=prototypes.entity['iron-ore'].mineable_properties.mining_time,"
            "gear_energy=prototypes.recipe['iron-gear-wheel'].energy}))",
            'set manual modifiers',
        )

    def admit(expression: str, context: str) -> int:
        admission = json_command(
            '/silent-command local result=' + expression + '; '
            'local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            'else accepted=result==true end; '
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message,tick=game.tick}))',
            f'{context} admission',
        )
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        return admission['tick']

    def sample_loop(item: str, progress_expr: str, target: int, context: str, wall_limit: float) -> list[dict]:
        command = (
            '/silent-command ' + find_actor +
            f"local ok,progress=pcall(function() return {progress_expr} end); "
            f"rcon.print(helpers.table_to_json({{tick=game.tick,count=a.get_main_inventory().get_item_count('{item}'),"
            'progress=ok and progress or -1,walking=a.walking_state.walking,x=a.position.x,y=a.position.y}))'
        )
        samples: list[dict] = []
        deadline = time.monotonic() + wall_limit
        while time.monotonic() < deadline:
            sample = json_command(command, context, record=False)
            samples.append(sample)
            if sample['count'] >= target:
                break
            time.sleep(0.02)
        require(samples and samples[-1]['count'] >= target, {'context': context, 'message': 'did not finish in time', 'last': samples[-1:] })
        require(all(s['progress'] >= 0 for s in samples), {'context': context, 'message': 'progress read failed', 'first': samples[:2]})
        require(not any(s['walking'] for s in samples), {'context': context, 'message': 'the NPC walked during a rate measurement'})
        return samples

    def hand_mining_run(modifier: float) -> dict:
        engine = set_modifiers(modifier, 0)
        speed = engine['mining_speed'] * (1 + modifier)
        formula = engine['ore_time'] / speed
        details = json_command(lua_json(remote_call('autorio_knowledge', 'mining_details', repr('iron-ore'))), 'hand mining details')
        hand = named(details.get('resources'), 'iron-ore').get('hand_mining') or {}
        estimate = json_command(lua_json(remote_call('autorio_knowledge', 'production_estimate',
            f"{{target='iron-ore',count={MINE_COUNT},steps={{{{item='iron-ore',resource='iron-ore'}}}}}}")), 'hand mining estimate')
        step = next((s for s in estimate.get('steps') or [] if s.get('kind') == 'hand_mine'), {})
        json_command('/silent-command ' + find_actor + 'a.get_main_inventory().clear(); rcon.print(helpers.table_to_json({ok=true}))', 'clear inventory')
        start_tick = admit(remote_call('autorio_operations', 'mine_resource_at', repr('iron-ore'), str(ore_x), str(ore_y), str(MINE_COUNT)), 'hand mining')
        samples = sample_loop('iron-ore', 'a.character_mining_progress', MINE_COUNT, 'hand mining sample', 60 / (1 + modifier))
        wait_until_idle(operation_status, 'hand mining finished', 30)
        per_cycle = slope_seconds_per_item(samples, MINE_COUNT)
        end_ticks = samples[-1]['tick'] - start_tick
        record = {
            'kind': 'hand_mine', 'force_manual_mining_speed_modifier': modifier, 'engine': engine,
            'formula_seconds': formula, 'measured_per_cycle_seconds': per_cycle,
            'end_to_end_seconds_per_item': end_ticks / 60 / MINE_COUNT, 'end_to_end_ticks': end_ticks, 'count': MINE_COUNT,
            'mining_details_hand': hand, 'estimate_step': step, 'estimate_total_seconds': estimate.get('total_seconds'),
            'estimate_error': estimate.get('error'),
            'samples': len(samples),
        }
        evidence['runs'].append(record)
        flush()
        return record

    def hand_crafting_run(modifier: float) -> dict:
        engine = set_modifiers(0, modifier)
        speed = engine['crafting_speed'] * (1 + modifier)
        formula = engine['gear_energy'] / speed
        details = json_command(lua_json(remote_call('autorio_knowledge', 'recipe_details', repr('iron-gear-wheel'))), 'hand crafting details')
        hand = named(details.get('recipes'), 'iron-gear-wheel').get('hand_crafting') or {}
        estimate = json_command(lua_json(remote_call('autorio_knowledge', 'production_estimate',
            f"{{target='iron-gear-wheel',count={CRAFT_COUNT},steps={{{{item='iron-gear-wheel'}}}}}}")), 'hand crafting estimate')
        step = next((s for s in estimate.get('steps') or [] if s.get('kind') == 'hand_craft'), {})
        json_command(
            '/silent-command ' + find_actor + 'local inv=a.get_main_inventory(); inv.clear(); '
            f"inv.insert{{name='iron-plate',count={CRAFT_COUNT * 2}}}; rcon.print(helpers.table_to_json({{ok=true}}))",
            'crafting inventory',
        )
        start_tick = admit(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), str(CRAFT_COUNT)), 'hand crafting')
        samples = sample_loop('iron-gear-wheel', 'a.crafting_queue_progress', CRAFT_COUNT, 'hand crafting sample', 30)
        wait_until_idle(operation_status, 'hand crafting finished', 30)
        per_cycle = slope_seconds_per_item(samples, CRAFT_COUNT)
        end_ticks = samples[-1]['tick'] - start_tick
        record = {
            'kind': 'hand_craft', 'force_manual_crafting_speed_modifier': modifier, 'engine': engine,
            'formula_seconds': formula, 'measured_per_cycle_seconds': per_cycle,
            'end_to_end_seconds_per_item': end_ticks / 60 / CRAFT_COUNT, 'end_to_end_ticks': end_ticks, 'count': CRAFT_COUNT,
            'recipe_details_hand': hand, 'estimate_step': step, 'estimate_total_seconds': estimate.get('total_seconds'),
            'estimate_error': estimate.get('error'),
            'samples': len(samples),
        }
        evidence['runs'].append(record)
        flush()
        return record

    def check(record: dict, tool_seconds: object, context: str) -> None:
        formula = record['formula_seconds']
        per_cycle = record['measured_per_cycle_seconds']
        count = record['count']
        # The tool path must report the same arithmetic, modifier included.
        require(isinstance(tool_seconds, (int, float)) and abs(tool_seconds - formula) <= 1e-3,
                {'context': context, 'message': 'tool seconds per cycle differ from the formula', 'record': record})
        step_seconds = (record['estimate_step'] or {}).get('seconds_per_cycle')
        require(isinstance(step_seconds, (int, float)) and abs(step_seconds - formula) <= 1e-3
                and abs((record['estimate_total_seconds'] or 0) - formula * count) <= 1e-3,
                {'context': context, 'message': 'production_estimate differs from the formula', 'record': record})
        # The engine must do the work at that rate: within CYCLE_TOLERANCE per cycle.
        require(per_cycle is not None and abs(per_cycle - formula) <= CYCLE_TOLERANCE,
                {'context': context, 'message': 'measured per-cycle time differs from the formula', 'record': record})
        # End to end: the start of the operation and one polling step (a few ticks) on top.
        require(abs(record['end_to_end_seconds_per_item'] - formula) <= formula * 0.1 + 10 * TICK / count,
                {'context': context, 'message': 'end-to-end time per item differs from the formula', 'record': record})

    failures: dict[str, str] = {}
    try:
        for modifier in MODIFIERS:
            context = f'HAND_MINING modifier {modifier}'
            try:
                record = hand_mining_run(modifier)
                check(record, (record['mining_details_hand'] or {}).get('seconds_per_cycle'), context)
                print(f"PASS: {context} - iron ore {record['measured_per_cycle_seconds']:.4f} s per cycle measured, "
                      f"{record['end_to_end_seconds_per_item']:.4f} s per ore end to end ({record['end_to_end_ticks']} ticks for {record['count']}); "
                      f"formula {record['formula_seconds']:g} s = mining_time {record['engine']['ore_time']:g} / "
                      f"({record['engine']['mining_speed']:g} x {1 + modifier:g}); estimate {record['estimate_total_seconds']:g} s", flush=True)
            except Exception as exc:  # noqa: BLE001 - report every run
                failures[context] = str(exc)
                print(f'FAIL: {context} - {exc}', flush=True)
        for modifier in MODIFIERS:
            context = f'HAND_CRAFTING modifier {modifier}'
            try:
                record = hand_crafting_run(modifier)
                check(record, (record['recipe_details_hand'] or {}).get('seconds_per_craft'), context)
                print(f"PASS: {context} - iron gear wheel {record['measured_per_cycle_seconds']:.4f} s per craft measured, "
                      f"{record['end_to_end_seconds_per_item']:.4f} s end to end ({record['end_to_end_ticks']} ticks for {record['count']}); "
                      f"formula {record['formula_seconds']:g} s = energy {record['engine']['gear_energy']:g} / "
                      f"({record['engine']['crafting_speed']:g} x {1 + modifier:g}); estimate {record['estimate_total_seconds']:g} s", flush=True)
            except Exception as exc:  # noqa: BLE001 - report every run
                failures[context] = str(exc)
                print(f'FAIL: {context} - {exc}', flush=True)
    finally:
        json_command(
            '/silent-command ' + find_actor +
            "remote.call('autorio_operations','cancel_all_tasks'); "
            'a.force.manual_mining_speed_modifier=0; a.force.manual_crafting_speed_modifier=0; '
            f"game.speed={fixture.get('previous_speed') or 1}; a.get_main_inventory().clear(); "
            f"for _,e in pairs(s.find_entities_filtered{{area={{{{{ox - 6},{oy - 6}}},{{{ox + 6},{oy + 6}}}}}}}) do "
            "if e.type~='character' then e.destroy() end end; rcon.print(helpers.table_to_json({cleaned=true}))",
            'hand work cleanup',
        )
    evidence['failures'] = failures
    require(not failures, {'failed_runs': sorted(failures)})
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
        (args.results / 'hand-work-rates-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
