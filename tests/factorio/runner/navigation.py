"""Exercise bounded Factorio navigation after death recovery on the replacement NPC."""
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


def assert_stopped(observation: dict, actor_id: int) -> None:
    validate_clock(observation['runtime'])
    require(observation['runtime']['connected_players'] == 0, observation)
    require(observation['actor']['actor_id'] == actor_id, observation)
    require(observation['task_state'] == 'idle', observation)
    require(observation['queue_empty'] is True and observation['queue_length'] == 0, observation)
    require(observation['walking'] is False and observation['mining'] is False and observation['shooting'] is False, observation)


def assert_reached(before: dict, after: dict, navigation: dict, actor_id: int, target_id: int, minimum_attempts: int = 1) -> None:
    assert_stopped(after, actor_id)
    require(after['runtime']['tick'] > before['runtime']['tick'], (before, after))
    require(after['target_alive'] is True and after['target_id'] == target_id, after)
    require(squared_distance(after['position'], after['target_position']) <= 9.0, after)
    result = navigation.get('last_result') or {}
    require(navigation.get('task_active') is False, navigation)
    require(result.get('accepted') is True and result.get('completed') is True, navigation)
    require(result.get('code') == 'reached', navigation)
    require(result.get('actor_id') == actor_id, navigation)
    require(result.get('target_unit_number') == target_id, navigation)
    require((result.get('path_attempts') or 0) >= minimum_attempts, navigation)


def assert_unreachable(before: dict, after: dict, navigation: dict, actor_id: int, target_id: int) -> None:
    assert_stopped(after, actor_id)
    require(after['runtime']['tick'] >= before['runtime']['tick'], (before, after))
    require(after['target_alive'] is True and after['target_id'] == target_id, after)
    result = navigation.get('last_result') or {}
    require(navigation.get('task_active') is False, navigation)
    require(result.get('accepted') is False and result.get('completed') is False, navigation)
    require(result.get('code') == 'unreachable', navigation)
    require(result.get('actor_id') == actor_id, navigation)
    require(result.get('target_unit_number') == target_id, navigation)


