#!/usr/bin/env python3
"""Exact entity observation: two native furnaces, stale identity and body scope.

Scripted fixtures distinguish the machines; native smelting supplies the recipe
and output. No provider, operator client, or gameplay completion is involved.
"""
import argparse
import json
import sys
import time
from pathlib import Path

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call


def require(condition: bool, detail: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(detail, sort_keys=True))


def run(client: Rcon, results: Path) -> None:
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    evidence = {'status': 'fail', 'actor_id': actor_id, 'transcript': []}

    def command(text: str, context: str):
        response = client.command(text)
        evidence['transcript'].append({'context': context, 'command': text, 'response': response})
        (results / 'exact-entity-status-cell.json').write_text(json.dumps(evidence, indent=2))
        return decode_json(response, context)

    actor = (
        "local a=nil; for _,s in pairs(game.surfaces) do for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end end; assert(a); local s=a.surface; "
    )
    fixture = command(
        '/silent-command ' + actor +
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'for _,e in pairs(s.find_entities_filtered{area={{ox-9,oy-9},{ox+9,oy+9}}}) do '
        "if e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-9,ox+9 do for y=oy-9,oy+9 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; s.set_tiles(tiles,true,false,true); "
        "local near=s.create_entity{name='stone-furnace',position={ox+3,oy},force=a.force}; "
        "local far=s.create_entity{name='stone-furnace',position={ox+7,oy},force=a.force}; assert(near and far); "
        "far.get_fuel_inventory().insert{name='coal',count=2}; "
        "far.get_inventory(defines.inventory.crafter_input).insert{name='iron-ore',count=8}; "
        'local speed=game.speed; game.speed=1; '
        'rcon.print(helpers.table_to_json({near=near.unit_number,far=far.unit_number,ox=ox,oy=oy,x=a.position.x,y=a.position.y,surface=s.index,speed=speed}))',
        'two-furnace fixture',
    )
    evidence['fixture'] = fixture
    far_unit = fixture['far']
    near_unit = fixture['near']

    def status(unit: int, context: str):
        return command(lua_json(remote_call('autorio_tools', 'get_entity_status', 'nil', 'nil', str(unit))), context)

    lookup_far = f"local f=nil; for _,e in pairs(s.find_entities_filtered{{name='stone-furnace'}}) do if e.unit_number=={far_unit} then f=e end end; assert(f); "
    try:
        command(lua_json(remote_call('autorio_tools', 'get_nearby_entities', '16', repr('stone-furnace'), 'nil', '20')), 'remember both ordinary building identities')
        nearest = command(lua_json(remote_call('autorio_tools', 'get_entity_status', repr('stone-furnace'), '16')), 'legacy nearest furnace')
        require(nearest.get('found') is True and nearest['entity']['unit_number'] == near_unit, nearest)
        deadline = time.monotonic() + 12
        while True:
            exact = status(far_unit, 'exact native smelting furnace')
            require(exact.get('found') is True and exact['entity']['unit_number'] == far_unit, exact)
            items = [item for inventory in exact['entity'].get('inventories', []) for item in inventory.get('items', [])]
            if any(item.get('name') == 'iron-plate' and item.get('count', 0) >= 1 for item in items):
                break
            require(time.monotonic() < deadline, {'native_output_missing': exact})
            time.sleep(0.3)
        require(exact['entity'].get('recipe') == 'iron-plate', exact)
        evidence['native_exact'] = exact
        command('/silent-command ' + actor + lookup_far + "f.force=game.forces.enemy; rcon.print('{}')", 'change target force')
        foreign = status(far_unit, 'reject different force')
        require(foreign.get('found') is False and foreign.get('error') == 'exact_entity_not_found', foreign)
        command('/silent-command ' + actor + lookup_far + "f.force=a.force; rcon.print('{}')", 'restore target force')
        command(lua_json(remote_call('autorio_tools', 'get_nearby_entities', '16', repr('stone-furnace'), 'nil', '20')), 'refresh restored-force lookup hint')
        require(status(far_unit, 'restored target remains readable').get('found') is True, 'force restoration must restore exact readability')
        command('/silent-command ' + actor +
                "local other=game.create_surface('exact-status-other',{width=32,height=32}); "
                'other.request_to_generate_chunks({0,0},1); other.force_generate_chunk_requests(); '
                "local tiles={}; for x=-3,3 do for y=-3,3 do tiles[#tiles+1]={name='landfill',position={x,y}} end end; other.set_tiles(tiles,true,false,true); "
                "assert(a.teleport({0,0},other)); rcon.print('{}')", 'move body to another surface')
        other_surface = status(far_unit, 'reject different surface')
        require(other_surface.get('found') is False and other_surface.get('error') == 'exact_entity_not_found', other_surface)
        command('/silent-command ' + actor +
                f"assert(a.teleport({{{fixture['x']},{fixture['y']}}},game.get_surface({fixture['surface']}))); rcon.print('{{}}')", 'restore body surface')
        command('/silent-command ' + actor + lookup_far +
                "local pos=f.position; f.destroy(); local replacement=s.create_entity{name='stone-furnace',position=pos,force=a.force}; assert(replacement); rcon.print('{}')", 'replace target at same position')
        stale = status(far_unit, 'reject destroyed exact identity despite replacement and nearer furnace')
        require(stale.get('found') is False and stale.get('error') == 'exact_entity_not_found', stale)
        require(status(near_unit, 'other furnace remains readable').get('found') is True, 'nearer furnace must remain readable')
    finally:
        command('/silent-command ' + actor +
                f"assert(a.teleport({{{fixture['x']},{fixture['y']}}},game.get_surface({fixture['surface']}))); game.speed={fixture['speed']}; "
                f"local home=game.get_surface({fixture['surface']}); for _,e in pairs(home.find_entities_filtered{{name='stone-furnace',area={{{{{fixture['ox']-9},{fixture['oy']-9}}},{{{fixture['ox']+9},{fixture['oy']+9}}}}}}}) do e.destroy() end; "
                "local other=game.get_surface('exact-status-other'); if other then game.delete_surface(other) end; rcon.print('{}')", 'restore fixture body and speed')
    evidence['status'] = 'pass'
    (results / 'exact-entity-status-cell.json').write_text(json.dumps(evidence, indent=2))
    print('PASS: exact furnace native recipe/output; force, surface and replacement guards; legacy nearest retained', flush=True)


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
        (args.results / 'exact-entity-status-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
