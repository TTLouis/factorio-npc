"""Kill the active standalone NPC and prove bounded, ownership-safe recovery."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, lua_text, remote_call, squared_distance
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def assert_recovered(before: dict, after: dict) -> None:
    validate_clock(after['runtime'])
    require(after['runtime']['tick'] > before['runtime']['tick'], (before, after))
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['valid'] is True and after['actor']['kind'] == 'standalone_character', after)
    require(after['actor']['actor_id'] != before['actor']['actor_id'], (before, after))
    require(after['force_index'] == before['force_index'], (before, after))
    require(after['character_count'] == 1 and after['old_actor_alive'] is False, after)
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)
    require(after['walking'] is False and after['mining'] is False and after['shooting'] is False, after)
    require(after['iron'] == 0 and after['copper'] == 0, after)
    require(after['old_target_alive'] is True, after)

    recovery = after.get('death_recovery') or {}
    require(recovery.get('policy') == 'discard_autorio_tasks_and_create_empty_replacement', recovery)
    require(recovery.get('pending_from_actor_id') is None, recovery)
    result = recovery.get('last_result') or {}
    require(result.get('reason') == 'missing_persisted_actor', recovery)
    require(result.get('previous_actor_id') == before['actor']['actor_id'], recovery)
    require(result.get('replacement_actor_id') == after['actor']['actor_id'], recovery)
    require(result.get('force_index') == before['force_index'], recovery)
    require(result.get('inventory_policy') == 'no_transfer', recovery)
    require(isinstance(result.get('tick'), int), recovery)


def assert_navigation_reached(navigation: dict, actor_id: int, target_id: int) -> None:
    result = navigation.get('last_result') or {}
    require(navigation.get('task_active') is False, navigation)
    require(result.get('accepted') is True and result.get('completed') is True, navigation)
    require(result.get('code') == 'reached', navigation)
    require(result.get('actor_id') == actor_id, navigation)
    require(result.get('target_unit_number') == target_id, navigation)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    persisted = json.loads((results / 'persistence.json').read_text())
    original_id = persisted['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'death-recovery-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    initial = json_command(operation_status_command(), 'death recovery initial status')
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    require(initial['actor']['actor_id'] == original_id, initial)

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "for _,e in pairs(s.find_entities_filtered{name='stone-furnace',position=a.position,radius=50}) do e.destroy() end; "
        "local tiles={}; local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); "
        "for x=x0-3,x0+35 do for y=y0-4,y0+4 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local inv=a.get_main_inventory(); assert(inv); inv.clear(); "
        "assert(inv.insert{name='iron-plate',count=23}==23); assert(inv.insert{name='copper-plate',count=11}==11); "
        "local guns=a.get_inventory(defines.inventory.character_guns); guns.clear(); guns.insert{name='pistol',count=1}; "
        "local ammo=a.get_inventory(defines.inventory.character_ammo); ammo.clear(); ammo.insert{name='firearm-magazine',count=3}; ammo[1].drain_ammo(2); "
        "local target=s.create_entity{name='stone-furnace',position={x=a.position.x+25,y=a.position.y},force=a.force}; assert(target); "
        "rcon.print(helpers.table_to_json({actor={valid=a.valid,kind='standalone_character',actor_id=a.unit_number},"
        "runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players},"
        "force_index=a.force.index,iron=inv.get_item_count('iron-plate'),copper=inv.get_item_count('copper-plate'),"
        "target_id=target.unit_number,target_position=target.position,position=a.position}))",
        'death recovery fixture',
    )
    require(fixture['iron'] == 23 and fixture['copper'] == 11, fixture)

    start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('stone-furnace'), '40')))
    require(start == 'true', f'death-recovery movement start failed: {start!r}')
    queued = json_command(
        "/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_operations','wait',300)))",
        'death recovery queued wait',
    )
    require(queued[0] is True, queued)

    def active_observation() -> dict:
        return json_command(
            "/silent-command local s=game.surfaces[1]; local a=nil; "
            "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={original_id} then a=e end end; assert(a); "
            "local o=remote.call('autorio_operations','status'); "
            "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
            "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
            "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
            "local inv=a.get_main_inventory(); o.force_index=a.force.index; o.position=a.position; "
            "o.iron=inv.get_item_count('iron-plate'); o.copper=inv.get_item_count('copper-plate'); "
            f"o.target_id={fixture['target_id']}; rcon.print(helpers.table_to_json(o))",
            'active death recovery observation',
        )

    deadline = time.monotonic() + 12.0
    before = None
    while time.monotonic() < deadline:
        candidate = active_observation()
        validate_clock(candidate['runtime'])
        if candidate['task_state'] in ('walking_to_entity', 'walking_direct') and candidate['walking'] is True:
            before = candidate
            break
        time.sleep(0.1)
    require(before is not None, 'NPC never entered active walking before death')
    require(before['queue_length'] == 1 and before['queued_task_types'] == ['waiting'], before)
    require(before['iron'] == 23 and before['copper'] == 11, before)
    require(before['runtime']['connected_players'] == 0, before)

    death = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'NPC disappeared before death fixture'); "
        "local ok=a.die(game.forces.enemy); rcon.print(helpers.table_to_json({died=ok,old_valid=a.valid,tick=game.tick}))",
        'NPC death',
    )
    require(death['died'] is True and death['old_valid'] is False, death)

    observation_command = (
        "/silent-command local s=game.surfaces[1]; "
        "local actor_status=remote.call('autorio_actor','status'); local o=remote.call('autorio_operations','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.death_recovery=actor_status.death_recovery; local a=nil; local chars=s.find_entities_filtered{name='character'}; "
        "if actor_status.actor then for _,e in pairs(chars) do if e.unit_number==actor_status.actor.actor_id then a=e end end end; "
        "o.character_count=#chars; o.old_actor_alive=false; "
        f"for _,e in pairs(chars) do if e.unit_number=={original_id} then o.old_actor_alive=true end end; "
        "if a then local inv=a.get_main_inventory(); o.force_index=a.force.index; o.position=a.position; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
        "o.iron=inv.get_item_count('iron-plate'); o.copper=inv.get_item_count('copper-plate') end; "
        f"local target=nil; for _,e in pairs(s.find_entities_filtered{{name='stone-furnace'}}) do if e.unit_number=={fixture['target_id']} then target=e end end; "
        "o.old_target_alive=target~=nil and target.valid; o.old_target_position=target and target.position or nil; "
        "o.corpse_count=#s.find_entities_filtered{type='character-corpse'}; rcon.print(helpers.table_to_json(o))"
    )

    def observe(context: str) -> dict:
        return json_command(observation_command, context)

    recovered = observe('post-death recovery observation')
    assert_recovered(before, recovered)
    require(recovered['corpse_count'] >= 1, recovered)

    replacement_id = recovered['actor']['actor_id']
    position = recovered['position']
    time.sleep(2.0)
    quiet = observe('post-death quiet observation')
    assert_recovered(before, quiet)
    require(quiet['actor']['actor_id'] == replacement_id, quiet)
    require(squared_distance(position, quiet['position']) < 0.01, (position, quiet['position']))

    fresh_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local actor_status=remote.call('autorio_actor','status'); local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do if e.unit_number==actor_status.actor.actor_id then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position=a.position,radius=25}) do e.destroy() end; "
        "local tiles={}; local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); "
        "for x=x0-2,x0+15 do for y=y0-3,y0+3 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); local t=s.create_entity{name='wooden-chest',position={x=a.position.x+10,y=a.position.y},force=a.force}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,position=t.position,actor_position=a.position}))",
        'post-recovery movement fixture',
    )
    fresh_start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('wooden-chest'), '20')))
    require(fresh_start == 'true', f'post-recovery movement start failed: {fresh_start!r}')

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    completed = wait_until_idle(status, 'post-death recovery movement', 20)
    require(completed['actor']['actor_id'] == replacement_id, completed)
    require(completed['queue_empty'] is True and completed['queue_length'] == 0, completed)

    navigation = json_command(
        lua_json(remote_call('autorio_navigation', 'status')),
        'post-death recovery navigation result',
    )
    assert_navigation_reached(navigation, replacement_id, fresh_fixture['id'])

    final = observe('post-death final observation')
    assert_recovered(before, final)
    require(final['actor']['actor_id'] == replacement_id, final)
    # Match the bounded navigation arrival contract and require the exact
    # target-bound `reached` receipt above; idle by itself is insufficient.
    require(squared_distance(final['position'], fresh_fixture['position']) <= 9.0, (final, fresh_fixture, navigation))

    corpses = json_command(lua_json(remote_call('autorio_corpse_recovery', 'status')), 'native corpse registry')
    owned = [entry for entry in corpses['corpses'] if entry['previous_actor_id'] == original_id]
    require(len(owned) == 1 and owned[0]['state'] == 'available', corpses)
    corpse_ref = owned[0]['corpse_ref']
    recovery_ordinals: dict[str, int] = {}

    def retrieve(request_id: str, slots: int = 16, count: int = 1000) -> dict:
        recovery_ordinals.setdefault(request_id, len(recovery_ordinals) + 1)
        return json_command(lua_json(remote_call('autorio_operations', 'recover_corpse', repr(corpse_ref), str(slots), str(count), str(replacement_id), repr(request_id), str(recovery_ordinals[request_id]))), request_id)

    unarmed = retrieve('corpse-unarmed')
    require(unarmed['accepted'] is False and unarmed['reason'] == 'compatible_weapon_and_ammo_required', unarmed)
    # Declared combat fixture only: these supplies test equipment admission,
    # not the production planner's ability to rebuild its recovery kit.
    command(
        "/silent-command local a=game.get_entity_by_unit_number("
        f"{replacement_id}); assert(a); local inv=a.get_main_inventory(); "
        "assert(inv.insert{name='pistol',count=1}==1); assert(inv.insert{name='firearm-magazine',count=2}==2)"
    )
    for operation, item in [('equip_weapon', 'pistol'), ('equip_ammo', 'firearm-magazine')]:
        equipped = json_command(lua_json(remote_call('autorio_operations', operation, repr(item), '1')), operation)
        require(equipped[0] is True, equipped)
    readiness = json_command(lua_json(remote_call('autorio_equipment', 'status')), 'recovery equipment')
    require(readiness['recovery_readiness']['ready'] is True, readiness)
    position = owned[0]['position']
    approached = json_command(lua_json(remote_call('autorio_operations', 'walk_to_position', str(position['x']), str(position['y']), '2')), 'physical corpse approach')
    require(approached[0] is True, approached)
    wait_until_idle(status, 'physical corpse approach', 35)
    partial = retrieve('corpse-partial', 1, 5)
    require(partial['accepted'] is True and partial['reason'] == 'partial' and 0 < partial['moved_count'] <= 5, partial)
    duplicate = retrieve('corpse-partial', 1, 5)
    require(duplicate == partial, (partial, duplicate))
    restored = retrieve('corpse-finish')
    require(restored['accepted'] is True and restored['reason'] == 'recovered', restored)
    inventory = json_command(
        "/silent-command local a=game.get_entity_by_unit_number("
        f"{replacement_id}); assert(a); local inv=a.get_main_inventory(); local ammo=inv.find_item_stack('firearm-magazine'); "
        "rcon.print(helpers.table_to_json({iron=inv.get_item_count('iron-plate'),copper=inv.get_item_count('copper-plate'),"
        "guns=inv.get_item_count('pistol'),magazines=inv.get_item_count('firearm-magazine'),ammo=ammo and ammo.ammo,quality=ammo and ammo.quality.name}))",
        'native recovered inventory',
    )
    require(inventory == {'iron': 23, 'copper': 11, 'guns': 1, 'magazines': 3, 'ammo': 8, 'quality': 'normal'}, inventory)
    (results / 'corpse-retrieval.json').write_text(json.dumps({
        'status': 'pass', 'registry': corpses, 'unarmed': unarmed,
        'partial': partial, 'duplicate': duplicate, 'completion': restored, 'inventory': inventory,
    }, indent=2))

    (results / 'death-recovery.json').write_text(json.dumps({
        'status': 'pass',
        'old_actor_id': original_id,
        'replacement_actor_id': replacement_id,
        'before_death': before,
        'death': death,
        'after_recovery': recovered,
        'quiet': quiet,
        'navigation': navigation,
        'after_new_task': final,
    }, indent=2))
    print(
        f'PASS: zero-player NPC death recovery invalidated stale work and created replacement '
        f'old_actor_id={original_id}, replacement_actor_id={replacement_id}',
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
        (args.results / 'death-recovery-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
