"""Save while SGLuna owns a live native crafting queue so load reconciliation can be verified."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, validate_clock


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path, save_path: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    crafting = json.loads((results / 'crafting.json').read_text())
    actor_id = crafting['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'crafting-restart-prepare-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    initial = json_command(operation_status_command(), 'craft restart initial status')
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    require(initial['actor']['actor_id'] == actor_id, initial)

    fixture = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a,'craft restart NPC missing'); "
        "remote.call('autorio_operations','cancel_all_tasks'); local q=a.crafting_queue; "
        "while q and #q>0 do local e=q[#q]; a.cancel_crafting{index=e.index,count=e.count}; q=a.crafting_queue end; "
        "local inv=a.get_main_inventory(); inv.clear(); assert(inv.insert{name='iron-plate',count=1000}==1000); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,iron=inv.get_item_count('iron-plate'),gears=inv.get_item_count('iron-gear-wheel'),tick=game.tick}))",
        'craft restart fixture',
    )
    require(fixture['actor_id'] == actor_id and fixture['iron'] == 1000 and fixture['gears'] == 0, fixture)

    admission = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '300')),
        'craft restart admission',
    )
    require(admission[0] is True, admission)
    queued = json_command(lua_json(remote_call('autorio_operations', 'wait', '300')), 'craft restart dependent wait')
    require(queued[0] is True, queued)

    observation_command = (
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "local o=remote.call('autorio_operations','status'); local c=remote.call('autorio_crafting','status'); "
        "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
        "local inv=a.get_main_inventory(); local q=a.crafting_queue or {}; "
        "o.iron=inv.get_item_count('iron-plate'); o.gears=inv.get_item_count('iron-gear-wheel'); "
        "o.native_queue_length=#q; o.persisted_owner=c.persisted_owner; o.crafting_last_result=c.last_result; "
        "rcon.print(helpers.table_to_json(o))"
    )

    deadline = time.monotonic() + 8.0
    before = None
    while time.monotonic() < deadline:
        candidate = json_command(observation_command, 'active craft restart observation')
        validate_clock(candidate['runtime'])
        owner = candidate.get('persisted_owner') or {}
        if candidate['task_state'] == 'crafting' and candidate['native_queue_length'] > 0 and owner.get('actor_id') == actor_id:
            before = candidate
            break
        time.sleep(0.05)
    require(before is not None, 'owned native crafting never became active before restart save')
    require(before['queue_length'] == 1 and before['queued_task_types'] == ['waiting'], before)
    owner = before['persisted_owner']
    require(owner['actor_id'] == actor_id and owner['item_name'] == 'iron-gear-wheel' and owner['requested_count'] == 300, owner)
    require(before['runtime']['connected_players'] == 0, before)

    old_mtime = save_path.stat().st_mtime_ns
    command('/silent-command game.server_save()')
    save_deadline = time.monotonic() + 20.0
    while time.monotonic() < save_deadline:
        stat = save_path.stat()
        if stat.st_mtime_ns > old_mtime and stat.st_size > 0:
            break
        time.sleep(0.1)
    else:
        raise AssertionError(f'owned crafting server save did not update {save_path}')

    payload = {
        'status': 'prepared',
        'actor_id': actor_id,
        'item_name': 'iron-gear-wheel',
        'requested_count': 300,
        'before_save': before,
        'saved_file_mtime_ns': save_path.stat().st_mtime_ns,
        'saved_file_size': save_path.stat().st_size,
    }
    (results / 'crafting-restart-before.json').write_text(json.dumps(payload, indent=2))
    print(
        f"[npc-test] Saved owned native crafting for restart: actor_id={actor_id}, "
        f"native_queue={before['native_queue_length']}, queued={before['queue_length']}",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--save', type=Path, required=True)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results, args.save)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'crafting-restart-prepare-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
