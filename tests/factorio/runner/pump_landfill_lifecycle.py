#!/usr/bin/env python3
"""Real save/restart and actor-death cleanup of pending native pump-site jobs.

The actor backend must keep no robot-actionable markers while pending.
Foreign native work must survive startup/death cleanup. Serialized legacy owned
proxy references are covered separately by the mod unit tests.
"""
import argparse
import json
import sys
import time
from pathlib import Path
from run import connect_with_retry, decode_json, lua_json, remote_call


def require(ok, evidence):
    if not ok: raise AssertionError(json.dumps(evidence, sort_keys=True))


def run(client, args):
    records=[]
    path=args.results / f'pump-landfill-lifecycle-{args.phase}.json'
    def command(body, label):
        raw=client.command(body)
        records.append({'label':label,'command':body,'response':raw})
        path.write_text(json.dumps({'status':'running','transcript':records},indent=2))
        return decode_json(raw,label)
    def lua(body,label): return command('/silent-command '+body,label)
    def check(label):
        return lua("local t=storage.pump_lifecycle; local s=game.surfaces[t.surface]; local o=remote.call('autorio_operations','status'); rcon.print(helpers.table_to_json({"
                   "state=o.task_state,queue=o.queue_length,own_mark=s.get_tile(t.own).to_be_deconstructed(game.forces.player),"
                   "foreign_mark=s.get_tile(t.foreign).to_be_deconstructed(game.forces['pump-cover-foreign']),own_tile=s.get_tile(t.own).name,foreign_tile=s.get_tile(t.foreign).name,"
                   "proxies=#s.find_entities_filtered{type='deconstructible-tile-proxy'},humans=#game.connected_players,actor=remote.call('autorio_actor','status')}))",label)
    if args.phase in ('prepare','death'):
        actor=command(lua_json(remote_call('autorio_actor','status')),'current actor')
        actor_id=actor['actor']['actor_id']
        fixture=lua("local a=game.get_entity_by_unit_number("+str(actor_id)+"); local s=a.surface; remote.call('autorio_operations','cancel_all_tasks'); local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); "
                    "for _,e in pairs(s.find_entities_filtered{area={{ox-12,oy-12},{ox+12,oy+12}}}) do if e~=a then e.destroy() end end; local t={}; for x=ox-12,ox+12 do for y=oy-12,oy+12 do t[#t+1]={name='grass-1',position={x,y}} end end; s.set_tiles(t,true,false,true); "
                    "t={}; for x=ox+5,ox+8 do for y=oy-2,oy+2 do t[#t+1]={name='water',position={x,y}} end end; s.set_tiles(t,true,false,true); for _,v in pairs(t) do v.name='landfill' end; s.set_tiles(t,true,false,true); a.get_main_inventory().clear(); "
                    "storage.pump_lifecycle={surface=s.index,own={x=ox+5,y=oy},foreign={x=ox+8,y=oy},actor_id=a.unit_number}; game.tick_paused=true; rcon.print(helpers.table_to_json({ox=ox,oy=oy}))",'declared lifecycle fixture and freeze')
        command(lua_json(remote_call('autorio_tools','get_fluid_source_tiles',"{fluid_name='water',search_radius=12,limit=8}")),'read covered source')
        plan=command(lua_json(remote_call('autorio_tools','get_pump_site_preparation',f"{{x={fixture['ox']+4.5},y={fixture['oy']+0.5},direction=4}}")),'freeze preparation')
        require(plan.get('ok') is True,plan)
        staged=lua("local t=storage.pump_lifecycle; local a=game.get_entity_by_unit_number(t.actor_id); local s=a.surface; local accepted=remote.call('autorio_operations','prepare_pump_site',"+repr(plan['preparation_id'])+"); assert(accepted); "
                   "local f=game.forces['pump-cover-foreign'] or game.create_force('pump-cover-foreign'); "
                   "local foreign=s.get_tile(t.foreign).order_deconstruction(f); assert(foreign); "
                   "t.preparation_id="+repr(plan['preparation_id'])+"; local o=remote.call('autorio_operations','status'); rcon.print(helpers.table_to_json({accepted=accepted,foreign=foreign.valid,state=o.task_state}))",'freeze admitted native job and create foreign marker fixture')
        require(staged.get('state')=='preparing_pump_site',staged)
        if args.phase=='prepare':
            before=args.save.stat().st_mtime_ns
            client.command('/silent-command game.server_save()')
            deadline=time.monotonic()+20
            while time.monotonic()<deadline and args.save.stat().st_mtime_ns<=before: time.sleep(0.1)
            require(args.save.stat().st_mtime_ns>before,{'save':str(args.save)})
            final=check('saved pending physical job')
            require(not final['own_mark'] and final['foreign_mark'] and final['own_tile']=='landfill',final)
        else:
            final=lua("local t=storage.pump_lifecycle; local a=game.get_entity_by_unit_number(t.actor_id); a.die(); remote.call('autorio_actor','status'); rcon.print('{}')",'actual actor death and recovery')
            final=check('after actor loss cleanup')
            require(final['state']=='idle' and final['queue']==0 and not final['own_mark'] and final['foreign_mark'] and final['own_tile']=='landfill' and final['foreign_tile']=='landfill',final)
            lua("local t=storage.pump_lifecycle; game.surfaces[t.surface].get_tile(t.foreign).cancel_deconstruction(game.forces['pump-cover-foreign']); game.tick_paused=false; rcon.print('{}')",'retire foreign test fixture marker')
    else:
        before=check('loaded paused pending job')
        require(not before['own_mark'] and before['foreign_mark'] and before['state']=='preparing_pump_site',before)
        reconciled=command(lua_json(remote_call('autorio_operations','reconcile_startup',repr('pump-landfill-restarted-server'))),'actual server startup reconciliation')
        require(reconciled.get('ok') is True and reconciled.get('reconciled') is True,reconciled)
        final=check('reconciled stopped physical job')
        require(final['state']=='idle' and final['queue']==0 and not final['own_mark'] and final['foreign_mark'] and final['own_tile']=='landfill' and final['foreign_tile']=='landfill',final)
        stale=lua("rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','prepare_pump_site',{preparation_id=storage.pump_lifecycle.preparation_id})))",'prestartup token rejected')
        require(stale.get('code')=='pump_preparation_unavailable',stale)
        lua("local t=storage.pump_lifecycle; game.surfaces[t.surface].get_tile(t.foreign).cancel_deconstruction(game.forces['pump-cover-foreign']); game.tick_paused=false; rcon.print('{}')",'retire foreign test fixture marker')
    require(final['humans']==0,final)
    path.write_text(json.dumps({'status':'pass','phase':args.phase,'final':final,'transcript':records},indent=2))
    print(f'PASS: pump-landfill lifecycle {args.phase}',flush=True)


def main():
    p=argparse.ArgumentParser(); p.add_argument('--host',required=True); p.add_argument('--port',required=True,type=int)
    p.add_argument('--password',required=True); p.add_argument('--results',required=True,type=Path)
    p.add_argument('--phase',required=True,choices=['prepare','verify','death']); p.add_argument('--save',type=Path)
    args=p.parse_args(); client=None
    try:
        client=connect_with_retry(args.host,args.port,args.password); run(client,args); return 0
    except Exception as exc:
        (args.results/f'pump-landfill-lifecycle-{args.phase}-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}',file=sys.stderr); return 1
    finally:
        if client:client.close()


if __name__=='__main__':raise SystemExit(main())
