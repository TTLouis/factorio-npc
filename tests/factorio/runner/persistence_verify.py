"""Verify a real Factorio stop/restart preserves the NPC body but not stale Autorio control."""
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


def assert_restarted(before: dict, after: dict) -> None:
    expected_id = before['actor_id']
    expected_force = before['force_index']
    inventory = before['inventory']

    validate_clock(after['runtime'])
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['valid'] is True and after['actor']['kind'] == 'standalone_character', after)
    require(after['actor']['actor_id'] == expected_id, (before, after))
    require(after['force_index'] == expected_force, (before, after))
    require(after['iron'] == inventory['iron-plate'] and after['copper'] == inventory['copper-plate'], (before, after))
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)
    require(after['walking'] is False and after['mining'] is False and after['shooting'] is False, after)
    require(after['target_alive'] is True, after)

    reconciliation = after.get('load_reconciliation') or {}
    require(reconciliation.get('policy') == 'discard_autorio_tasks_and_stop_npc_controls_on_load', reconciliation)
    require(reconciliation.get('pending') is False, reconciliation)
    require(reconciliation.get('last_actor_id') == expected_id, reconciliation)
    require(isinstance(reconciliation.get('last_tick'), int), reconciliation)


def assert_navigation_reached(navigation: dict, actor_id: int, target_id: int) -> None:
    result = navigation.get('last_result') or {}
    require(navigation.get('task_active') is False, navigation)
    require(result.get('accepted') is True and result.get('completed') is True, navigation)
    require(result.get('code') == 'reached', navigation)
    require(result.get('actor_id') == actor_id, navigation)
    require(result.get('target_unit_number') == target_id, navigation)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    before = json.loads((results / 'persistence-before.json').read_text())
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'persistence-verify-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    # The save already has Lua commands enabled, but keep the restart handshake
    # explicit so an unexpectedly unavailable mod/runtime fails with a useful log.
    probe = command('/silent-command rcon.print("SGLUNA_RESTART_READY")')
    if probe != 'SGLUNA_RESTART_READY':
        probe = command('/silent-command rcon.print("SGLUNA_RESTART_READY")')
    require(probe == 'SGLUNA_RESTART_READY', probe)

    original_id = before['actor_id']
    target_id = before['target_id']

    # Production does not mutate synchronized game state from script.on_load.
    # The supervisor's bindNpc() issues this replicated RCON repair command once
    # the multiplayer server is ready. Mirror that exact startup boundary here
    # before asserting that stale serialized walking/mining/shooting was cleared.
    startup = json_command(
        lua_json(remote_call('autorio_operations', 'reconcile_startup', repr('persistence-restart-verify'))),
        'logical task post-restart reconciliation',
    )
    require(startup.get('ok') is True and startup.get('reconciled') is True, startup)
    reconciliation = json_command(
        lua_json(remote_call('autorio_actor', 'reconcile_after_load')),
        'post-restart reconciliation',
    )
    require(reconciliation.get('reconciled') is True, reconciliation)
    require(reconciliation.get('reason') == 'reconciled', reconciliation)
    require(reconciliation.get('actor_id') == original_id, reconciliation)
    require(isinstance(reconciliation.get('tick'), int), reconciliation)

    observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={original_id} then a=e end end; "
        "local o=remote.call('autorio_operations','status'); "
        "local actor_status=remote.call('autorio_actor','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.load_reconciliation=actor_status.load_reconciliation; "
        "if a then local inv=a.get_main_inventory(); o.force_index=a.force.index; o.health=a.health; o.position=a.position; "
        "o.walking=a.walking_state.walking; o.mining=a.mining_state.mining; "
        "o.shooting=a.shooting_state.state~=defines.shooting.not_shooting; "
        "o.iron=inv.get_item_count('iron-plate'); o.copper=inv.get_item_count('copper-plate') end; "
        f"local target=nil; for _,e in pairs(s.find_entities_filtered{{name='steel-chest'}}) do if e.unit_number=={target_id} then target=e end end; "
        "o.target_alive=target~=nil and target.valid; o.target_position=target and target.position or nil; "
        "rcon.print(helpers.table_to_json(o))"
    )

    def observe(context: str) -> dict:
        return json_command(observation_command, context)

    after = observe('post-restart observation')
    assert_restarted(before, after)

    # Controls must remain released after the initial reconciliation, not merely
    # appear idle in the same tick. This catches serialized walking/shooting that
    # resumes once RCON stops polling.
    position = after['position']
    time.sleep(2.0)
    quiet = observe('post-restart quiet observation')
    assert_restarted(before, quiet)
    require(squared_distance(position, quiet['position']) < 0.01, (position, quiet['position']))

    # Reuse the persisted target to prove the reacquired body can accept and
    # complete fresh work after the restart boundary. walk_to_entity returns a
    # scalar boolean, so serialize it with tostring rather than table_to_json.
    start = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('steel-chest'), '40')))
    require(start == 'true', f'post-restart movement start failed: {start!r}')

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    completed = wait_until_idle(status, 'post-restart movement', 20)
    require(completed['actor']['actor_id'] == original_id, completed)
    require(completed['queue_empty'] is True and completed['queue_length'] == 0, completed)

    navigation = json_command(
        lua_json(remote_call('autorio_navigation', 'status')),
        'post-restart navigation result',
    )
    assert_navigation_reached(navigation, original_id, target_id)

    final = observe('post-restart final observation')
    assert_restarted(before, final)
    # The bounded navigation contract completes within 2.5 tiles of the bound
    # entity. Keep a small telemetry tolerance here, but require the exact
    # target-bound `reached` receipt above so generic idle cannot pass.
    require(squared_distance(final['position'], before['target_position']) <= 9.0, (final, before['target_position'], navigation))

    (results / 'persistence.json').write_text(json.dumps({
        'status': 'pass',
        'actor_id': original_id,
        'before': before,
        'reconciliation': reconciliation,
        'after_restart': after,
        'quiet': quiet,
        'navigation': navigation,
        'after_new_task': final,
    }, indent=2))
    print(
        f'PASS: zero-player NPC save/restart reacquired same body and cleared stale controls with actor_id={original_id}',
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
        (args.results / 'persistence-verify-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
