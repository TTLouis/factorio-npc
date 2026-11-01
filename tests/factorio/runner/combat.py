"""Prove bounded standalone-character combat with real weapons and enemy entities."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, lua_text, remote_call
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def assert_actor(observation: dict, actor_id: int) -> None:
    validate_clock(observation['runtime'])
    actor = observation['actor']
    require(actor['valid'] is True and actor['kind'] == 'standalone_character', observation)
    require(actor['actor_id'] == actor_id, observation)
    require(observation['runtime']['connected_players'] == 0, observation)


def assert_stopped(observation: dict, actor_id: int) -> None:
    assert_actor(observation, actor_id)
    require(observation['task_state'] == 'idle', observation)
    require(observation['queue_empty'] is True and observation['queue_length'] == 0, observation)
    require(observation['walking'] is False and observation['mining'] is False and observation['shooting'] is False, observation)


def assert_kill(before: dict, after: dict, combat: dict, actor_id: int) -> None:
    assert_stopped(after, actor_id)
    require(before['target_alive'] is True and before['target_health'] > 0, before)
    require(after['target_alive'] is False, 'target must actually be gone; idle is not a kill')
    require(before['selected_gun_index'] == 1, before)
    require(before['selected_gun'] == 'pistol' and before['selected_ammo'] == 'firearm-magazine', before)

    # This fixture supplies 20 magazines and never changes the selected slot.
    # If the selected pistol/ammo telemetry disappears or switches while the
    # weak target dies, the acceptance evidence is incomplete and must fail
    # closed rather than inferring that SGLuna fired the expected weapon.
    require(after['selected_gun_index'] == before['selected_gun_index'], after)
    require(after['selected_gun'] == before['selected_gun'], after)
    require(after['selected_ammo'] == before['selected_ammo'], after)

    # LuaInventory.get_item_count() counts magazine *items*, not rounds inside the
    # currently loaded magazine. A small biter can die before a magazine is
    # emptied, so item count can remain unchanged while LuaItemStack.ammo drops.
    consumed_ammo = (
        after['ammo_items'] < before['ammo_items']
        or (
            after['ammo_items'] == before['ammo_items']
            and after['selected_ammo_rounds'] < before['selected_ammo_rounds']
        )
    )
    require(consumed_ammo, 'real character weapon must consume magazine rounds or magazine items')
    require(after['actor_health'] > 0, 'SGLuna died during the combat fixture')
    require(after['runtime']['tick'] > before['runtime']['tick'], 'combat consumed no simulation time')
    result = combat.get('last_result') or {}
    require(result.get('completed') is True and result.get('code') == 'target_destroyed', combat)
    require(result.get('target_unit_number') == before['target_id'], (before, combat))


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'combat-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def combat_status() -> dict:
        return json_command(lua_json(remote_call('autorio_combat', 'status')), 'combat status')

    original_id = json.loads((results / 'runner.json').read_text())['actor_id']
    initial = status('before combat')
    require(initial['actor']['actor_id'] == original_id and initial['task_state'] == 'idle', initial)

    # Build an open deterministic arena around the existing NPC. Removing the
    # earlier test fixtures here is test-owned cleanup; production Autorio no
    # longer deletes world enemies during setup.
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local f=game.forces.player; local enemy=game.forces.enemy; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=45}) do "
        "if e~=a and e.force~=enemy then e.destroy() end end; "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=45,force=enemy}) do e.destroy() end; "
        "local tiles={}; for x=math.floor(a.position.x)-45,math.floor(a.position.x)+45 do "
        "for y=math.floor(a.position.y)-12,math.floor(a.position.y)+12 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local guns=a.get_inventory(defines.inventory.character_guns); local ammo=a.get_inventory(defines.inventory.character_ammo); "
        "guns.clear(); ammo.clear(); assert(guns.insert{name='pistol',count=1}==1); "
        "assert(ammo.insert{name='firearm-magazine',count=20}==20); a.selected_gun_index=1; "
        "local slot=a.selected_gun_index; local gun=guns[slot]; local magazine=ammo[slot]; "
        "assert(gun.valid_for_read and magazine.valid_for_read); "
        "local target=s.create_entity{name='small-biter',position={x=a.position.x+20,y=a.position.y},force=enemy}; assert(target); "
        "rcon.print(helpers.table_to_json({target_id=target.unit_number,target_health=target.health,"
        "ammo_items=ammo.get_item_count('firearm-magazine'),selected_gun_index=slot,selected_gun=gun.name,"
        "selected_ammo=magazine.name,selected_ammo_rounds=magazine.ammo,actor_health=a.health,position=a.position}))",
        'combat fixture',
    )
    require(fixture['target_health'] > 0 and fixture['ammo_items'] == 20, fixture)
    require(fixture['selected_gun_index'] == 1 and fixture['selected_gun'] == 'pistol', fixture)
    require(fixture['selected_ammo'] == 'firearm-magazine' and fixture['selected_ammo_rounds'] > 0, fixture)
    target_id = fixture['target_id']

    observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        f"local target=nil; for _,e in pairs(s.find_entities_filtered{{force=game.forces.enemy}}) do if e.unit_number=={target_id} then target=e end end; "
        "local o=remote.call('autorio_operations','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
        "o.actor_health=a.health; o.position=a.position; "
        "local guns=a.get_inventory(defines.inventory.character_guns); local ammo=a.get_inventory(defines.inventory.character_ammo); "
        "local slot=a.selected_gun_index; local gun=slot and guns[slot] or nil; local magazine=slot and ammo[slot] or nil; "
        "o.selected_gun_index=slot; o.selected_gun=gun and gun.valid_for_read and gun.name or nil; "
        "o.selected_ammo=magazine and magazine.valid_for_read and magazine.name or nil; "
        "o.selected_ammo_rounds=magazine and magazine.valid_for_read and magazine.ammo or 0; "
        "o.ammo_items=ammo.get_item_count('firearm-magazine'); "
        "o.target_alive=target~=nil and target.valid; o.target_health=target and target.health or 0; "
        f"o.target_id={target_id}; rcon.print(helpers.table_to_json(o))"
    )

    def observe() -> dict:
        value = json_command(observation_command, 'combat observation')
        assert_actor(value, original_id)
        return value

    before = observe()
    result = json_command(lua_json(remote_call('autorio_operations', 'attack_nearest_enemy', '40')), 'combat start')
    require(result == [True, 'Combat task queued'], result)
    wait_until_idle(status, 'combat target kill', 60)
    after = observe()
    combat = combat_status()
    assert_kill(before, after, combat, original_id)

    # No target is an explicit failure, not a successful empty combat task.
    no_target = json_command(lua_json(remote_call('autorio_operations', 'attack_nearest_enemy', '20')), 'no-target combat')
    require(no_target[0] is True, no_target)
    wait_until_idle(status, 'combat no target', 5)
    no_target_status = combat_status()
    require(no_target_status['last_result']['code'] == 'no_target', no_target_status)
    assert_stopped(observe(), original_id)

    # A live target with no ammunition must remain alive and must not make
    # dependent queued work execute as though the attack succeeded.
    no_ammo_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "local ammo=a.get_inventory(defines.inventory.character_ammo); ammo.clear(); "
        "local t=s.create_entity{name='small-biter',position={x=a.position.x+8,y=a.position.y},force=game.forces.enemy}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,health=t.health}))",
        'no-ammo fixture',
    )
    command(lua_text(remote_call('autorio_operations', 'attack_nearest_enemy', '20')))
    command(lua_text(remote_call('autorio_operations', 'wait', '120')))
    wait_until_idle(status, 'combat no ammo', 5)
    no_ammo_status = combat_status()
    require(no_ammo_status['last_result']['code'] == 'no_weapon_or_ammo', no_ammo_status)
    survivor = json_command(
        "/silent-command local found=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{force=game.forces.enemy}) do "
        f"if e.unit_number=={no_ammo_fixture['id']} then found=e end end; "
        "rcon.print(helpers.table_to_json({alive=found~=nil and found.valid,health=found and found.health or 0,task=remote.call('autorio_operations','status')}))",
        'no-ammo survivor',
    )
    require(survivor['alive'] is True and survivor['health'] == no_ammo_fixture['health'], survivor)
    require(survivor['task']['queue_length'] == 0 and survivor['task']['task_state'] == 'idle', survivor)

    # Cancellation while approaching must release physical controls. The target
    # is placed out of pistol range so it cannot be damaged before cancellation.
    cancel_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{force=game.forces.enemy}) do e.destroy() end; "
        "local ammo=a.get_inventory(defines.inventory.character_ammo); ammo.clear(); ammo.insert{name='firearm-magazine',count=20}; "
        "local t=s.create_entity{name='small-biter',position={x=a.position.x+30,y=a.position.y},force=game.forces.enemy}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,health=t.health,position=a.position}))",
        'combat cancellation fixture',
    )
    command(lua_text(remote_call('autorio_operations', 'attack_nearest_enemy', '50')))

    # Do not assume one fixed wall delay lands in a walking tick. Path requests
    # and repaths can briefly leave the task active while walking_state is false.
    # Prove we actually observed physical approach motion before cancelling it.
    moving = None
    approach_deadline = time.monotonic() + 5.0
    while time.monotonic() < approach_deadline:
        candidate = observe()
        require(candidate['task_state'] == 'attacking', candidate)
        if candidate['walking'] is True:
            moving = candidate
            break
        time.sleep(0.05)
    require(moving is not None, 'combat approach never engaged walking controls before cancellation')

    require(command(lua_text(remote_call('autorio_operations', 'cancel_all_tasks'))) == 'true', 'combat cancellation call failed')
    cancelled = observe()
    assert_stopped(cancelled, original_id)
    cancel_position = cancelled['position']
    time.sleep(2)
    quiet = observe()
    assert_stopped(quiet, original_id)
    dx = quiet['position']['x'] - cancel_position['x']
    dy = quiet['position']['y'] - cancel_position['y']
    require(dx * dx + dy * dy < 0.01, (cancel_position, quiet['position']))
    cancel_target = json_command(
        "/silent-command local found=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{force=game.forces.enemy}) do "
        f"if e.unit_number=={cancel_fixture['id']} then found=e end end; "
        "rcon.print(helpers.table_to_json({alive=found~=nil and found.valid,health=found and found.health or 0}))",
        'cancelled target',
    )
    require(cancel_target['alive'] is True and cancel_target['health'] == cancel_fixture['health'], cancel_target)

    # Real clear-area lifecycle: two nests share one clear_enemy_area operation.
    # SGLuna must keep useful temporary support while any clear-area hostile remains,
    # then recover every surviving owned turret after both nests are gone. Real
    # cleanup mining must still be interruptible by a new pursuer and resume only
    # after a fresh safety window. A pre-existing player turret must never be owned.
    lifecycle_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local enemy=game.forces.enemy; local player=game.forces.player; "
        "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "for _,e in pairs(s.find_entities_filtered{force=enemy}) do e.destroy() end; "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=55}) do "
        "if e~=a and e.force~=enemy and e.type~='character' then e.destroy() end end; "
        "local tiles={}; for x=math.floor(a.position.x)-15,math.floor(a.position.x)+55 do "
        "for y=math.floor(a.position.y)-30,math.floor(a.position.y)+30 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local guns=a.get_inventory(defines.inventory.character_guns); local ammo=a.get_inventory(defines.inventory.character_ammo); "
        "local main=a.get_main_inventory(); guns.clear(); ammo.clear(); main.clear(); "
        "assert(guns.insert{name='pistol',count=1}==1); assert(ammo.insert{name='firearm-magazine',count=60}==60); a.selected_gun_index=1; "
        "assert(main.insert{name='gun-turret',count=8}==8); assert(main.insert{name='firearm-magazine',count=240}==240); "
        "local p=s.find_non_colliding_position('gun-turret',{x=a.position.x-6,y=a.position.y+12},6,0.5); assert(p); "
        "local player_turret=s.create_entity{name='gun-turret',position=p,force=player,raise_built=true}; assert(player_turret); "
        "local first=s.create_entity{name='biter-spawner',position={x=a.position.x+18,y=a.position.y},force=enemy}; assert(first); "
        "local second=s.create_entity{name='biter-spawner',position={x=a.position.x+32,y=a.position.y},force=enemy}; assert(second); "
        "rcon.print(helpers.table_to_json({first_id=first.unit_number,second_id=second.unit_number,player_turret_id=player_turret.unit_number,"
        "gun_turrets=main.get_item_count('gun-turret'),support_ammo=main.get_item_count('firearm-magazine'),actor_position=a.position}))",
        'combat lifecycle fixture',
    )
    require(lifecycle_fixture['gun_turrets'] == 8 and lifecycle_fixture['support_ammo'] == 240, lifecycle_fixture)

    first_id = lifecycle_fixture['first_id']
    second_id = lifecycle_fixture['second_id']
    player_turret_id = lifecycle_fixture['player_turret_id']

    lifecycle_observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a,'original NPC missing'); "
        "local combat=remote.call('autorio_combat','status'); local task=remote.call('autorio_operations','status'); "
        "local ids={}; for _,id in pairs(combat.encounter_owned_turret_unit_numbers or {}) do ids[id]=true end; "
        "local owned_valid=0; local owned_ammo=0; local player_turret_alive=false; local first_alive=false; local second_alive=false; "
        "for _,e in pairs(s.find_entities_filtered{}) do if e.valid and e.unit_number then "
        f"if e.unit_number=={player_turret_id} then player_turret_alive=true end; "
        f"if e.unit_number=={first_id} then first_alive=true end; if e.unit_number=={second_id} then second_alive=true end; "
        "if ids[e.unit_number] then owned_valid=owned_valid+1; local inv=e.get_inventory(defines.inventory.turret_ammo); "
        "if inv then owned_ammo=owned_ammo+inv.get_item_count('firearm-magazine') end end end end; "
        "local main=a.get_main_inventory(); rcon.print(helpers.table_to_json({runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players},"
        "actor=task.actor,task_state=task.task_state,walking=a.walking_state.walking,mining=a.mining_state.mining,"
        "shooting=a.shooting_state.state~=defines.shooting.not_shooting,actor_health=a.health,position=a.position,combat=combat,"
        "main_gun_turrets=main.get_item_count('gun-turret'),main_support_ammo=main.get_item_count('firearm-magazine'),"
        "owned_valid=owned_valid,owned_ammo_items=owned_ammo,player_turret_alive=player_turret_alive,first_alive=first_alive,second_alive=second_alive}))"
    )

    def lifecycle_observe(context: str) -> dict:
        value = json_command(lifecycle_observation_command, context)
        assert_actor(value, original_id)
        require(value['actor_health'] > 0, value)
        return value

    clear_result = json_command(lua_json(remote_call('autorio_operations', 'clear_enemy_area', '50')), 'clear-area lifecycle start')
    require(clear_result == [True, 'Area-clear combat task queued'], clear_result)

    cleanup_started = None
    cleanup_deadline = time.monotonic() + 60.0
    while time.monotonic() < cleanup_deadline:
        candidate = lifecycle_observe('wait for native turret cleanup')
        combat_state = candidate.get('combat') or {}
        if combat_state.get('combat_phase') == 'cleanup' and candidate['mining'] is True:
            cleanup_started = candidate
            break
        require(candidate['task_state'] == 'attacking', candidate)
        time.sleep(0.03)
    require(cleanup_started is not None, 'clear-area combat never entered real support-turret mining cleanup')
    require(cleanup_started['first_alive'] is False, cleanup_started)
    require(cleanup_started['second_alive'] is False, cleanup_started)
    require(cleanup_started['player_turret_alive'] is True, cleanup_started)
    deployed_at_cleanup = cleanup_started['combat']['encounter_owned_turret_count']
    require(deployed_at_cleanup >= 3, cleanup_started)
    require(cleanup_started['owned_valid'] == deployed_at_cleanup, cleanup_started)
    require(
        cleanup_started['main_gun_turrets'] == lifecycle_fixture['gun_turrets'] - deployed_at_cleanup,
        cleanup_started,
    )
    require(cleanup_started['owned_ammo_items'] > 0, cleanup_started)

    pursuer_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; assert(a); "
        "local t=s.create_entity{name='small-biter',position={x=a.position.x,y=a.position.y+22},force=game.forces.enemy}; assert(t); "
        "rcon.print(helpers.table_to_json({id=t.unit_number,health=t.health,spawn_tick=game.tick,actor_position=a.position}))",
        'cleanup pursuer fixture',
    )
    pursuer_id = pursuer_fixture['id']

    interrupted = None
    interrupt_deadline = time.monotonic() + 5.0
    while time.monotonic() < interrupt_deadline:
        candidate = lifecycle_observe('cleanup interrupt')
        target = (candidate.get('combat') or {}).get('target') or {}
        if target.get('unit_number') == pursuer_id and candidate['mining'] is False:
            interrupted = candidate
            break
        time.sleep(0.02)
    require(interrupted is not None, 'mobile threat did not interrupt native turret mining')
    require(interrupted['combat']['combat_phase'] == 'engage', interrupted)
    require(interrupted['combat']['encounter_owned_turret_count'] >= 1, interrupted)
    require(interrupted['second_alive'] is False and interrupted['player_turret_alive'] is True, interrupted)

    safety_after_pursuer = None
    pursuer_deadline = time.monotonic() + 30.0
    while time.monotonic() < pursuer_deadline:
        candidate = lifecycle_observe('wait for pursuer clearance')
        combat_state = candidate.get('combat') or {}
        if combat_state.get('combat_phase') == 'safety' and combat_state.get('combat_safety_goal') == 'cleanup':
            safety_after_pursuer = candidate
            break
        time.sleep(0.03)
    require(safety_after_pursuer is not None, 'combat did not return to cleanup safety after pursuer')
    require(safety_after_pursuer['mining'] is False, safety_after_pursuer)
    require(safety_after_pursuer['second_alive'] is False, safety_after_pursuer)
    safety_tick = safety_after_pursuer['combat']['local_safe_since_tick']
    require(isinstance(safety_tick, (int, float)), safety_after_pursuer)

    mid_safety = None
    mid_deadline = time.monotonic() + 3.0
    while time.monotonic() < mid_deadline:
        candidate = lifecycle_observe('fresh cleanup safety window')
        elapsed_ticks = candidate['runtime']['tick'] - safety_tick
        if elapsed_ticks >= 60:
            mid_safety = candidate
            break
        time.sleep(0.02)
    require(mid_safety is not None, 'simulation did not advance through cleanup safety window')
    require(mid_safety['combat']['combat_phase'] == 'safety' and mid_safety['mining'] is False, mid_safety)
    require(mid_safety['combat']['encounter_owned_turret_count'] >= 1, mid_safety)

    resumed_cleanup = None
    resume_deadline = time.monotonic() + 4.0
    while time.monotonic() < resume_deadline:
        candidate = lifecycle_observe('resume cleanup after stable safety')
        combat_state = candidate.get('combat') or {}
        if combat_state.get('combat_phase') == 'cleanup' and candidate['mining'] is True:
            resumed_cleanup = candidate
            break
        time.sleep(0.02)
    require(resumed_cleanup is not None, 'cleanup did not resume after fresh stable safety')
    require(resumed_cleanup['runtime']['tick'] - safety_tick >= 120, resumed_cleanup)
    require(resumed_cleanup['second_alive'] is False, resumed_cleanup)

    cleanup_finished = None
    finish_cleanup_deadline = time.monotonic() + 25.0
    while time.monotonic() < finish_cleanup_deadline:
        candidate = lifecycle_observe('finish all owned turret cleanup')
        combat_state = candidate.get('combat') or {}
        if combat_state.get('combat_phase') == 'safety' and combat_state.get('combat_safety_goal') == 'resume' and combat_state.get('encounter_owned_turret_count') == 0:
            cleanup_finished = candidate
            break
        time.sleep(0.03)
    require(cleanup_finished is not None, 'not all encounter-owned turrets were recovered')
    require(cleanup_finished['owned_valid'] == 0, cleanup_finished)
    require(cleanup_finished['second_alive'] is False, cleanup_finished)
    require(cleanup_finished['player_turret_alive'] is True, cleanup_finished)
    require(
        cleanup_finished['main_gun_turrets'] >= cleanup_started['main_gun_turrets'] + cleanup_started['owned_valid'],
        (cleanup_started, cleanup_finished),
    )
    # Native mining must return support inventory, but the turrets remain live
    # until each mining action completes and may legitimately spend ammunition
    # on a late defender between these two observations. Prove recovery by the
    # main-inventory increase together with owned_valid == 0 above; do not treat
    # combat consumption as lost cleanup inventory.
    if resumed_cleanup['owned_ammo_items'] > 0:
        require(
            cleanup_finished['main_support_ammo'] > resumed_cleanup['main_support_ammo'],
            (resumed_cleanup, cleanup_finished),
        )

    wait_until_idle(status, 'clear-area lifecycle completion', 60)
    lifecycle_final = lifecycle_observe('clear-area lifecycle final')
    lifecycle_combat = lifecycle_final['combat']
    require(lifecycle_final['task_state'] == 'idle', lifecycle_final)
    require(lifecycle_final['walking'] is False and lifecycle_final['mining'] is False and lifecycle_final['shooting'] is False, lifecycle_final)
    require(lifecycle_final['second_alive'] is False, lifecycle_final)
    require(lifecycle_final['player_turret_alive'] is True, lifecycle_final)
    require(lifecycle_final['owned_valid'] == 0, lifecycle_final)
    require(lifecycle_combat['last_result']['completed'] is True and lifecycle_combat['last_result']['code'] == 'area_cleared', lifecycle_combat)

    (results / 'combat.json').write_text(json.dumps({
        'status': 'pass', 'actor_id': original_id,
        'kill_before': before, 'kill_after': after, 'kill_result': combat,
        'no_target': no_target_status, 'no_ammo': no_ammo_status,
        'cancelled': quiet,
        'lifecycle': {
            'fixture': lifecycle_fixture,
            'cleanup_started': cleanup_started,
            'interrupted': interrupted,
            'safety_after_pursuer': safety_after_pursuer,
            'resumed_cleanup': resumed_cleanup,
            'cleanup_finished': cleanup_finished,
            'final': lifecycle_final,
        },
    }, indent=2))
    print(f'PASS: zero-player NPC bounded combat + native encounter-turret lifecycle with stable actor_id={original_id}', flush=True)


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
        (args.results / 'combat-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())