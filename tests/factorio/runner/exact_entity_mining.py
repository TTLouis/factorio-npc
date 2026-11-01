"""Verify exact non-resource mining can approach beyond legacy name-mining radius."""
import argparse
import json
import sys
import time
from pathlib import Path

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'exact-entity-mining-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str):
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def operation_admission(expression: str, context: str) -> dict:
        return json_command(
            "/silent-command local result=" + expression + "; "
            "local accepted=false; local message=nil; "
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            "else accepted=result==true end; "
            "rcon.print(helpers.table_to_json({accepted=accepted,message=message}))",
            f'{context} admission',
        )

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        "assert(a); remote.call('autorio_operations','cancel_all_tasks'); "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position=a.position,radius=40}) do e.destroy() end; "
        "local p=s.find_non_colliding_position('wooden-chest',{x=a.position.x+12,y=a.position.y},8,0.5); assert(p); "
        "local c=s.create_entity{name='wooden-chest',position=p,force=a.force}; assert(c and c.unit_number); "
        "rcon.print(helpers.table_to_json({actor_id=a.unit_number,chest_id=c.unit_number,actor_position=a.position,chest_position=c.position}))",
        'exact mining fixture',
    )
    require(fixture['actor_id'] == actor_id, fixture)

    observed = json_command(
        lua_json(remote_call('autorio_tools', 'get_nearby_entities', '64', repr('wooden-chest'), 'nil', '10')),
        'observe remote chest',
    )
    matches = [entity for entity in observed.get('entities', []) if entity.get('unit_number') == fixture['chest_id']]
    require(len(matches) == 1, observed)
    actor_position = observed.get('actor_position') or {}
    target_position = matches[0].get('position') or {}
    distance = (
        ((target_position.get('x', 0) - actor_position.get('x', 0)) ** 2
         + (target_position.get('y', 0) - actor_position.get('y', 0)) ** 2) ** 0.5
    )
    require(distance > 5, observed)

    live_preflight = json_command(
        lua_json(remote_call(
            'autorio_preflight',
            'operation',
            repr('mine_entity_exact'),
            f"{{unit_number={fixture['chest_id']}}}",
        )),
        'live exact target preflight',
    )
    require(live_preflight.get('ok') is True and live_preflight.get('identity') == fixture['chest_id'], live_preflight)

    legacy = operation_admission(
        remote_call('autorio_operations', 'mine_entity', repr('wooden-chest'), '1'),
        'legacy remote name mine',
    )
    require(legacy.get('accepted') is True, legacy)
    legacy_after = wait_until_idle(status, 'legacy remote name mining failure', 8)
    legacy_result = (legacy_after.get('basic_operation') or {}).get('last_result') or {}
    require(legacy_result.get('code') == 'no_target', legacy_after)

    exact = operation_admission(
        remote_call('autorio_operations', 'mine_entity_exact', str(fixture['chest_id'])),
        'exact remote mining',
    )
    require(exact.get('accepted') is True, exact)
    exact_after = wait_until_idle(status, 'exact remote mining auto approach', 20)
    exact_result = (exact_after.get('basic_operation') or {}).get('last_result') or {}
    require(exact_result.get('code') == 'completed' and exact_result.get('completed') is True, exact_after)
    require(exact_result.get('target_unit_number') == fixture['chest_id'], exact_after)

    inventory = json_command(
        "/silent-command local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "rcon.print(helpers.table_to_json({wooden_chest=a.get_main_inventory().get_item_count('wooden-chest'),position=a.position}))",
        'exact mining inventory verification',
    )
    require(inventory.get('wooden_chest', 0) >= 1, inventory)

    replacement = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        f"local old={fixture['chest_id']}; local p={{x={fixture['chest_position']['x']},y={fixture['chest_position']['y']}}}; "
        "assert(a); a.teleport({x=p.x-6,y=p.y},s); "
        "local c=s.create_entity{name='wooden-chest',position=p,force=a.force}; "
        "assert(c and c.unit_number and c.unit_number~=old); "
        "rcon.print(helpers.table_to_json({replacement_id=c.unit_number,position=c.position}))",
        'replacement at old coordinate',
    )

    stale_preflight = json_command(
        lua_json(remote_call(
            'autorio_preflight',
            'operation',
            repr('mine_entity_exact'),
            f"{{unit_number={fixture['chest_id']}}}",
        )),
        'destroyed exact target preflight',
    )
    require(stale_preflight.get('ok') is False and stale_preflight.get('code') == 'stale_exact_target', stale_preflight)
    last_observed = stale_preflight.get('last_observed') or {}
    require(last_observed.get('unit_number') == fixture['chest_id'], stale_preflight)
    require(last_observed.get('position') == fixture['chest_position'], stale_preflight)

    replacement_observed = json_command(
        lua_json(remote_call('autorio_tools', 'get_nearby_entities', '16', repr('wooden-chest'), 'nil', '10')),
        'observe replacement chest',
    )
    replacement_matches = [
        entity for entity in replacement_observed.get('entities', [])
        if entity.get('unit_number') == replacement['replacement_id']
    ]
    require(len(replacement_matches) == 1, replacement_observed)
    require(replacement['replacement_id'] != fixture['chest_id'], replacement)

    replacement_preflight = json_command(
        lua_json(remote_call(
            'autorio_preflight',
            'operation',
            repr('mine_entity_exact'),
            f"{{unit_number={replacement['replacement_id']}}}",
        )),
        'replacement exact target preflight',
    )
    require(
        replacement_preflight.get('ok') is True
        and replacement_preflight.get('identity') == replacement['replacement_id'],
        replacement_preflight,
    )

    payload = {
        'status': 'pass',
        'fixture': fixture,
        'observation': observed,
        'live_preflight': live_preflight,
        'legacy_failure': legacy_after,
        'exact_success': exact_after,
        'inventory': inventory,
        'replacement': replacement,
        'stale_preflight': stale_preflight,
        'replacement_observation': replacement_observed,
        'replacement_preflight': replacement_preflight,
    }
    (results / 'exact-entity-mining.json').write_text(json.dumps(payload, indent=2))
    print(
        f"PASS: exact mining auto-approached unit={fixture['chest_id']}; stale identity was rejected before admission and replacement unit={replacement['replacement_id']} was rebound explicitly",
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
        (args.results / 'exact-entity-mining-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
