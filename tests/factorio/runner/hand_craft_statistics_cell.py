#!/usr/bin/env python3
"""Engine proof: what Factorio records when the player-less NPC hand-crafts, and the
harness counter that makes `items_produced` goals about crafted items completable.

Found live (2026-09-29, docs/validation/LIVE_DEEPSEEK_FLASH_2026-09-29.md finding 8):
the NPC hand-crafted a stone furnace and the goal check `items_produced
stone-furnace >= 1` still read 0, while 12 smelted plates read 12.

Measured on 2.0.77 (Space Age loaded), a standalone `character` with no player:
    force item production statistics   the ingredients DO show up as output counts
                                       (3 stone furnaces: stone +15; 2 gears: iron
                                       plate +4), but the crafted products add 0 to the
                                       input counts, on every surface
    on_player_crafted_item             never fires (no LuaPlayer owns the character)
    on_pre_player_crafted_item         never fires either
So no engine-side number says "the NPC crafted X". The mod keeps its own per-force
counter (crafted_items.ts), credited only when the native crafting queue really
finishes a craft, and `evaluate_condition items_produced` adds it to the statistics.

Gates (each measured as a delta on `evaluate_condition items_produced`, the exact call
the harness uses for goal baselines and goal checks):
    ENGINE_STATISTICS   hand-crafted products add 0 to the engine's production
                         statistics and fire no craft event; the ingredients are recorded.
                         This is the sentinel for the double-count risk: if a future
                         engine starts recording them, this gate fails and the counter
                         must go.
    HAND_CRAFT_COUNTED  K stone furnaces crafted by craft_item add exactly K
    YIELD_AND_PREREQ    transport belts (2 per craft, gear prerequisite crafted by the
                         engine) add belts and gears in step with the real inventory
    SMELTING_ONCE       plates smelted in a furnace add to the statistics once and add
                         nothing to the hand-craft counter
    CANCEL_NEVER_STARTED / CANCEL_STARTED   a craft cancelled before any craft finished
                         adds 0; one cancelled part way adds exactly the crafts the
                         inventory shows, and nothing after the cancel
"""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, remote_call
from runtime import operation_status_command, wait_until_idle

