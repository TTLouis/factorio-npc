"""Verify exact non-resource mining can approach beyond legacy name-mining radius."""
import argparse
import json
import sys
import time
import uuid
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

    def custody_snapshot(target_id: int, context: str) -> dict:
        return json_command(
            f"/silent-command local a=game.get_entity_by_unit_number({actor_id}); assert(a and a.valid); "
            f"local target=game.get_entity_by_unit_number({target_id}); "
            "rcon.print(helpers.table_to_json({target_exists=target~=nil and target.valid,"
            "wooden_chest=a.get_main_inventory().get_item_count('wooden-chest'),position=a.position}))",
            context,
        )

    def authenticated_exact_mine(target_id: int, world_id: str, deployment: dict) -> dict:
        # Mirror the protocol-2 begin -> operation -> slot -> finish transaction
        # used by executeAuthorizedBatch. All calls share one native callback;
        # a direct operation RPC cannot capture removal ownership.
        key = f'exact-entity-mining/{uuid.uuid4()}'
        return json_command(
            "/silent-command local d=remote.call('sgluna_deployment','status'); "
            f"assert(d.allowed and d.idle and d.actor_id=={actor_id} "
            f"and d.epoch=={deployment['epoch']} and d.session=={deployment['session']!r}); "
            "assert(remote.call('sgluna_deployment','authorize',d.epoch)); "
            "local a=game.get_entity_by_unit_number(d.actor_id); assert(a and a.valid); "
            "local world=remote.call('sgluna_factory','world_identity'); "
            f"assert(world.ok and world.world_id=={world_id!r}); "
            "local journal=remote.call('autorio_operation_admission','status'); "
            f"local id={{operation_key={key!r},attempt_id={key!r},signature='mine_entity_exact:{target_id}',"
            "ordinal=journal.high_water+1,operation_count=1,actor_id=d.actor_id,epoch=d.epoch,surface_index=a.surface.index}; "
            "local begun=remote.call('autorio_operation_admission','begin',id); assert(begun.ok and not begun.duplicate,helpers.table_to_json(begun)); "
            f"local result=remote.call('autorio_operations','mine_entity_exact',{target_id}); "
            "local accepted=result==true or type(result)=='table' and result[1]==true; "
            "assert(accepted,helpers.table_to_json({result=result})); "
            "local after=remote.call('autorio_operations','status'); local batch=after.active_batch; assert(batch); "
            "local slot=remote.call('autorio_operation_admission','slot',id.operation_key,1,"
            "{ok=true,operation='mine_entity_exact',batch_refs={{batch_id=batch.batch_id,"
            "batch_generation=batch.batch_generation,batch_ref=batch.batch_ref}}}); assert(slot.ok,helpers.table_to_json(slot)); "
            "local finished=remote.call('autorio_operation_admission','finish',id.operation_key,{ok=true}); "
            "assert(finished.ok,helpers.table_to_json(finished)); "
            "rcon.print(helpers.table_to_json({accepted=accepted,identity=id,record=finished.record}))",
            'authenticated exact remote mining admission',
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

    # Configuration cancels work, so prove the prior operation is already idle
    # before establishing this fixture's isolated native session.
    session = f'exact-entity-mining/{uuid.uuid4()}'
    deployment = json_command(
        "/silent-command local before=remote.call('autorio_operations','status'); "
        "assert(before.task_state=='idle' and before.queue_empty and before.queue_length==0); "
        f"assert(remote.call('sgluna_deployment','configure','npc',{session!r})=={session!r}); "
        "rcon.print(helpers.table_to_json(remote.call('sgluna_deployment','status')))",
        'configure isolated exact mining native session at idle boundary',
    )
    require(deployment.get('allowed') is True and deployment.get('idle') is True, deployment)
    require(deployment.get('mode') == 'npc' and deployment.get('actor_kind') == 'standalone_character', deployment)
    require(deployment.get('actor_id') == actor_id and deployment.get('session') == session, deployment)
    require(isinstance(deployment.get('epoch'), int) and deployment['epoch'] > 0, deployment)

    # Bind only this native world's identity; this grants no removal custody.
    world = json_command(lua_json(remote_call('sgluna_factory', 'world_identity')), 'native world identity')
    if world.get('code') == 'world_unbound':
        world = json_command(
            lua_json(remote_call('sgluna_factory', 'bind_world_id', repr(str(uuid.uuid4())))),
            'bind exact mining fixture world',
        )
    require(world.get('ok') is True and world.get('world_id'), world)

    before = custody_snapshot(fixture['chest_id'], 'before unguarded exact mining')
    unguarded = operation_admission(
        remote_call('autorio_operations', 'mine_entity_exact', str(fixture['chest_id'])),
        'unguarded exact mining negative',
    )
    require(unguarded.get('accepted') is True, unguarded)
    unguarded_after = wait_until_idle(status, 'unguarded exact mining refusal', 8)
    unguarded_result = (unguarded_after.get('basic_operation') or {}).get('last_result') or {}
    require(unguarded_result.get('code') == 'entity_removal_uncertain' and unguarded_result.get('completed') is False, unguarded_after)
    require(unguarded_result.get('target_unit_number') == fixture['chest_id'], unguarded_after)
    unchanged = custody_snapshot(fixture['chest_id'], 'unguarded exact mining has no target or inventory effect')
    require(before['target_exists'] is True and unchanged['target_exists'] is True, unchanged)
    require(unchanged['wooden_chest'] == before['wooden_chest'], {'before': before, 'after': unchanged})
    require(unchanged['position'] == before['position'], {'before': before, 'after': unchanged})

    exact = authenticated_exact_mine(fixture['chest_id'], world['world_id'], deployment)
    require(exact.get('accepted') is True, exact)
    exact_after = wait_until_idle(status, 'exact remote mining auto approach', 20)
    exact_result = (exact_after.get('basic_operation') or {}).get('last_result') or {}
    require(exact_result.get('code') == 'completed' and exact_result.get('completed') is True, exact_after)
    require(exact_result.get('target_unit_number') == fixture['chest_id'], exact_after)

    journal = json_command(
        lua_json(remote_call('autorio_operation_admission', 'status', repr(exact['identity']['operation_key']))),
        'exact mining retained admission and custody receipt',
    )
    records = journal.get('records') or []
    require(len(records) == 1 and records[0].get('state') == 'completed', journal)
    removal = records[0].get('entity_removal') or {}
    require(removal.get('state') == 'verified' and removal.get('code') == 'removal_custody_verified', removal)
    require(removal.get('native_call') == 'returned_true' and removal.get('target_gone') is True, removal)
    require(removal.get('world_id') == world['world_id'], removal)
    require((removal.get('before') or {}).get('target', {}).get('unit_number') == fixture['chest_id'], removal)
    require(removal.get('operation_id') == exact_result.get('operation_id'), removal)
    require(all((removal.get('binding') or {}).get(field) == deployment[field]
                for field in ('actor_id', 'epoch', 'session')), removal)
    require((removal.get('binding') or {}).get('operation_key') == exact['identity']['operation_key'], removal)
    require((removal.get('binding') or {}).get('batch_ref') == (exact_after.get('last_completed_batch') or {}).get('batch_ref'), removal)

    inventory = custody_snapshot(fixture['chest_id'], 'exact mining inventory verification')
    recovered = sum(item['count'] for item in removal.get('recovered_items', []) if item['name'] == 'wooden-chest')
    require(inventory['target_exists'] is False and recovered >= 1, {'inventory': inventory, 'removal': removal})
    require(inventory['wooden_chest'] - before['wooden_chest'] == recovered, inventory)
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
        'deployment': deployment,
        'world_identity': world,
        'unguarded_failure': unguarded_after,
        'unguarded_before': before,
        'unguarded_after': unchanged,
        'exact_admission': exact,
        'exact_success': exact_after,
        'custody_journal': journal,
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
