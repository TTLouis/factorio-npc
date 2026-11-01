#!/usr/bin/env python3
"""Native standalone actor cover removal followed by freshly validated pump build.

Terrain and items are declared fixtures only at setup; the NPC operation itself
must reclaim cover through native deconstruction proxy mining. No provider calls.
"""
import argparse
import json
import sys
import time
from pathlib import Path
from run import connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


def require(ok, evidence):
    if not ok:
        raise AssertionError(json.dumps(evidence, sort_keys=True))


def run(client, results):
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    evidence = {'status': 'fail', 'scenario': 'pump-landfill-removal', 'transcript': []}
    output = results / 'pump-landfill-removal-cell.json'
    def command(text, label):
        raw = client.command(text)
        evidence['transcript'].append({'label': label, 'command': text, 'response': raw})
        output.write_text(json.dumps(evidence, indent=2))
        return decode_json(raw, label)
    prefix = ("local a=game.get_entity_by_unit_number(" + str(actor_id) + "); assert(a and a.valid); local s=a.surface; ")
    def lua(body, label): return command('/silent-command ' + prefix + body, label)
    def tool(name, args, label): return command(lua_json(remote_call('autorio_tools', name, args)), label)
    def status(label): return command(operation_status_command(), label)
    def snap(label):
        return lua("local p=storage.pump_landfill_fixture; local tiles={}; for x=p.ox+5,p.ox+8 do for y=p.oy-2,p.oy+2 do local t=s.get_tile(x,y); tiles[#tiles+1]={name=t.name,hidden=t.hidden_tile,position=t.position} end end; "
                   "rcon.print(helpers.table_to_json({tick=game.tick,inventory=a.get_main_inventory().get_contents(),tiles=tiles,proxies=#s.find_entities_filtered{type='deconstructible-tile-proxy'},ghosts=#s.find_entities_filtered{type='entity-ghost'},humans=#game.connected_players,position=a.position}))", label)
    fixture = lua("remote.call('autorio_operations','cancel_all_tasks'); local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); "
                  "for _,e in pairs(s.find_entities_filtered{area={{ox-12,oy-12},{ox+12,oy+12}}}) do if e~=a then e.destroy() end end; "
                  "local t={}; for x=ox-12,ox+12 do for y=oy-12,oy+12 do t[#t+1]={name='grass-1',position={x,y}} end end; s.set_tiles(t,true,false,true); "
                  "t={}; for x=ox+5,ox+8 do for y=oy-2,oy+2 do t[#t+1]={name='water',position={x,y}} end end; s.set_tiles(t,true,false,true); "
                  "for _,v in pairs(t) do v.name='landfill' end; s.set_tiles(t,true,false,true); "
                  "a.get_main_inventory().clear(); a.insert{name='offshore-pump',count=1}; assert(a.teleport({ox+2.5,oy+0.5})); game.speed=1; storage.pump_landfill_fixture={ox=ox,oy=oy}; "
                  "rcon.print(helpers.table_to_json({ox=ox,oy=oy,actor_id=a.unit_number,humans=#game.connected_players,speed=game.speed}))", 'fixture')
    evidence['fixture'] = fixture
    require(fixture['humans'] == 0 and fixture['speed'] == 1, fixture)
    request = f"{{x={fixture['ox']+4.5},y={fixture['oy']+0.5},direction=4}}"
    def read(label): return tool('get_fluid_source_tiles', "{fluid_name='water',search_radius=12,limit=8}", label)
    def prep(label): return tool('get_pump_site_preparation', request, label)
    def submit(plan, label):
        return lua("rcon.print(helpers.table_to_json({accepted=remote.call('autorio_operations','prepare_pump_site'," + repr(plan['preparation_id']) + ")}))", label)
    def preflight(plan, label):
        return command(lua_json(remote_call('autorio_preflight', 'operation', "'prepare_pump_site',{preparation_id=" + repr(plan['preparation_id']) + '}')), label)

    require(prep('water first refusal').get('code') == 'water_search_required', evidence)
    fluid = read('covered water read')
    require(fluid.get('covered_fluid_hints') and not fluid.get('samples'), fluid)
    before = snap('before read proposal')
    plan = prep('read-only native terrain proposal')
    require(plan.get('ok') is True and plan.get('placement_authority') is False and 1 <= len(plan.get('removal_tiles', [])) <= 8, plan)
    after = snap('after read proposal')
    require({k:v for k,v in before.items() if k!='tick'} == {k:v for k,v in after.items() if k!='tick'}, {'before': before, 'after': after})
    require(preflight(plan, 'fresh admission').get('ok') is True, plan)
    # A newly built player structure cannot be removed as collateral damage.
    blocked = lua(f"local e=s.create_entity{{name='wooden-chest',position={{{fixture['ox']+5.5},{fixture['oy']+0.5}}},force=a.force}}; assert(e); storage.pump_landfill_chest=e; "
                  "rcon.print(helpers.table_to_json({id=e.unit_number}))", 'new protected structure fixture')
    require(preflight(plan, 'protected structure refusal').get('code') == 'pump_site_protected_entity', blocked)
    require(submit(plan, 'raw protected structure refusal').get('accepted') is False, blocked)
    lua("assert(storage.pump_landfill_chest.valid); storage.pump_landfill_chest.destroy(); storage.pump_landfill_chest=nil; rcon.print('{}')", 'remove declared blocking fixture')
    marked = lua(f"local f=game.forces['pump-cover-foreign'] or game.create_force('pump-cover-foreign'); local t=s.get_tile({fixture['ox']+5},{fixture['oy']}); local p=t.order_deconstruction(f); assert(p); "
                 "rcon.print(helpers.table_to_json({marked=t.to_be_deconstructed(f)}))", 'foreign deconstruction fixture')
    require(marked.get('marked') is True, marked)
    require(preflight(plan, 'foreign work admission refusal').get('code') == 'pump_site_existing_deconstruction', plan)
    preserved = lua(f"local t=s.get_tile({fixture['ox']+5},{fixture['oy']}); local marked=t.to_be_deconstructed(game.forces['pump-cover-foreign']); t.cancel_deconstruction(game.forces['pump-cover-foreign']); "
                    "rcon.print(helpers.table_to_json({foreign_mark_preserved=marked,name=t.name}))", 'foreign marker preserved and retired by harness')
    require(preserved.get('foreign_mark_preserved') is True and preserved['name']=='landfill', preserved)
    # Native staged marks belong only to this job, and cancel preserves the cover.
    require(submit(plan, 'start cancel test').get('accepted') is True, plan)
    time.sleep(0.1)
    cancelled = lua("remote.call('autorio_operations','cancel_all_tasks'); rcon.print('{}')", 'cancel staged preparation')
    stopped = snap('after cancel')
    require(stopped['proxies'] == 0 and stopped['ghosts'] == 0 and all(t['name']=='landfill' for t in stopped['tiles']), stopped)
    read('refresh for actual removal')
    plan = prep('fresh preparation after cancel')
    started = snap('start native removal')
    require(submit(plan, 'admit native actor removal').get('accepted') is True, plan)
    final_status = wait_until_idle(status, 'native actor landfill removal', 45)
    receipt = (final_status.get('basic_operation') or {}).get('last_result') or {}
    require(receipt.get('completed') is True and receipt.get('type') == 'preparing_pump_site' and receipt.get('preparation_reason') == 'covered_water_exposed', receipt)
    exposed = snap('after native actor removal')
    gain = sum(item['count'] for item in exposed['inventory'] if item['name']=='landfill')
    require(gain == len(plan['removal_tiles']) and receipt.get('removed_layers') == gain and receipt.get('reclaimed_items', {}).get('landfill') == gain, {'exposed': exposed, 'receipt': receipt, 'plan': plan})
    require(exposed['tick'] - started['tick'] >= gain * 60 and exposed['proxies']==0 and exposed['ghosts']==0, exposed)
    require(preflight(plan, 'used token stale world refusal').get('code') == 'pump_preparation_world_changed', plan)
    no_fresh_water = tool('get_placement_candidates', "{entity_name='offshore-pump',radius=5,limit=8}", 'terrain invalidates prior water observations')
    require(no_fresh_water.get('code') == 'water_search_required', no_fresh_water)
    refreshed = read('fresh exposed water after native mining')
    require(refreshed.get('samples'), refreshed)
    choices = tool('get_placement_candidates', "{entity_name='offshore-pump',radius=5,limit=8}", 'fresh legal native pump candidates')
    require(choices.get('ok') is True and choices.get('candidates'), choices)
    candidate = choices['candidates'][0]
    accepted = lua("local ok,message=remote.call('autorio_operations','place_candidate'," + repr(choices['candidate_set_id']) + ',' + repr(candidate['id']) + "); rcon.print(helpers.table_to_json({accepted=ok,message=message}))", 'build from fresh native candidate')
    admission = accepted.get('accepted')
    require(admission is True or isinstance(admission,list) and admission[0] is True, accepted)
    pump_status = wait_until_idle(status, 'place native pump', 30)
    require(((pump_status.get('basic_operation') or {}).get('last_result') or {}).get('completed') is True, pump_status)
    final = lua("local p=s.find_entities_filtered{type='offshore-pump'}[1]; assert(p); rcon.print(helpers.table_to_json({source_fluid=p.get_fluid_source_fluid(),source_tile=p.get_fluid_source_tile(),position=p.position,inventory=a.get_main_inventory().get_contents(),humans=#game.connected_players,proxies=#s.find_entities_filtered{type='deconstructible-tile-proxy'},ghosts=#s.find_entities_filtered{type='entity-ghost'}}))", 'native final pump fluid')
    require(final.get('source_fluid')=='water' and final['humans']==0 and final['proxies']==0 and final['ghosts']==0, final)
    evidence.update(status='pass', plan=plan, receipt=receipt, exposed=exposed, final=final, native_landfill_removal_proven=True)
    output.write_text(json.dumps(evidence,indent=2))
    print('PASS: pump-landfill-removal: native cover reclamation, cancellation, protected entity refusal and fresh candidate water pump',flush=True)


def main():
    p=argparse.ArgumentParser()
    p.add_argument('--host',required=True); p.add_argument('--port',required=True,type=int)
    p.add_argument('--password',required=True); p.add_argument('--results',required=True,type=Path)
    a=p.parse_args(); client=None
    try:
        client=connect_with_retry(a.host,a.port,a.password); run(client,a.results); return 0
    except Exception as exc:
        (a.results/'pump-landfill-removal-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}',file=sys.stderr); return 1
    finally:
        if client: client.close()


if __name__=='__main__': raise SystemExit(main())