def assert_passive_belt_displacement(before: dict, after: dict, actor_id: int) -> None:
    """A stopped NPC may still move because the world moves it (e.g. belts)."""
    assert_stopped(before, actor_id)
    assert_stopped(after, actor_id)
    require(after['runtime']['tick'] > before['runtime']['tick'], (before, after))
    require(before.get('belt_count', 0) > 0 and after.get('belt_count', 0) > 0, (before, after))
    require(squared_distance(before['position'], after['position']) > 0.0625, (before, after))


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    death = json.loads((results / 'death-recovery.json').read_text())
    actor_id = death['replacement_actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'navigation-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def navigation_status(context: str) -> dict:
        return json_command(lua_json(remote_call('autorio_navigation', 'status')), context)

    def wait_for_idle(context: str, timeout: float = 30.0) -> dict:
        return wait_until_idle(operation_status, context, timeout)

    def observe(target_id: int, target_name: str, context: str) -> dict:
        return json_command(
            "/silent-command local s=game.surfaces[1]; local a=nil; "
            "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e end end; assert(a,'replacement NPC missing'); "
            f"local target=nil; for _,e in pairs(s.find_entities_filtered{{name={target_name!r}}}) do if e.unit_number=={target_id} then target=e end end; "
            "local o=remote.call('autorio_operations','status'); "
            "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
            "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
            "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; o.position=a.position; "
            f"o.target_id={target_id}; o.target_alive=target~=nil and target.valid; o.target_position=target and target.position or nil; "
            "rcon.print(helpers.table_to_json(o))",
            context,
        )

    initial = operation_status('navigation initial status')
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    require(initial['actor']['actor_id'] == actor_id, initial)

    # Case 1: force Factorio pathfinding to route around a solid wall instead of
    # relying on direct walking. The wall spans the direct lane but leaves broad
    # open space above and below it.
    obstacle_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "for _,name in pairs({'steel-chest','stone-wall','wooden-chest','iron-chest','transport-belt'}) do "
        "for _,e in pairs(s.find_entities_filtered{name=name,position=a.position,radius=70}) do e.destroy() end end; "
        "local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); local tiles={}; "
        "for x=x0-5,x0+45 do for y=y0-12,y0+12 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "local target=s.create_entity{name='steel-chest',position={x=a.position.x+30,y=a.position.y},force=a.force}; assert(target); "
        "local walls=0; for y=y0-5,y0+5 do local w=s.create_entity{name='stone-wall',position={x=x0+12,y=y},force=a.force}; if w then walls=walls+1 end end; "
        "rcon.print(helpers.table_to_json({target_id=target.unit_number,target_position=target.position,walls=walls,position=a.position,tick=game.tick}))",
        'navigation obstacle fixture',
    )
    require(obstacle_fixture['walls'] >= 9, obstacle_fixture)
    obstacle_before = observe(obstacle_fixture['target_id'], 'steel-chest', 'obstacle before')
    start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('steel-chest'), '50')))
    require(start == 'true', f'obstacle navigation admission failed: {start!r}')
    wait_for_idle('navigation obstacle route', 30)
    obstacle_after = observe(obstacle_fixture['target_id'], 'steel-chest', 'obstacle after')
    obstacle_nav = navigation_status('obstacle navigation result')
    assert_reached(obstacle_before, obstacle_after, obstacle_nav, actor_id, obstacle_fixture['target_id'])

    # Case 2: once a real path is accepted, move the same bound entity far
    # enough to invalidate the planned goal. SGLuna must repath to that exact
    # entity rather than finish at the stale coordinate or silently retarget.
    moving_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position=a.position,radius=60}) do e.destroy() end; "
        "local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); local tiles={}; "
        "for x=x0-5,x0+40 do for y=y0-15,y0+15 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); local target=s.create_entity{name='wooden-chest',position={x=a.position.x+25,y=a.position.y},force=a.force}; assert(target); "
        "rcon.print(helpers.table_to_json({target_id=target.unit_number,target_position=target.position,position=a.position,tick=game.tick}))",
        'moving navigation fixture',
    )
    moving_before = observe(moving_fixture['target_id'], 'wooden-chest', 'moving target before')
    start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('wooden-chest'), '50')))
    require(start == 'true', f'moving-target navigation admission failed: {start!r}')

    path_deadline = time.monotonic() + 8.0
    accepted_path = None
    while time.monotonic() < path_deadline:
        nav = navigation_status('moving target path wait')
        path = nav.get('path') or {}
        if nav.get('task_active') is True and (path.get('waypoints_remaining') or 0) > 0:
            accepted_path = nav
            break
        time.sleep(0.05)
    require(accepted_path is not None, 'navigation never accepted an initial path before target relocation')
    initial_repath_tick = (accepted_path.get('path') or {}).get('last_repath_tick')
    require(isinstance(initial_repath_tick, int), accepted_path)

    moved = json_command(
        "/silent-command local target=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='wooden-chest'}) do "
        f"if e.unit_number=={moving_fixture['target_id']} then target=e end end; assert(target); "
        "local p={x=target.position.x,y=target.position.y+8}; local ok=target.teleport(p); "
        "rcon.print(helpers.table_to_json({ok=ok,position=target.position,tick=game.tick}))",
        'moving target relocation',
    )
    require(moved['ok'] is True, moved)

    repath_deadline = time.monotonic() + 8.0
    observed_repath = None
    while time.monotonic() < repath_deadline:
        nav = navigation_status('moving target repath wait')
        path = nav.get('path') or {}
        last_repath_tick = path.get('last_repath_tick')
        if (
            nav.get('task_active') is True
            and isinstance(last_repath_tick, int)
            and last_repath_tick > initial_repath_tick
            and path.get('last_recovery_reason') == 'target_moved'
        ):
            observed_repath = nav
            break
        if nav.get('task_active') is False:
            break
        time.sleep(0.02)
    require(observed_repath is not None, {'initial_path': accepted_path, 'last_status': nav, 'moved': moved})

    wait_for_idle('navigation moving target', 30)
    moving_after = observe(moving_fixture['target_id'], 'wooden-chest', 'moving target after')
    moving_nav = navigation_status('moving target navigation result')
    assert_reached(moving_before, moving_after, moving_nav, actor_id, moving_fixture['target_id'])
    require(squared_distance(moving_after['target_position'], moved['position']) < 0.01, (moving_after, moved))

    # Case 3: put a target on a small island inside a wide water moat. The
    # pathfinder must report no route. Queue a dependent wait to prove failure
    # cancels the batch and, unlike the historical fallback, SGLuna never switches
    # to blind direct walking into the water.
    unreachable_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "for _,e in pairs(s.find_entities_filtered{name='iron-chest',position=a.position,radius=60}) do e.destroy() end; "
        "local tx=math.floor(a.position.x)+24; local ty=math.floor(a.position.y); local tiles={}; "
        "for x=math.floor(a.position.x)-4,tx+12 do for y=ty-12,ty+12 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); local water={}; for x=tx-7,tx+7 do for y=ty-7,ty+7 do water[#water+1]={name='water',position={x=x,y=y}} end end; s.set_tiles(water,true,false,true); "
        "local island={}; for x=tx-2,tx+2 do for y=ty-2,ty+2 do island[#island+1]={name='landfill',position={x=x,y=y}} end end; s.set_tiles(island,true,false,true); "
        "local target=s.create_entity{name='iron-chest',position={x=tx,y=ty},force=a.force}; assert(target); "
        "rcon.print(helpers.table_to_json({target_id=target.unit_number,target_position=target.position,position=a.position,tick=game.tick}))",
        'unreachable navigation fixture',
    )
    unreachable_before = observe(unreachable_fixture['target_id'], 'iron-chest', 'unreachable before')
    start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('iron-chest'), '50')))
    require(start == 'true', f'unreachable navigation admission failed: {start!r}')
    queued = json_command(lua_json(remote_call('autorio_operations', 'wait', '300')), 'unreachable dependent wait')
    require(queued[0] is True, queued)
    wait_for_idle('navigation unreachable target', 30)
    unreachable_after = observe(unreachable_fixture['target_id'], 'iron-chest', 'unreachable after')
    unreachable_nav = navigation_status('unreachable navigation result')
    assert_unreachable(unreachable_before, unreachable_after, unreachable_nav, actor_id, unreachable_fixture['target_id'])

    quiet_position = unreachable_after['position']
    time.sleep(2.0)
    quiet = observe(unreachable_fixture['target_id'], 'iron-chest', 'unreachable quiet')
    assert_unreachable(unreachable_before, quiet, unreachable_nav, actor_id, unreachable_fixture['target_id'])
    require(squared_distance(quiet_position, quiet['position']) < 0.01, (quiet_position, quiet['position']))

    # Case 4: prove stopped controls are not synonymous with a stationary
    # coordinate. A live transport belt can move the character while SGLuna's
    # walking/mining/shooting inputs remain fully released.
    belt_fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); "
        "for _,e in pairs(s.find_entities_filtered{name='transport-belt',position=a.position,radius=40}) do e.destroy() end; "
        "local x0=math.floor(a.position.x); local y0=math.floor(a.position.y); local tiles={}; "
        "for x=x0-3,x0+30 do for y=y0-2,y0+2 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; s.set_tiles(tiles,true,false,true); "
        "local origin={x=x0+0.5,y=y0+0.5}; assert(a.teleport(origin)); "
        "local belts=0; for x=x0-1,x0+24 do local b=s.create_entity{name='transport-belt',position={x=x+0.5,y=y0+0.5},direction=defines.direction.east,force=a.force}; if b then belts=belts+1 end end; "
        "a.walking_state={walking=false,direction=defines.direction.east}; a.mining_state={mining=false}; a.shooting_state={state=defines.shooting.not_shooting,position=a.position}; "
        "rcon.print(helpers.table_to_json({belts=belts,position=a.position,tick=game.tick}))",
        'transport belt fixture',
    )
    require(belt_fixture['belts'] >= 20, belt_fixture)

    belt_observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "local o=remote.call('autorio_operations','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; o.position=a.position; "
        "o.belt_count=#s.find_entities_filtered{name='transport-belt',position=a.position,radius=0.8}; "
        "rcon.print(helpers.table_to_json(o))"
    )
    belt_before = json_command(belt_observation_command, 'belt passive displacement before')
    assert_stopped(belt_before, actor_id)
    require(belt_before['belt_count'] > 0, belt_before)
    time.sleep(2.0)
    belt_after = json_command(belt_observation_command, 'belt passive displacement after')
    assert_passive_belt_displacement(belt_before, belt_after, actor_id)
    require(belt_after['position']['x'] > belt_before['position']['x'], (belt_before, belt_after))

    payload = {
        'status': 'pass',
        'actor_id': actor_id,
        'obstacle': {'before': obstacle_before, 'after': obstacle_after, 'navigation': obstacle_nav},
        'moving_target': {
            'before': moving_before,
            'after': moving_after,
            'navigation': moving_nav,
            'relocation': moved,
            'observed_repath': observed_repath,
        },
        'unreachable': {'before': unreachable_before, 'after': unreachable_after, 'navigation': unreachable_nav, 'quiet': quiet},
        'transport_belt': {'fixture': belt_fixture, 'before': belt_before, 'after': belt_after},
    }
    (results / 'navigation.json').write_text(json.dumps(payload, indent=2))
    print(
        f'PASS: zero-player NPC bounded navigation routed obstacles, repathed moving target, '
        f'failed unreachable target, and distinguished passive belt displacement with actor_id={actor_id}',
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
        (args.results / 'navigation-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