FURNACES = 3
BELT_CRAFTS = 2
BELTS_PER_CRAFT = 2
ORE = 2
GEARS_CANCELLED_MID = 6
SURFACE_STATISTICS_ITEMS = ('stone-furnace', 'stone', 'iron-gear-wheel', 'iron-plate', 'transport-belt')


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'scenario': 'hand-craft-statistics', 'gates': {}}

    def flush() -> None:
        evidence['transcript'] = transcript[-200:]
        (results / 'hand-craft-statistics-cell.json').write_text(json.dumps(evidence, indent=2))

    def json_command(text: str, context: str) -> Any:
        response = client.command(text)
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
    items_lua = '{' + ','.join(f"'{n}'" for n in SURFACE_STATISTICS_ITEMS) + '}'

    def observe(context: str) -> dict:
        """Everything the gates compare: the harness evaluator, the raw engine
        statistics summed over surfaces, the craft-event probe and the inventory."""
        return json_command(
            '/silent-command ' + find_actor +
            "local force=a.force; local inv=a.get_main_inventory(); local out={stats={},evaluator={},inventory={}}; "
            f"for _,n in ipairs({items_lua}) do "
            "local i,o=0,0; for _,sf in pairs(game.surfaces) do local st=force.get_item_production_statistics(sf); "
            "i=i+st.get_input_count(n); o=o+st.get_output_count(n) end "
            "out.stats[n]={input=i,output=o}; "
            "out.evaluator[n]=remote.call('autorio_tools','evaluate_condition',{kind='items_produced',item_name=n,minimum=1}); "
            "out.inventory[n]=inv.get_item_count(n) end; "
            "out.probe=storage.hand_craft_probe; out.tick=game.tick; out.queue=#(a.crafting_queue or {}); "
            "rcon.print(helpers.table_to_json(out))",
            context,
        )

    def delta(before: dict, after: dict, item: str) -> dict:
        return {
            'stat_input': after['stats'][item]['input'] - before['stats'][item]['input'],
            'stat_output': after['stats'][item]['output'] - before['stats'][item]['output'],
            'evaluator_current': after['evaluator'][item]['current'] - before['evaluator'][item]['current'],
            'production_statistics': after['evaluator'][item]['production_statistics'] - before['evaluator'][item]['production_statistics'],
            'hand_crafted': after['evaluator'][item]['hand_crafted'] - before['evaluator'][item]['hand_crafted'],
            'inventory': after['inventory'][item] - before['inventory'][item],
        }

    def admit(item: str, count: int, context: str) -> None:
        admission = json_command(
            '/silent-command local r=' + remote_call('autorio_operations', 'craft_item', repr(item), str(count)) +
            '; rcon.print(helpers.table_to_json({accepted=r[1],message=r[2]}))',
            f'{context} admission',
        )
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})

    def craft_and_wait(item: str, count: int, context: str) -> None:
        admit(item, count, context)
        wait_until_idle(operation_status, context, 60)

    def cancel_all() -> None:
        json_command("/silent-command remote.call('autorio_operations','cancel_all_tasks'); rcon.print(helpers.table_to_json({ok=true}))", 'cancel')

    def wait_ticks(count: int) -> None:
        start = json_command('/silent-command rcon.print(helpers.table_to_json({tick=game.tick}))', 'tick')['tick']
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            now = json_command('/silent-command rcon.print(helpers.table_to_json({tick=game.tick}))', 'tick')['tick']
            if now - start >= count:
                return
            time.sleep(0.02)
        raise AssertionError('the simulation did not advance')

    fixture = json_command(
        '/silent-command ' + find_actor +
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-6,oy-6},{ox+6,oy+6}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-6,ox+6 do for y=oy-6,oy+6 do tiles[#tiles+1]={name=\'landfill\',position={x,y}} end end; '
        's.set_tiles(tiles,true,false,true); '
        'a.force.manual_crafting_speed_modifier=0; a.character_crafting_speed_modifier=0; '
        # Hand crafting recipes the fixture needs; which recipes a fresh save
        # has unlocked is not what this cell measures.
        "for _,r in ipairs({'stone-furnace','iron-gear-wheel','transport-belt'}) do a.force.recipes[r].enabled=true end; "
        'a.get_main_inventory().clear(); '
        f"a.get_main_inventory().insert{{name='stone',count={FURNACES * 5 + 10}}}; "
        "a.get_main_inventory().insert{name='iron-plate',count=120}; "
        "a.get_main_inventory().insert{name='coal',count=10}; "
        f"a.get_main_inventory().insert{{name='iron-ore',count={ORE}}}; "
        'local previous_speed=game.speed; game.speed=1; '
        # Craft-event probe: a handler in the command scope counts any craft event.
        'storage.hand_craft_probe={crafted=0,pre=0}; '
        'script.on_event(defines.events.on_player_crafted_item,function() storage.hand_craft_probe.crafted=storage.hand_craft_probe.crafted+1 end); '
        'script.on_event(defines.events.on_pre_player_crafted_item,function() storage.hand_craft_probe.pre=storage.hand_craft_probe.pre+1 end); '
        "rcon.print(helpers.table_to_json({ox=ox,oy=oy,previous_speed=previous_speed,connected=#game.connected_players}))",
        'hand craft fixture',
    )
    require(fixture.get('connected') == 0, fixture)
    ox, oy = fixture['ox'], fixture['oy']
    evidence['fixture'] = fixture

    failures: dict[str, str] = {}

    def gate(name: str, body) -> None:
        try:
            summary = body()
            evidence['gates'][name] = summary
            flush()
            print(f'PASS: {name} - {summary}', flush=True)
        except Exception as exc:  # noqa: BLE001 - report every gate
            failures[name] = str(exc)
            print(f'FAIL: {name} - {exc}', flush=True)

    def engine_statistics_and_counted() -> str:
        before = observe('before stone furnaces')
        craft_and_wait('stone-furnace', FURNACES, 'hand craft stone furnaces')
        after = observe('after stone furnaces')
        furnace = delta(before, after, 'stone-furnace')
        stone = delta(before, after, 'stone')
        evidence['stone_furnace_craft'] = {'furnace': furnace, 'stone': stone, 'probe': after['probe']}
        require(furnace['inventory'] == FURNACES, {'message': 'the furnaces were not really crafted', 'furnace': furnace})
        # ENGINE_STATISTICS: the products never reach the engine's statistics.
        require(furnace['stat_input'] == 0 and furnace['stat_output'] == 0,
                {'message': 'the engine now records hand-crafted products: drop the harness counter or it double counts', 'furnace': furnace})
        require(stone['stat_output'] == FURNACES * 5, {'message': 'ingredient consumption is expected in the statistics', 'stone': stone})
        require(after['probe'] == {'crafted': 0, 'pre': 0}, {'message': 'a craft event fired for the player-less character', 'probe': after['probe']})
        # HAND_CRAFT_COUNTED
        require(furnace['evaluator_current'] == FURNACES and furnace['hand_crafted'] == FURNACES and furnace['production_statistics'] == 0,
                {'message': 'items_produced did not count the crafted furnaces exactly once', 'furnace': furnace})
        return (f"stone-furnace x{FURNACES}: engine input {furnace['stat_input']} (output {furnace['stat_output']}), stone output "
                f"{stone['stat_output']}, craft events {after['probe']}, items_produced +{furnace['evaluator_current']}")

    def yield_and_prerequisites() -> str:
        before = observe('before belts')
        craft_and_wait('transport-belt', BELT_CRAFTS, 'hand craft transport belts')
        after = observe('after belts')
        belt = delta(before, after, 'transport-belt')
        gear = delta(before, after, 'iron-gear-wheel')
        evidence['belt_craft'] = {'belt': belt, 'gear': gear}
        require(belt['inventory'] == BELT_CRAFTS * BELTS_PER_CRAFT, {'message': 'unexpected belt yield', 'belt': belt})
        require(belt['evaluator_current'] == belt['inventory'] and belt['hand_crafted'] == belt['inventory'], {'message': 'belts not counted at the recipe yield', 'belt': belt})
        # The gears were crafted by the engine as prerequisites and used up by the belts.
        require(gear['inventory'] == 0 and gear['hand_crafted'] == BELT_CRAFTS and gear['production_statistics'] == 0,
                {'message': 'prerequisite gear crafts were not counted', 'gear': gear})
        return f"transport-belt +{belt['evaluator_current']} (inventory +{belt['inventory']}), prerequisite gears +{gear['hand_crafted']}"

    def smelting_once() -> str:
        before = observe('before smelting')
        json_command(
            '/silent-command ' + find_actor +
            f"local f=s.create_entity{{name='stone-furnace',position={{{ox + 3},{oy + 0.5}}},force=a.force}}; assert(f); "
            "f.get_fuel_inventory().insert{name='coal',count=2}; "
            f"f.get_inventory(defines.inventory.furnace_source).insert{{name='iron-ore',count={ORE}}}; "
            "a.get_main_inventory().remove{name='iron-ore',count=" + str(ORE) + "}; rcon.print(helpers.table_to_json({ok=true}))",
            'place furnace',
        )
        deadline = time.monotonic() + 60
        plates = 0
        while time.monotonic() < deadline:
            plates = json_command(
                '/silent-command ' + find_actor +
                f"local f=s.find_entities_filtered{{name='stone-furnace',position={{{ox + 3},{oy + 0.5}}},radius=1}}[1]; "
                "rcon.print(helpers.table_to_json({plates=f.get_output_inventory().get_item_count('iron-plate')}))",
                'furnace output',
            )['plates']
            if plates >= ORE:
                break
            time.sleep(0.2)
        require(plates >= ORE, {'message': 'the furnace did not smelt in time', 'plates': plates})
        after = observe('after smelting')
        plate = delta(before, after, 'iron-plate')
        evidence['smelting'] = plate
        # The 120 plates in the inventory were only used as ingredients; nothing new
        # arrived there. What the furnace produced is the statistics' input.
        require(plate['stat_input'] == ORE and plate['production_statistics'] == ORE and plate['hand_crafted'] == 0 and plate['evaluator_current'] == ORE,
                {'message': 'smelted plates must count once, from the statistics only', 'plate': plate})
        return f"iron-plate smelted +{plate['evaluator_current']} (statistics {plate['production_statistics']}, hand-crafted {plate['hand_crafted']})"

    def cancelled_never_started() -> str:
        before = observe('before never-started cancel')
        admit('iron-gear-wheel', GEARS_CANCELLED_MID, 'never-started gear craft')
        cancel_all()  # same game tick: the request is dropped before its native queue exists
        wait_ticks(10)
        after = observe('after never-started cancel')
        gear = delta(before, after, 'iron-gear-wheel')
        require(gear['evaluator_current'] == 0 and gear['inventory'] == 0 and after['queue'] == 0, {'message': 'a craft that never started was counted', 'gear': gear})
        return f"gear +{gear['evaluator_current']} counted, inventory +{gear['inventory']}"

    def cancelled_started() -> str:
        before = observe('before cancel')
        admit('iron-gear-wheel', GEARS_CANCELLED_MID, 'gear craft cancelled part way')
        # Cancel once the engine has really finished at least two crafts.
        deadline = time.monotonic() + 30
        seen = 0
        while time.monotonic() < deadline:
            snapshot = json_command(
                '/silent-command ' + find_actor +
                "rcon.print(helpers.table_to_json({gears=a.get_main_inventory().get_item_count('iron-gear-wheel'),queue=#(a.crafting_queue or {})}))",
                'watch crafts',
            )
            seen = snapshot['gears'] - before['inventory']['iron-gear-wheel']
            if seen >= 2:
                break
            time.sleep(0.01)
        require(seen >= 2, {'message': 'no craft finished in time', 'seen': seen})
        cancel_all()
        wait_ticks(10)
        after = observe('after cancel')
        gear = delta(before, after, 'iron-gear-wheel')
        evidence['cancel_mid'] = gear
        require(after['queue'] == 0, {'message': 'the native queue is not empty after the cancel', 'queue': after['queue']})
        require(2 <= gear['inventory'] < GEARS_CANCELLED_MID, {'message': 'the cancel should stop part way', 'gear': gear})
        # Exactly the crafts the inventory proves, none of the cancelled ones.
        require(gear['evaluator_current'] == gear['inventory'] and gear['production_statistics'] == 0,
                {'message': 'counted crafts differ from what the engine finished', 'gear': gear})
        wait_ticks(120)
        settled = observe('settled after cancel')
        require(delta(after, settled, 'iron-gear-wheel')['evaluator_current'] == 0, 'the counter kept moving after the cancel')
        return f"gear x{GEARS_CANCELLED_MID} cancelled part way: {gear['inventory']} finished and counted, {GEARS_CANCELLED_MID - gear['inventory']} cancelled and not counted"

    try:
        gate('ENGINE_STATISTICS + HAND_CRAFT_COUNTED', engine_statistics_and_counted)
        gate('YIELD_AND_PREREQ', yield_and_prerequisites)
        gate('SMELTING_ONCE', smelting_once)
        gate('CANCEL_NEVER_STARTED', cancelled_never_started)
        gate('CANCEL_STARTED', cancelled_started)
    finally:
        json_command(
            '/silent-command ' + find_actor +
            "remote.call('autorio_operations','cancel_all_tasks'); "
            f"game.speed={fixture.get('previous_speed') or 1}; a.get_main_inventory().clear(); "
            f"for _,e in pairs(s.find_entities_filtered{{area={{{{{ox - 6},{oy - 6}}},{{{ox + 6},{oy + 6}}}}}}}) do "
            "if e.type~='character' then e.destroy() end end; rcon.print(helpers.table_to_json({cleaned=true}))",
            'hand craft cleanup',
        )
    evidence['failures'] = failures
    require(not failures, {'failed_gates': failures})
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
        (args.results / 'hand-craft-statistics-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
