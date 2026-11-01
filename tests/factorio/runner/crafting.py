"""Verify bounded, ownership-safe native hand crafting on the zero-player NPC."""
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


def assert_completed(before: dict, after: dict, crafting: dict, actor_id: int, item_name: str, count: int) -> None:
    validate_clock(after['runtime'])
    require(after['runtime']['tick'] > before['runtime']['tick'], (before, after))
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['actor_id'] == actor_id, after)
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)
    require(after['native_queue_length'] == 0, after)
    require(after['output_count'] >= before['output_count'] + count, (before, after))

    result = crafting.get('last_result') or {}
    require(crafting.get('task_active') is False, crafting)
    require(result.get('accepted') is True and result.get('completed') is True, crafting)
    require(result.get('code') == 'completed', crafting)
    require(result.get('actor_id') == actor_id, crafting)
    require(result.get('item_name') == item_name, crafting)
    require(result.get('requested_count') == count and result.get('started_count') == count, crafting)
    require((result.get('output_count_after') or 0) >= (result.get('output_count_before') or 0) + count, crafting)
    require(result.get('native_queue_remaining') == 0, crafting)


def assert_busy_preserved(before: dict, after: dict, crafting: dict, actor_id: int) -> None:
    validate_clock(after['runtime'])
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['actor_id'] == actor_id, after)
    require(before['native_queue_length'] > 0, before)
    require(after['native_queue_length'] == before['native_queue_length'], (before, after))
    require(after['native_queue_recipe'] == before['native_queue_recipe'], (before, after))
    require(after['native_queue_count'] == before['native_queue_count'], (before, after))
    result = crafting.get('last_result') or {}
    require(result.get('accepted') is False and result.get('completed') is False, crafting)
    require(result.get('code') == 'native_queue_busy', crafting)


def assert_cancelled(before: dict, after: dict, crafting: dict, actor_id: int) -> None:
    validate_clock(after['runtime'])
    require(after['runtime']['tick'] >= before['runtime']['tick'], (before, after))
    require(after['runtime']['connected_players'] == 0, after)
    require(after['actor']['actor_id'] == actor_id, after)
    require(before['native_queue_length'] > 0, before)
    require(after['native_queue_length'] == 0, after)
    require(after['task_state'] == 'idle' and after['queue_empty'] is True and after['queue_length'] == 0, after)
    result = crafting.get('last_result') or {}
    require(crafting.get('task_active') is False, crafting)
    require(result.get('accepted') is False and result.get('completed') is False, crafting)
    require(result.get('code') == 'cancelled', crafting)
    require(result.get('actor_id') == actor_id, crafting)


