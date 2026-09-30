"""Verify save/load cancels only persisted Autorio-owned native crafting and leaves SGLuna usable."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from crafting import assert_completed
from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, validate_clock, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    before = json.loads((results / 'crafting-restart-before.json').read_text())
    actor_id = before['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'crafting-restart-verify-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def crafting_status(context: str) -> dict:
        return json_command(lua_json(remote_call('autorio_crafting', 'status')), context)

    observation_command = (
        "/silent-command local s=game.surfaces[1]; local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a,'craft restart actor missing'); "
        "local o=remote.call('autorio_operations','status'); local actor_status=remote.call('autorio_actor','status'); "
        "local c=remote.call('autorio_crafting','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "o.load_reconciliation=actor_status.load_reconciliation; o.persisted_owner=c.persisted_owner; "
        "local inv=a.get_main_inventory(); local q=a.crafting_queue or {}; "
        "o.iron=inv.get_item_count('iron-plate'); o.output_count=inv.get_item_count('iron-gear-wheel'); "
        "o.native_queue_length=#q; o.native_queue_recipe=q[1] and q[1].recipe or nil; "
        "rcon.print(helpers.table_to_json(o))"
    )

    def observe(context: str) -> dict:
        return json_command(observation_command, context)

    probe = command('/silent-command rcon.print("SGLUNA_CRAFT_RESTART_READY")')
    if probe != 'SGLUNA_CRAFT_RESTART_READY':
        probe = command('/silent-command rcon.print("SGLUNA_CRAFT_RESTART_READY")')
    require(probe == 'SGLUNA_CRAFT_RESTART_READY', probe)

    # Production intentionally leaves post-load mutation pending in multiplayer
    # until the supervisor has RCON and calls this replicated repair boundary.
    # Mirror bindNpc() here before asserting that persisted Autorio-owned native
    # crafting was cancelled and its ownership marker was cleared.
    reconcile_result = json_command(
        lua_json(remote_call('autorio_actor', 'reconcile_after_load')),
        'owned crafting post-restart reconciliation',
    )
    require(reconcile_result.get('reconciled') is True, reconcile_result)
    require(reconcile_result.get('reason') == 'reconciled', reconcile_result)
    require(reconcile_result.get('actor_id') == actor_id, reconcile_result)
    require(isinstance(reconcile_result.get('tick'), int), reconcile_result)

    after = observe('owned crafting post-restart observation')
    validate_clock(after['runtime'])
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['actor_id'] == actor_id, after)
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)
    require(after['native_queue_length'] == 0, after)
    require(after.get('persisted_owner') is None, after)

    reconciliation = after.get('load_reconciliation') or {}
    require(reconciliation.get('policy') == 'discard_autorio_tasks_and_stop_npc_controls_on_load', reconciliation)
    require(reconciliation.get('owned_crafting_policy') == 'cancel_persisted_autorio_owned_native_queue_on_load', reconciliation)
    require(reconciliation.get('pending') is False, reconciliation)
    require(reconciliation.get('last_actor_id') == actor_id, reconciliation)
    owned = reconciliation.get('owned_crafting') or {}
    require(owned.get('actor_id') == actor_id, owned)
    require(owned.get('item_name') == before['item_name'], owned)
    require(owned.get('requested_count') == before['requested_count'], owned)
    require((owned.get('cancelled_queue_count') or 0) > 0, owned)

    # Cancellation on load must be durable: the native queue stays empty and no
    # additional requested output appears while Autorio remains idle.
    output_after_restart = after['output_count']
    time.sleep(2.0)
    quiet = observe('owned crafting post-restart quiet')
    require(quiet['native_queue_length'] == 0, quiet)
    require(quiet['task_state'] == 'idle' and quiet['queue_length'] == 0, quiet)
    require(quiet['output_count'] == output_after_restart, (after, quiet))

    # The same reacquired body must still be able to perform a fresh owned craft
    # after stale native work was reconciled.
    fresh_before = observe('fresh post-restart crafting before')
    admission = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '2')),
        'fresh post-restart crafting admission',
    )
    require(admission[0] is True, admission)
    wait_until_idle(operation_status, 'fresh post-restart native crafting', 20)
    fresh_after = observe('fresh post-restart crafting after')
    fresh_status = crafting_status('fresh post-restart crafting result')
    assert_completed(fresh_before, fresh_after, fresh_status, actor_id, 'iron-gear-wheel', 2)

    payload = {
        'status': 'pass',
        'actor_id': actor_id,
        'reconciliation': reconcile_result,
        'after_restart': after,
        'quiet': quiet,
        'fresh_before': fresh_before,
        'fresh_after': fresh_after,
        'fresh_crafting': fresh_status,
    }
    (results / 'crafting-restart.json').write_text(json.dumps(payload, indent=2))
    print(
        f'PASS: zero-player NPC restart cancelled persisted owned native crafting and completed fresh craft with actor_id={actor_id}',
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
        (args.results / 'crafting-restart-verify-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
