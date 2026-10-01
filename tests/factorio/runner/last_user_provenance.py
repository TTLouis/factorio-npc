"""MW1 engine lane: what Factorio's LuaEntity.last_user reports for NPC, script and map entities.

The owner decision for protected assets is "a human last_user marks an entity player-built".
That rule is only sound if the standalone NPC character (no LuaPlayer) leaves last_user empty on
what it builds, and if reading last_user does not break exact-target preflight for any entity kind
the NPC mines. This lane asserts both in a real zero-player engine and records what could NOT be
exercised offline (a connected human) so the limit is explicit rather than assumed.
"""
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
        (results / 'last-user-provenance-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str):
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    actor_lookup = (
        "local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        "assert(a); "
    )

    # Zero connected humans is the valid operating state this lane runs in.
    humans = json_command(
        "/silent-command rcon.print(helpers.table_to_json({connected=#game.connected_players,players=#game.players}))",
        'human count',
    )
    require(humans['connected'] == 0, humans)

    # 1. NPC placement through the real place_entity operation (standalone character, no LuaPlayer).
    fixture = json_command(
        "/silent-command " + actor_lookup +
        "remote.call('autorio_operations','cancel_all_tasks'); "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest',position=a.position,radius=40}) do e.destroy() end; "
        "local added=a.get_main_inventory().insert{name='wooden-chest',count=2}; "
        "rcon.print(helpers.table_to_json({added=added}))",
        'placement fixture',
    )
    require(fixture['added'] == 2, fixture)
    accepted = command(
        "/silent-command rcon.print(tostring(" + remote_call('autorio_operations', 'place_entity', repr('wooden-chest')) + "))"
    )
    require(accepted == 'true', accepted)
    placed_status = wait_until_idle(status, 'NPC placement', 10)
    receipt = (placed_status.get('basic_operation') or {}).get('last_result') or {}
    require(receipt.get('code') == 'completed' and isinstance(receipt.get('placed_unit_number'), int), receipt)
    npc_unit = receipt['placed_unit_number']
    # The receipt carries no human last_user for an NPC placement.
    require(receipt.get('placed_last_user') in (None, ''), receipt)

    npc_entity = json_command(
        "/silent-command local e=game.get_entity_by_unit_number(" + str(npc_unit) + "); assert(e and e.valid); "
        "local ok,user=pcall(function() return e.last_user end); "
        "rcon.print(helpers.table_to_json({access_ok=ok,has_last_user=(ok and user~=nil) or false,name=e.name}))",
        'NPC-placed entity last_user',
    )
    require(npc_entity['access_ok'] is True, npc_entity)
    require(npc_entity['has_last_user'] is False, npc_entity)

    # 2. A script-created entity (create_entity without a player) is also unowned.
    script_entity = json_command(
        "/silent-command " + actor_lookup +
        "local p=s.find_non_colliding_position('wooden-chest',{x=a.position.x+6,y=a.position.y+3},8,0.5); assert(p); "
        "local c=s.create_entity{name='wooden-chest',position=p,force=a.force}; assert(c and c.unit_number); "
        "local ok,user=pcall(function() return c.last_user end); "
        "rcon.print(helpers.table_to_json({unit=c.unit_number,access_ok=ok,has_last_user=(ok and user~=nil) or false}))",
        'script-created entity last_user',
    )
    require(script_entity['access_ok'] is True and script_entity['has_last_user'] is False, script_entity)

    # 3. The harness-facing exact-target preflight reports provenance without breaking: no last_user for either
    #    unowned entity, and it keeps working on a non-chest exact target (a tree or rock) where one has a unit number.
    def preflight(unit: int, context: str) -> dict:
        return json_command(
            lua_json(remote_call('autorio_preflight', 'operation', repr('mine_entity_exact'), f'{{unit_number={unit}}}')),
            context,
        )

    npc_preflight = preflight(npc_unit, 'NPC entity preflight')
    require(npc_preflight.get('ok') is True and npc_preflight['target'].get('last_user') is None, npc_preflight)
    script_preflight = preflight(script_entity['unit'], 'script entity preflight')
    require(script_preflight.get('ok') is True and script_preflight['target'].get('last_user') is None, script_preflight)

    nature = json_command(
        "/silent-command " + actor_lookup +
        "local found=nil; "
        "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=120,type={'tree','simple-entity'}}) do "
        "if e.unit_number then found=e; break end end; "
        "if not found then rcon.print(helpers.table_to_json({found=false})) else "
        "local ok,user=pcall(function() return found.last_user end); "
        "rcon.print(helpers.table_to_json({found=true,unit=found.unit_number,name=found.name,"
        "access_ok=ok,has_last_user=(ok and user~=nil) or false})) end",
        'map entity last_user',
    )
    nature_preflight = None
    if nature.get('found'):
        require(nature['access_ok'] is True and nature['has_last_user'] is False, nature)
        nature_preflight = preflight(nature['unit'], 'map entity preflight')
        require(nature_preflight.get('ok') is True and nature_preflight['target'].get('last_user') is None, nature_preflight)

    # 4. What a connected human would do cannot be exercised here (zero players, headless): record it.
    human_arm = json_command(
        "/silent-command local c=game.surfaces[1].find_entities_filtered{name='wooden-chest',limit=1}[1]; "
        "local ok=pcall(function() c.last_user='no-such-player' end); "
        "rcon.print(helpers.table_to_json({players_known_to_save=#game.players,can_set_without_player=ok}))",
        'human arm probe',
    )
    require(human_arm['can_set_without_player'] is False, human_arm)

    payload = {
        'status': 'pass',
        'humans': humans,
        'npc_receipt': receipt,
        'npc_entity': npc_entity,
        'script_entity': script_entity,
        'npc_preflight': npc_preflight,
        'script_preflight': script_preflight,
        'map_entity': nature,
        'map_preflight': nature_preflight,
        'human_arm': human_arm,
        'not_exercised': 'a connected human building or configuring an entity (no LuaPlayer exists in the zero-player headless lane)',
    }
    (results / 'last-user-provenance.json').write_text(json.dumps(payload, indent=2))
    print(
        'PASS: NPC, script and map entities report no last_user and exact-target preflight carries provenance; '
        'the human arm is recorded as not exercisable offline',
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
        (args.results / 'last-user-provenance-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
