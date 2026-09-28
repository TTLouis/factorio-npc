"""Verify owned/result semantics for mine, place, move and wait operations."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def receipt(status: dict) -> dict:
    basic = status.get('basic_operation') or {}
    return basic.get('last_result') or {}


def assert_receipt(status: dict, *, actor_id: int, code: str, completed: bool, op_type: str | None = None) -> dict:
    validate_clock(status['runtime'])
    require(status['runtime']['connected_players'] == 0, status)
    result = receipt(status)
    require(result.get('code') == code, status)
    require(result.get('completed') is completed, status)
    require(result.get('accepted') is completed, status)
    require(result.get('actor_id') == actor_id, status)
    require(isinstance(result.get('operation_id'), int) and result['operation_id'] > 0, status)
    if op_type is not None:
        require(result.get('type') == op_type, status)
    return result


def assert_failed_batch(status: dict, *, actor_id: int, code: str, op_type: str) -> dict:
    require(status['task_state'] == 'idle' and status['queue_empty'] is True and status['queue_length'] == 0, status)
    return assert_receipt(status, actor_id=actor_id, code=code, completed=False, op_type=op_type)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'basic-outcomes-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def queue_bool_with_dependent(operation: str, context: str) -> dict:
        # Queue both operations in one Lua/RCON command. If the failure-capable
        # operation and its dependent are sent as separate RCON commands, a game
        # tick can run between them: the first task can fail before the second is
        # queued, turning the supposed dependent into fresh standalone work.
        payload = json_command(
            f"/silent-command local op={operation}; local dep={remote_call('autorio_operations', 'wait', '300')}; "
            "rcon.print(helpers.table_to_json({operation=op,dependent=dep}))",
            context,
        )
        require(payload.get('operation') is True, payload)
        require(payload.get('dependent')[0] is True, payload)
        return payload

    def queue_tuple_with_dependent(operation: str, context: str) -> dict:
        payload = json_command(
            f"/silent-command local op={operation}; local dep={remote_call('autorio_operations', 'wait', '300')}; "
            "rcon.print(helpers.table_to_json({operation=op,dependent=dep}))",
            context,
        )
        require(payload.get('operation')[0] is True, payload)
        require(payload.get('dependent')[0] is True, payload)
        return payload

    initial = status('basic outcomes initial')
    require(initial['actor']['actor_id'] == actor_id, initial)
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    validate_clock(initial['runtime'])

    # Knowledge/preflight regressions must exercise the real Factorio runtime API,
    # not only TypeScript mocks. Factorio 2 recipe details are queried through
    # Autorio's public knowledge contract and must not assume LuaRecipe.categories.
    for recipe_name in ('burner-mining-drill', 'iron-gear-wheel'):
        details = json_command(
            lua_json(remote_call('autorio_knowledge', 'recipe_details', repr(recipe_name))),
            f'recipe details {recipe_name}',
        )
        require(details.get('found') is True, details)
        matched = next((recipe for recipe in details.get('recipes', []) if recipe.get('name') == recipe_name), None)
        require(matched is not None, details)
        require(isinstance(matched.get('categories'), list) and len(matched['categories']) > 0, matched)
        require(isinstance(matched.get('ingredients'), list) and len(matched['ingredients']) > 0, matched)
        require(isinstance(matched.get('products'), list) and len(matched['products']) > 0, matched)

    guessed_craft = json_command(
        lua_json(remote_call('autorio_preflight', 'operation', repr('craft_item'), "{item_name='iron-mining-drill',count=1}")),
        'unknown craft identity preflight',
    )
    require(guessed_craft.get('ok') is False and guessed_craft.get('code') == 'unknown_recipe', guessed_craft)

    tree_resource = json_command(
        lua_json(remote_call('autorio_preflight', 'operation', repr('gather_resource'), "{resource_name='tree-02-red',count=4,search_radius=64}")),
        'tree resource identity preflight',
    )
    require(tree_resource.get('ok') is False and tree_resource.get('code') == 'invalid_target_kind', tree_resource)
    require(tree_resource.get('expected_type') == 'resource' and tree_resource.get('observed_type') == 'tree', tree_resource)

    # Curated early-game skills must exist in the real Factorio storage/runtime,
    # not only in TypeScript fixtures. They remain manual candidate patterns:
    # useful planning guidance, never live-world authority.
    skills = json_command(
        lua_json(remote_call('autorio_skills', 'list')),
        'curated skill seed',
    )
    require(isinstance(skills, list), skills)
    skill_ids = {skill.get('id') for skill in skills if isinstance(skill, dict)}
    expected_basic_skills = {
        'missing-item-bootstrap',
        'burner-coal-loop',
        'direct-miner-smelting',
        'starter-smelting-row',
        'two-item-half-belt',
        'belt-side-load-merge',
        'direct-insertion-chain',
        'steam-power-bootstrap',
        'starter-mining-belt-output',
        'automation-science-bootstrap',
    }
    require(expected_basic_skills.issubset(skill_ids), {'skills': sorted(skill_ids)})

    coal_skills = json_command(
        lua_json(remote_call('autorio_skills', 'find', repr('coal snake'), '3')),
        'curated skill search',
    )
    require(coal_skills.get('ok') is True, coal_skills)
    require(len(coal_skills.get('results') or []) > 0, coal_skills)
    require(coal_skills['results'][0].get('id') == 'burner-coal-loop', coal_skills)

    # Plan 2.8: the harness-offered cards run the precondition checks against
    # the real force/inventory (technology lookup, held items, entity types).
    steam_offer = json_command(
        lua_json(remote_call('autorio_skills', 'offer', "{goal='get steam power running for electricity',limit=5}")),
        'curated skill offer',
    )
    require(steam_offer.get('ok') is True, steam_offer)
    steam_cards = steam_offer.get('cards') or []
    require(isinstance(steam_cards, list) and 0 < len(steam_cards) <= 5, steam_offer)
    require(steam_cards[0].get('id') == 'steam-power-bootstrap', steam_offer)
    require(isinstance(steam_cards[0].get('unmet'), (list, dict)), steam_offer)

    coal_skill = json_command(
        lua_json(remote_call('autorio_skills', 'get', repr('burner-coal-loop'))),
        'curated skill details',
    )
    require(coal_skill.get('source', {}).get('kind') == 'manual', coal_skill)
    require(coal_skill.get('status') == 'candidate' and coal_skill.get('stage') == 'pattern', coal_skill)
    require(coal_skill.get('verification', {}).get('production_output') == 'not_tested', coal_skill)

    # 1. Bounded wait is actor-owned and must produce a concrete completion
    # receipt instead of relying on generic idle.
    wait_admission = json_command(lua_json(remote_call('autorio_operations', 'wait', '30')), 'basic wait admission')
    require(wait_admission[0] is True, wait_admission)
    wait_after = wait_until_idle(status, 'basic owned wait', 5)
    wait_result = assert_receipt(wait_after, actor_id=actor_id, code='completed', completed=True, op_type='waiting')
    require(wait_result.get('requested_ticks') == 30, wait_result)

    # 2. A valid entity prototype that is absent nearby is a normal no_target
    # failure. It must cancel work that was already queued behind it without
    # crashing or silently advancing the batch.
    queue_bool_with_dependent(
        remote_call('autorio_operations', 'mine_entity', repr('lab'), '1'),
        'mine failure batch admission',
    )
    mine_after = wait_until_idle(status, 'missing mining target failure', 5)
    mine_result = assert_failed_batch(mine_after, actor_id=actor_id, code='no_target', op_type='mining')
    require(mine_result.get('entity_name') == 'lab', mine_result)

    # 3. Unknown prototype names must fail closed before Factorio receives them
    # in find_entities_filtered. Factorio treats an unknown name there as a
    # non-recoverable mod error, so this is a process-safety boundary.
    queue_bool_with_dependent(
        remote_call('autorio_operations', 'mine_entity', repr('__airi_missing_resource__'), '1'),
        'invalid mine batch admission',
    )
    invalid_after = wait_until_idle(status, 'invalid mining prototype failure', 5)
    invalid_result = assert_failed_batch(invalid_after, actor_id=actor_id, code='invalid_entity', op_type='mining')
    require(invalid_result.get('entity_name') == '__airi_missing_resource__', invalid_result)

    # 4. Valid place prototype but no item in inventory: fail and cancel the
    # already-queued dependent rather than reporting batch completion.
    fixture = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); local inv=a.get_main_inventory(); inv.clear(); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,steel=inv.get_item_count('steel-chest'),tick=game.tick}))",
        'basic outcome inventory fixture',
    )
    require(fixture['actor_id'] == actor_id and fixture['steel'] == 0, fixture)
    queue_bool_with_dependent(
        remote_call('autorio_operations', 'place_entity', repr('steel-chest')),
        'place failure batch admission',
    )
    place_after = wait_until_idle(status, 'missing placement item failure', 5)
    place_result = assert_failed_batch(place_after, actor_id=actor_id, code='item_missing', op_type='placing')
    require(place_result.get('entity_name') == 'steel-chest', place_result)

    # 5. An empty source chest is a real transfer failure. Keep one exact chest
    # nearby so this specifically proves nothing_moved rather than no_target.
    chest = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{name='steel-chest',position=a.position,radius=8}) do e.destroy() end; "
        "local p=s.find_non_colliding_position('steel-chest',{x=a.position.x+2,y=a.position.y},6,0.5); assert(p); "
        "local c=s.create_entity{name='steel-chest',position=p,force=a.force}; assert(c); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,chest_id=c.unit_number,position=c.position}))",
        'empty transfer source fixture',
    )
    require(chest['actor_id'] == actor_id, chest)
    queue_tuple_with_dependent(
        remote_call('autorio_operations', 'move_items', repr('iron-plate'), repr('steel-chest'), '5', 'false'),
        'move failure batch admission',
    )
    move_after = wait_until_idle(status, 'nothing moved failure', 5)
    move_result = assert_failed_batch(move_after, actor_id=actor_id, code='nothing_moved', op_type='moving_items')
    require(move_result.get('item_name') == 'iron-plate' and move_result.get('moved_count') == 0, move_result)

    # 6. Actor-mode transition is an ownership boundary. Start owned work on the
    # NPC, switch to player mode while no human exists, and require cancellation
    # before returning to the same persisted NPC body.
    active_wait = json_command(lua_json(remote_call('autorio_operations', 'wait', '600')), 'mode switch active wait')
    require(active_wait[0] is True, active_wait)
    dependent = json_command(lua_json(remote_call('autorio_operations', 'wait', '300')), 'mode switch queued wait')
    require(dependent[0] is True, dependent)
    before_switch = status('mode switch before')
    require(before_switch['task_state'] == 'waiting' and before_switch['queue_length'] == 1, before_switch)
    active_operation_id = before_switch['current_task']['operation_id'] if 'operation_id' in before_switch['current_task'] else None

    switched_player = json_command(lua_json(remote_call('autorio_actor', 'set_mode', repr('player'))), 'switch to player mode')
    require(switched_player[0] is True, switched_player)
    player_mode = status('after switch to player')
    require(player_mode.get('actor') is None, player_mode)
    require(player_mode['task_state'] == 'idle' and player_mode['queue_length'] == 0, player_mode)
    cancelled = receipt(player_mode)
    require(cancelled.get('code') == 'cancelled' and cancelled.get('actor_id') == actor_id, player_mode)
    if active_operation_id is not None:
        require(cancelled.get('operation_id') == active_operation_id, player_mode)

    switched_npc = json_command(lua_json(remote_call('autorio_actor', 'set_mode', repr('npc'))), 'switch back to npc mode')
    require(switched_npc[0] is True, switched_npc)
    restored = status('after switch back to npc')
    require(restored['actor']['actor_id'] == actor_id and restored['actor']['kind'] == 'standalone_character', restored)
    require(restored['task_state'] == 'idle' and restored['queue_length'] == 0, restored)

    fresh = json_command(lua_json(remote_call('autorio_operations', 'wait', '10')), 'fresh wait after mode switch')
    require(fresh[0] is True, fresh)
    final = wait_until_idle(status, 'fresh wait after mode switch', 5)
    assert_receipt(final, actor_id=actor_id, code='completed', completed=True, op_type='waiting')

    payload = {
        'status': 'pass',
        'actor_id': actor_id,
        'wait': {'status': wait_after, 'result': wait_result},
        'mining_failure': {'status': mine_after, 'result': mine_result},
        'invalid_entity_failure': {'status': invalid_after, 'result': invalid_result},
        'placement_failure': {'status': place_after, 'result': place_result},
        'transfer_failure': {'status': move_after, 'result': move_result},
        'mode_switch': {'before': before_switch, 'player_mode': player_mode, 'restored': restored, 'final': final},
    }
    (results / 'basic-outcomes.json').write_text(json.dumps(payload, indent=2))
    print(
        f'PASS: zero-player NPC basic operations produced owned outcomes and cancelled failed dependent work with actor_id={actor_id}',
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
        (args.results / 'basic-outcomes-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