def assert_rejected(crafting: dict, actor_id: int, code: str) -> None:
    result = crafting.get('last_result') or {}
    require(crafting.get('task_active') is False, crafting)
    require(result.get('accepted') is False and result.get('completed') is False, crafting)
    require(result.get('code') == code, crafting)
    require(result.get('actor_id') == actor_id, crafting)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    navigation = json.loads((results / 'navigation.json').read_text())
    actor_id = navigation['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'crafting-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def crafting_status(context: str) -> dict:
        return json_command(lua_json(remote_call('autorio_crafting', 'status')), context)

    def actor_observation(item_name: str, context: str) -> dict:
        return json_command(
            "/silent-command local s=game.surfaces[1]; local a=nil; "
            "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e end end; assert(a,'crafting NPC missing'); "
            "local o=remote.call('autorio_operations','status'); "
            "o.runtime={tick=game.tick,tick_paused=game.tick_paused,speed=game.speed,connected_players=#game.connected_players}; "
            "local inv=a.get_main_inventory(); o.output_count=inv.get_item_count(" + repr(item_name) + "); "
            "local q=a.crafting_queue or {}; o.native_queue_length=#q; "
            "o.native_queue_recipe=q[1] and q[1].recipe or nil; o.native_queue_count=q[1] and q[1].count or 0; "
            "rcon.print(helpers.table_to_json(o))",
            context,
        )

    def clear_native_queue_and_inventory(ingredients: dict[str, int], context: str) -> dict:
        inserts = '; '.join(
            f"assert(inv.insert{{name={name!r},count={count}}}=={count})"
            for name, count in ingredients.items()
        ) or 'do end'
        return json_command(
            "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
            "remote.call('autorio_operations','cancel_all_tasks'); "
            "local q=a.crafting_queue; while q and #q>0 do local e=q[#q]; a.cancel_crafting{index=e.index,count=e.count}; q=a.crafting_queue end; "
            "local inv=a.get_main_inventory(); inv.clear(); "
            + inserts + "; "
            "q=a.crafting_queue or {}; rcon.print(helpers.table_to_json({actor_id=a.unit_number,queue_length=#q,tick=game.tick}))",
            context,
        )

    initial = operation_status('crafting initial status')
    require(initial['task_state'] == 'idle' and initial['queue_length'] == 0, initial)
    require(initial['actor']['actor_id'] == actor_id, initial)

    # Case 1: completion must be backed by real inventory output, not merely a
    # disappearing native queue.
    clear_native_queue_and_inventory({'iron-plate': 20}, 'craft completion fixture')
    before = actor_observation('iron-gear-wheel', 'craft completion before')
    admission = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '3')),
        'craft completion admission',
    )
    require(admission[0] is True, admission)
    wait_until_idle(operation_status, 'owned native crafting completion', 20)
    after = actor_observation('iron-gear-wheel', 'craft completion after')
    completed_status = crafting_status('craft completion result')
    assert_completed(before, after, completed_status, actor_id, 'iron-gear-wheel', 3)

    # Case 2: an unrelated native queue is not Autorio-owned. Use the same
    # already-proven hand-craftable recipe as the Autorio request: ownership,
    # not recipe identity, is the boundary. The request must fail closed without
    # cancelling, appending to, replacing, or merging the pre-existing queue.
    clear_native_queue_and_inventory({'iron-plate': 1000}, 'busy queue fixture')
    busy_setup = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "local started=a.begin_crafting{count=50,recipe='iron-gear-wheel'}; local q=a.crafting_queue or {}; "
        "rcon.print(helpers.table_to_json({started=started,queue_length=#q,recipe=q[1] and q[1].recipe or nil,count=q[1] and q[1].count or 0,tick=game.tick}))",
        'pre-existing native craft setup',
    )
    require(busy_setup['started'] == 50 and busy_setup['queue_length'] > 0, busy_setup)
    busy_before = actor_observation('iron-gear-wheel', 'busy queue before')
    busy_admission = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '2')),
        'busy queue admission',
    )
    require(busy_admission[0] is False, busy_admission)
    busy_after = actor_observation('iron-gear-wheel', 'busy queue after')
    busy_status = crafting_status('busy queue result')
    assert_busy_preserved(busy_before, busy_after, busy_status, actor_id)

    # Case 3: explicit Autorio cancellation owns the queue only because the
    # request started from an empty native queue. Queue a dependent wait as well
    # and require both layers to stop, then prove no more output appears later.
    clear_native_queue_and_inventory({'iron-plate': 1000}, 'craft cancellation fixture')
    cancel_admission = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '300')),
        'craft cancellation admission',
    )
    require(cancel_admission[0] is True, cancel_admission)
    queued_wait = json_command(lua_json(remote_call('autorio_operations', 'wait', '300')), 'craft cancellation dependent wait')
    require(queued_wait[0] is True, queued_wait)

    active_deadline = time.monotonic() + 8.0
    cancel_before = None
    while time.monotonic() < active_deadline:
        candidate = actor_observation('iron-gear-wheel', 'craft cancellation active wait')
        validate_clock(candidate['runtime'])
        if candidate['task_state'] == 'crafting' and candidate['native_queue_length'] > 0:
            cancel_before = candidate
            break
        time.sleep(0.05)
    require(cancel_before is not None, 'owned native crafting queue never became active')
    require(cancel_before['queue_length'] == 1 and cancel_before['queued_task_types'] == ['waiting'], cancel_before)

    cancel_response = command("/silent-command rcon.print(tostring(remote.call('autorio_operations','cancel_all_tasks')))" )
    require(cancel_response == 'true', cancel_response)
    cancel_after = actor_observation('iron-gear-wheel', 'craft cancellation after')
    cancel_status = crafting_status('craft cancellation result')
    assert_cancelled(cancel_before, cancel_after, cancel_status, actor_id)

    cancelled_output = cancel_after['output_count']
    time.sleep(2.0)
    cancel_quiet = actor_observation('iron-gear-wheel', 'craft cancellation quiet')
    require(cancel_quiet['native_queue_length'] == 0, cancel_quiet)
    require(cancel_quiet['output_count'] == cancelled_output, (cancel_after, cancel_quiet))
    require(cancel_quiet['task_state'] == 'idle' and cancel_quiet['queue_length'] == 0, cancel_quiet)

    # Case 4: bounded admission failures are explicit and do not create work.
    clear_native_queue_and_inventory({}, 'craft rejection fixture')
    no_ingredients = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '2')),
        'craft missing ingredients admission',
    )
    require(no_ingredients[0] is False, no_ingredients)
    no_ingredients_status = crafting_status('craft missing ingredients result')
    assert_rejected(no_ingredients_status, actor_id, 'not_enough_ingredients')

    invalid_recipe = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('sgluna-not-a-recipe'), '1')),
        'craft invalid recipe admission',
    )
    require(invalid_recipe[0] is False, invalid_recipe)
    invalid_recipe_status = crafting_status('craft invalid recipe result')
    assert_rejected(invalid_recipe_status, actor_id, 'recipe_unavailable')

    invalid_count = json_command(
        lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '1001')),
        'craft invalid count admission',
    )
    require(invalid_count[0] is False, invalid_count)
    invalid_count_status = crafting_status('craft invalid count result')
    assert_rejected(invalid_count_status, actor_id, 'invalid_count')

    final = operation_status('crafting final status')
    require(final['task_state'] == 'idle' and final['queue_empty'] is True and final['queue_length'] == 0, final)
    require(final['actor']['actor_id'] == actor_id, final)

    payload = {
        'status': 'pass',
        'actor_id': actor_id,
        'completion': {'before': before, 'after': after, 'crafting': completed_status},
        'busy_queue': {'before': busy_before, 'after': busy_after, 'crafting': busy_status},
        'cancellation': {'before': cancel_before, 'after': cancel_after, 'quiet': cancel_quiet, 'crafting': cancel_status},
        'rejections': {
            'missing_ingredients': no_ingredients_status,
            'invalid_recipe': invalid_recipe_status,
            'invalid_count': invalid_count_status,
        },
    }
    (results / 'crafting.json').write_text(json.dumps(payload, indent=2))
    print(
        f'PASS: zero-player NPC native crafting verified real output, preserved unrelated queue, '
        f'and cancelled owned work with actor_id={actor_id}',
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
        (args.results / 'crafting-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
