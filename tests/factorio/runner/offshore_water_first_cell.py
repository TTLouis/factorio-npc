#!/usr/bin/env python3
"""Provider-free native regression: water facts precede candidate-only pumps.

All terrain/items are declared test fixtures. Hidden tile reads are read-only;
the single native mine_tile call below is a harness mechanics probe, never an
NPC terrain mutation API. Zero humans, native speed one, real candidate build.
"""
import argparse
import json
import sys
from pathlib import Path

from run import connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


def require(condition, evidence):
    if not condition:
        raise AssertionError(json.dumps(evidence, sort_keys=True))


def run(client, results):
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    evidence = {'status': 'fail', 'scenario': 'offshore-water-first', 'transcript': []}
    output = results / 'offshore-water-first-cell.json'

    def command(text, label):
        raw = client.command(text)
        evidence['transcript'].append({'label': label, 'command': text, 'response': raw})
        output.write_text(json.dumps(evidence, indent=2))
        return decode_json(raw, label)

    actor = ("local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
             f"if e.unit_number=={actor_id} then a=e end end; assert(a); local s=a.surface; ")

    def lua(body, label):
        return command('/silent-command ' + actor + body, label)

    def tool(name, args, label):
        return command(lua_json(remote_call('autorio_tools', name, args)), label)

    def snapshot(label):
        return lua("local o=remote.call('autorio_operations','status'); rcon.print(helpers.table_to_json({"
                   "position=a.position,inventory=a.get_main_inventory().get_contents(),queue_length=o.queue_length,"
                   "task_state=o.task_state,pumps=#s.find_entities_filtered{type='offshore-pump'},humans=#game.connected_players,speed=game.speed}))", label)

    fixture = lua("remote.call('autorio_operations','cancel_all_tasks'); local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); "
                  "for _,e in pairs(s.find_entities_filtered{area={{ox-12,oy-12},{ox+12,oy+12}}}) do if e~=a then e.destroy() end end; "
                  "local t={}; for x=ox-12,ox+12 do for y=oy-12,oy+12 do t[#t+1]={name='grass-1',position={x,y}} end end; s.set_tiles(t,true,false,true); "
                  "t={}; for x=ox+5,ox+8 do for y=oy-2,oy+2 do t[#t+1]={name='water',position={x,y}} end end; s.set_tiles(t,true,false,true); "
                  "for _,p in pairs(t) do p.name='landfill' end; s.set_tiles(t,true,false,true); "
                  "a.get_main_inventory().clear(); a.insert{name='offshore-pump',count=1}; game.speed=1; "
                  "local tile=s.get_tile(ox+5,oy); rcon.print(helpers.table_to_json({ox=ox,oy=oy,actor_id=a.unit_number,"
                  "cover=tile.name,hidden_tile=tile.hidden_tile,minable=tile.prototype.mineable_properties.minable,humans=#game.connected_players}))", 'fixture')
    evidence['fixture'] = fixture
    require(fixture['cover'] == 'landfill' and fixture['hidden_tile'] == 'water' and fixture['minable'] is True and fixture['humans'] == 0, fixture)
    before = snapshot('before refusals')
    request = "{entity_name='offshore-pump',radius=4,limit=8}"
    premature = tool('get_placement_candidates', request, 'pump lookup before water')
    require(premature.get('ok') is False and premature.get('code') == 'water_search_required', premature)
    require(snapshot('after water-first refusal') == before, {'before': before})

    for args in ["{'offshore-pump'}", f"{{'offshore-pump',{fixture['ox']+2.5},{fixture['oy']+0.5},4}}"]:
        preflight = command(lua_json(remote_call('autorio_preflight', 'operation', "'place_entity'," + args)), 'generic pump preflight')
        require(preflight.get('code') == 'placement_candidate_required' and preflight.get('ok') is False, preflight)
    for coordinates in ['', f",{fixture['ox']+2.5},{fixture['oy']+0.5},4"]:
        result = lua("local accepted,message=remote.call('autorio_operations','place_entity','offshore-pump'" + coordinates + "); "
                     "rcon.print(helpers.table_to_json({accepted=accepted,message=message}))", 'raw generic pump')
        require(result.get('accepted') is False, result)
        require(snapshot('after generic refusal') == before, before)

    fluid = tool('get_fluid_source_tiles', "{fluid_name='water',search_radius=12,limit=8}", 'read covered water')
    hints = fluid.get('covered_fluid_hints') or []
    require(fluid.get('ok') is True and not fluid.get('samples') and len(hints) > 0, fluid)
    require(all(h.get('hidden_tile') == 'water' and h.get('placement_authority') is False and h.get('cover_minable') is True for h in hints), fluid)
    require(snapshot('after read-only hidden hints') == before, before)
    covered = tool('get_placement_candidates', request, 'covered water cannot become candidate authority')
    require(covered.get('code') == 'water_source_not_exposed', covered)

    exposed = lua(f"local p={{x={fixture['ox']+5},y={fixture['oy']}}}; local before=s.get_tile(p); "
                  "local old={name=before.name,hidden_tile=before.hidden_tile}; local mined=a.mine_tile(before); local after=s.get_tile(p); "
                  "rcon.print(helpers.table_to_json({before=old,mined=mined,after=after.name,fluid=after.prototype.fluid and after.prototype.fluid.name}))", 'native landfill mining mechanics')
    require(exposed.get('mined') is True and exposed.get('after') == 'water' and exposed.get('fluid') == 'water', exposed)
    fluid = tool('get_fluid_source_tiles', "{fluid_name='water',search_radius=12,limit=8}", 'refresh exposed water')
    require(len(fluid.get('samples') or []) > 0, fluid)
    choices = tool('get_placement_candidates', request, 'candidate search after water')
    require(choices.get('ok') is True and len(choices.get('candidates') or []) > 0, choices)
    candidate = choices['candidates'][0]
    accepted = lua("local ok,message=remote.call('autorio_operations','place_candidate'," + repr(choices['candidate_set_id']) + ',' + repr(candidate['id']) + "); "
                   "rcon.print(helpers.table_to_json({accepted=ok,message=message}))", 'candidate pump build')
    require(accepted.get('accepted') is True, accepted)
    status = wait_until_idle(lambda label: command(operation_status_command(), label), 'candidate pump build', 30)
    receipt = (status.get('basic_operation') or {}).get('last_result') or {}
    require(receipt.get('completed') is True, receipt)
    final = lua("local p=s.find_entities_filtered{type='offshore-pump'}[1]; assert(p); rcon.print(helpers.table_to_json({"
                "name=p.name,position=p.position,source_tile=p.get_fluid_source_tile(),source_fluid=p.get_fluid_source_fluid(),"
                "humans=#game.connected_players,speed=game.speed,inventory=a.get_main_inventory().get_contents()}))", 'built native pump')
    require(final.get('source_fluid') == 'water' and final.get('humans') == 0 and final.get('speed') == 1, final)
    evidence.update(status='pass', fluid=fluid, covered=covered, exposed=exposed, choices=choices, final=final)
    output.write_text(json.dumps(evidence, indent=2))
    print('PASS: offshore-water-first: hidden hints, water-first admission, generic bypass refusal and native candidate build', flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', required=True, type=int)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', required=True, type=Path)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'offshore-water-first-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
