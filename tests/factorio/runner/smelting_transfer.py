"""Real-Factorio regression for generic entity inventory transfer through early iron smelting."""
import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


TARGET_PLATES = 20
FUEL_COUNT = 5


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def recipe(details: dict, name: str) -> dict:
    require(details.get('found') is True, details)
    matched = next((value for value in details.get('recipes', []) if value.get('name') == name), None)
    require(matched is not None, details)
    return matched


def item_amount(parts: list[dict], name: str) -> float:
    part = next((value for value in parts if value.get('type') == 'item' and value.get('name') == name), None)
    require(part is not None, {'name': name, 'parts': parts})
    amount = part.get('amount')
    require(isinstance(amount, (int, float)) and amount > 0, part)
    return float(amount)


def entity_item_count(status: dict, item_name: str) -> int:
    entity = status.get('entity') if isinstance(status.get('entity'), dict) else status
    total = 0
    for inventory in entity.get('inventories') or []:
        for item in inventory.get('items') or []:
            if item.get('name') == item_name:
                total += int(item.get('count') or 0)
    return total


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({
            'elapsed_seconds': round(time.monotonic() - started, 3),
            'command': text,
            'response': response,
        })
        (results / 'smelting-transfer-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def actor_counts(context: str) -> dict:
        return json_command(
            "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
            "rcon.print(helpers.table_to_json({actor_id=a.unit_number,"
            "stone=a.get_item_count('stone'),coal=a.get_item_count('coal'),"
            "iron_ore=a.get_item_count('iron-ore'),stone_furnace=a.get_item_count('stone-furnace'),"
            "iron_plate=a.get_item_count('iron-plate'),position=a.position}))",
            context,
        )

    def entity_status(context: str) -> dict:
        return json_command(
            lua_json(remote_call('autorio_tools', 'get_entity_status', repr('stone-furnace'), '16')),
            context,
        )

    def operation_admission(expression: str, context: str) -> dict:
        # Autorio's established remote surface contains both scalar-boolean
        # admissions (for example mine_resource_at/place_entity) and
        # [boolean, message] admissions (for example supply/transfer/wait).
        # Normalize both shapes without changing production APIs.
        return json_command(
            "/silent-command local result=" + expression + "; "
            "local accepted=false; local message=nil; "
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            "else accepted=result==true end; "
            "rcon.print(helpers.table_to_json({accepted=accepted,message=message}))",
            f'{context} admission',
        )

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        admission = operation_admission(expression, context)
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        return wait_until_idle(operation_status, context, timeout)

    furnace_recipe = recipe(
        json_command(lua_json(remote_call('autorio_knowledge', 'recipe_details', repr('stone-furnace'))), 'stone furnace recipe'),
        'stone-furnace',
    )
    stone_needed = int(math.ceil(item_amount(furnace_recipe.get('ingredients') or [], 'stone')))

    plate_recipe = recipe(
        json_command(lua_json(remote_call('autorio_knowledge', 'recipe_details', repr('iron-plate'))), 'iron plate recipe'),
        'iron-plate',
    )
    plate_output = item_amount(plate_recipe.get('products') or [], 'iron-plate')
    ore_per_craft = item_amount(plate_recipe.get('ingredients') or [], 'iron-ore')
    crafts_needed = int(math.ceil(TARGET_PLATES / plate_output))
    ore_needed = int(math.ceil(crafts_needed * ore_per_craft))
    require(ore_needed > 0 and ore_needed <= 1000, {'ore_needed': ore_needed, 'recipe': plate_recipe})

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); local inv=a.get_main_inventory(); inv.clear(); "
        "local p=a.position; "
        "for _,e in pairs(s.find_entities_filtered{position=p,radius=10}) do if e~=a then e.destroy() end end; "
        "local tiles={}; for dx=-10,10 do for dy=-10,10 do tiles[#tiles+1]={name='landfill',position={x=math.floor(p.x)+dx,y=math.floor(p.y)+dy}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        f"local stone=s.create_entity{{name='stone',position={{x=p.x+1,y=p.y+1}},amount={stone_needed + 5}}}; "
        f"local coal=s.create_entity{{name='coal',position={{x=p.x-1,y=p.y+1}},amount={FUEL_COUNT + 5}}}; "
        f"local iron=s.create_entity{{name='iron-ore',position={{x=p.x+1,y=p.y-1}},amount={ore_needed + 5}}}; "
        "game.speed=4; "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,stone=stone and stone.position or nil,"
        "coal=coal and coal.position or nil,iron=iron and iron.position or nil,speed=game.speed}))",
        'smelting transfer fixture',
    )
    require(fixture.get('actor_id') == actor_id, fixture)
    require(fixture.get('stone') and fixture.get('coal') and fixture.get('iron'), fixture)

    for item_name, position, count in [
        ('stone', fixture['stone'], stone_needed),
        ('coal', fixture['coal'], FUEL_COUNT),
        ('iron-ore', fixture['iron'], ore_needed),
    ]:
        mining_timeout = max(40.0, float(count) * 3.0)
        run_operation(
            remote_call(
                'autorio_operations',
                'mine_resource_at',
                repr(item_name),
                repr(position['x']),
                repr(position['y']),
                str(count),
            ),
            f'mine {item_name} x{count}',
            mining_timeout,
        )

    mined = actor_counts('resources mined')
    require(mined['stone'] >= stone_needed, mined)
    require(mined['coal'] >= FUEL_COUNT, mined)
    require(mined['iron_ore'] >= ore_needed, mined)

    run_operation(
        remote_call('autorio_operations', 'craft_item', repr('stone-furnace'), '1'),
        'craft stone furnace',
        30.0,
    )
    crafted = actor_counts('stone furnace crafted')
    require(crafted['stone_furnace'] >= 1, crafted)

    placement = operation_admission(
        remote_call('autorio_operations', 'place_entity', repr('stone-furnace')),
        'place stone furnace',
    )
    require(placement.get('accepted') is True, placement)
    wait_until_idle(operation_status, 'place stone furnace', 20.0)

    furnace = entity_status('placed stone furnace status')
    require(furnace.get('found') is True, furnace)
    furnace_entity = furnace.get('entity') or {}
    unit_number = furnace_entity.get('unit_number')
    require(isinstance(unit_number, int) and unit_number > 0, furnace)

    supply = operation_admission(
        remote_call(
            'autorio_operations',
            'supply_entity',
            str(unit_number),
            "{{item_name='iron-ore',count=" + str(ore_needed) + "},{item_name='coal',count=" + str(FUEL_COUNT) + "}}",
        ),
        'supply furnace',
    )
    require(supply.get('accepted') is True, supply)
    supplied_status = wait_until_idle(operation_status, 'supply furnace', 20.0)
    supply_result = (supplied_status.get('basic_operation') or {}).get('last_result') or {}
    require(supply_result.get('completed') is True and supply_result.get('code') == 'completed', supplied_status)
    require((supply_result.get('moved_count') or 0) > 0, supplied_status)
    require(supply_result.get('target_unit_number') == unit_number and supply_result.get('to_entity') is True, supplied_status)

    after_supply = actor_counts('after furnace supply')
    require(after_supply['iron_ore'] == 0, after_supply)
    require(after_supply['coal'] == 0, after_supply)

    produced = entity_status('furnace production initial')
    max_wait_rounds = 20
    wait_ticks = 600
    for attempt in range(max_wait_rounds):
        if entity_item_count(produced, 'iron-plate') >= TARGET_PLATES:
            break
        run_operation(
            remote_call('autorio_operations', 'wait', str(wait_ticks)),
            f'wait for furnace production round {attempt + 1}',
            30.0,
        )
        produced = entity_status(f'furnace production round {attempt + 1}')

    produced_count = entity_item_count(produced, 'iron-plate')
    require(produced_count >= TARGET_PLATES, {
        'message': 'stone furnace did not produce target iron plates within bounded wait',
        'produced': produced_count,
        'furnace': produced,
    })

    before_retrieve = actor_counts('before plate retrieval')
    retrieve = operation_admission(
        remote_call(
            'autorio_operations',
            'move_items_exact',
            repr('iron-plate'),
            str(unit_number),
            str(TARGET_PLATES),
            'false',
        ),
        'retrieve iron plates',
    )
    require(retrieve.get('accepted') is True, retrieve)
    retrieved_status = wait_until_idle(operation_status, 'retrieve iron plates', 20.0)
    retrieve_result = (retrieved_status.get('basic_operation') or {}).get('last_result') or {}
    require(retrieve_result.get('accepted') is True and retrieve_result.get('completed') is True, retrieved_status)
    require(retrieve_result.get('code') == 'completed', retrieved_status)
    require(retrieve_result.get('item_name') == 'iron-plate', retrieved_status)
    require(retrieve_result.get('requested_count') == TARGET_PLATES, retrieved_status)
    require(retrieve_result.get('moved_count') == TARGET_PLATES, retrieved_status)
    require(retrieve_result.get('target_unit_number') == unit_number and retrieve_result.get('to_entity') is False, retrieved_status)

    final_actor = actor_counts('final actor inventory')
    require(final_actor['iron_plate'] >= before_retrieve['iron_plate'] + TARGET_PLATES, {
        'before': before_retrieve,
        'after': final_actor,
        'receipt': retrieve_result,
    })

    final_furnace = entity_status('final furnace inventory')
    require(entity_item_count(final_furnace, 'iron-plate') <= produced_count - TARGET_PLATES, {
        'before_output': produced_count,
        'after': final_furnace,
    })

    command('/silent-command game.speed=1; rcon.print("true")')
    (results / 'smelting-transfer.json').write_text(json.dumps({
        'status': 'pass',
        'actor_id': actor_id,
        'furnace_unit_number': unit_number,
        'stone_needed': stone_needed,
        'ore_needed': ore_needed,
        'fuel_count': FUEL_COUNT,
        'produced_before_retrieve': produced_count,
        'retrieve_receipt': retrieve_result,
        'final_actor': final_actor,
        'final_furnace': final_furnace,
        'transcript': transcript,
    }, indent=2))
    print(
        'PASS: zero-player NPC mined resources, crafted/placed a furnace, supplied it, '
        f'and retrieved {TARGET_PLATES} iron plates through generic inventory transfer with actor_id={actor_id}',
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
        (args.results / 'smelting-transfer-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
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
