"""Verify bounded construction-area clearing with engine-discovered heterogeneous finite blockers."""
import argparse
import json
import sys
import time
from pathlib import Path

from run import Rcon, connect_with_retry, decode_json, remote_call
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
        (results / 'construction-area-clearing-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str):
        return decode_json(command(text), context)

    def status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        f"for _,e in pairs(s.find_entities_filtered{{name='character'}}) do if e.unit_number=={actor_id} then a=e end end; "
        "assert(a); remote.call('autorio_operations','cancel_all_tasks'); "
        "local function placed_building(p) local items=p and p.items_to_place_this; return p and p.is_building==true and (p.is_entity_with_owner==true or (items and #items>0)) end; "
        "local function proto_clearable(p) local mp=p and p.mineable_properties; return p and mp and mp.minable==true and p.type~='resource' and p.type~='character' and not placed_building(p) end; "
        "local function entity_clearable(e) return e and e.valid and e.minable==true and proto_clearable(e.prototype) end; "
        "local function describe(e) if not e then return nil end; local p=e.prototype; local mp=p and p.mineable_properties; local items=p and p.items_to_place_this; "
        "return {name=e.name,type=e.type,prototype_type=p and p.type or nil,position={x=e.position.x,y=e.position.y},unit_number=e.unit_number,is_building=p and p.is_building or nil,is_entity_with_owner=p and p.is_entity_with_owner or nil,item_to_place_count=items and #items or 0,entity_minable=e.minable,prototype_minable=mp and mp.minable or nil,count_as_rock=p and p.count_as_rock_for_filtered_deconstruction or nil,clearable=entity_clearable(e)} end; "
        "local trees={}; local rocks={}; local finite_blockers={}; local resources={}; for name,p in pairs(prototypes.entity) do "
        "local clearable=proto_clearable(p); local mineable=p.mineable_properties and p.mineable_properties.minable; "
        "if p.type=='tree' and clearable then trees[#trees+1]=name end; "
        "if clearable and p.count_as_rock_for_filtered_deconstruction==true then rocks[#rocks+1]=name end; "
        "if clearable and p.type~='tree' then finite_blockers[#finite_blockers+1]=name end; "
        "if p.type=='resource' and mineable and p.infinite_resource~=true then resources[#resources+1]=name end end; "
        "table.sort(trees); table.sort(rocks); table.sort(finite_blockers); table.sort(resources); "
        "local base=s.find_non_colliding_position('wooden-chest',{x=a.position.x+8,y=a.position.y},24,0.5); "
        "if not base then rcon.print(helpers.table_to_json({setup_ok=false,reason='no_base',tree_candidates=#trees,rock_candidates=#rocks,resource_candidates=#resources})); return end; "
        "local area={{base.x-4,base.y-4},{base.x+4,base.y+4}}; "
        "for _,e in pairs(s.find_entities_filtered{area=area}) do if e.valid and e~=a and e.type~='character' then e.destroy() end end; "
        "local outside_target={x=base.x+6,y=base.y}; for _,e in pairs(s.find_entities_filtered{position=outside_target,radius=1.5}) do if e.valid and e~=a and e.type~='character' then e.destroy() end end; "
        "local function inside_footprint(pos) return pos and math.abs(pos.x-base.x)<3.75 and math.abs(pos.y-base.y)<3.75 end; "
        "local function create_inside(names,want,skip) for _,name in ipairs(names) do if name~=skip then "
        "local pos=s.find_non_colliding_position(name,want,0.75,0.25); "
        "if pos then local e=s.create_entity{name=name,position=pos}; if e then local actual={x=e.position.x,y=e.position.y}; "
        "if inside_footprint(actual) and entity_clearable(e) then return e,e.name,actual end; e.destroy() end end end end return nil,nil,want end; "
        "local t1,tree1,p1=create_inside(trees,{x=base.x,y=base.y},nil); "
        "local t2,tree2,p2=create_inside(trees,{x=base.x+1.5,y=base.y+1.5},tree1); "
        "local blocker,blocker_name,blocker_position=create_inside(rocks,{x=base.x-1.5,y=base.y+1.5},nil); local rock_like=blocker~=nil; "
        "if not blocker then blocker,blocker_name,blocker_position=create_inside(finite_blockers,{x=base.x-1.5,y=base.y+1.5},nil) end; "
        "local res=nil; local resource_name=nil; local resource_position={x=base.x+1.5,y=base.y-1.5}; "
        "for _,name in ipairs(resources) do local candidate=s.create_entity{name=name,position=resource_position,amount=1000}; "
        "if candidate then local actual={x=candidate.position.x,y=candidate.position.y}; if inside_footprint(actual) then res=candidate; resource_name=name; resource_position=actual; break end; candidate.destroy() end end; "
        "local building_position=s.find_non_colliding_position('wooden-chest',{x=base.x-1.5,y=base.y-1.5},0.75,0.25); "
        "local building=building_position and s.create_entity{name='wooden-chest',position=building_position,force=a.force} or nil; "
        "if building then building_position={x=building.position.x,y=building.position.y}; if not inside_footprint(building_position) then building.destroy(); building=nil end end; "
        "local outside_position=tree1 and s.find_non_colliding_position(tree1,outside_target,1,0.25) or nil; "
        "local outside=(tree1 and outside_position) and s.create_entity{name=tree1,position=outside_position} or nil; "
        "if outside then outside_position={x=outside.position.x,y=outside.position.y} end; "
        "local blocker_in_area=false; for _,e in pairs(s.find_entities_filtered{area=area}) do if e==blocker then blocker_in_area=true end end; "
        "local dx=base.x-a.position.x; local dy=base.y-a.position.y; local initial_distance=math.sqrt(dx*dx+dy*dy); "
        "local inv=a.get_main_inventory(); local inserted=inv.insert{name='wooden-chest',count=1}; "
        "local setup_ok=t1~=nil and t2~=nil and blocker~=nil and res~=nil and building~=nil and outside~=nil and inserted==1 and initial_distance>a.resource_reach_distance+1; "
        "rcon.print(helpers.table_to_json({setup_ok=setup_ok,actor_id=a.unit_number,tree1=tree1,tree2=tree2,blocker=blocker_name,resource=resource_name,"
        "center=base,inside1=p1,inside2=p2,blocker_position=blocker_position,resource_position=resource_position,building_position=building_position,outside=outside_position,"
        "initial_distance=initial_distance,resource_reach=a.resource_reach_distance,chests=inv.get_item_count('wooden-chest'),"
        "tree_candidates=#trees,rock_candidates=#rocks,finite_blocker_candidates=#finite_blockers,resource_candidates=#resources,"
        "rock_like=rock_like,blocker_in_area_query=blocker_in_area,blocker_details=describe(blocker),created={tree1=t1~=nil,tree2=t2~=nil,blocker=blocker~=nil,resource=res~=nil,building=building~=nil,outside=outside~=nil},inserted=inserted}))",
        'construction area fixture',
    )
    require(fixture.get('setup_ok') is True, fixture)
    require(fixture['actor_id'] == actor_id and fixture['tree1'] != fixture['tree2'], fixture)
    require(fixture['chests'] >= 1, fixture)
    require(fixture.get('blocker_in_area_query') is True, fixture)
    require((fixture.get('blocker_details') or {}).get('clearable') is True, fixture)
    print(f"[npc-test] construction blocker fixture: {json.dumps(fixture.get('blocker_details'), sort_keys=True)}", flush=True)

    center = fixture['center']
    admission = json_command(
        "/silent-command "
        f"local clear={remote_call('autorio_operations', 'clear_construction_area', str(center['x']), str(center['y']), '8', '8')}; "
        f"local place={remote_call('autorio_operations', 'place_entity', repr('wooden-chest'), str(center['x']), str(center['y']))}; "
        "rcon.print(helpers.table_to_json({clear=clear,place=place}))",
        'clear then place admission',
    )
    require(admission.get('clear', [False])[0] is True, admission)
    require(admission.get('place') is True, admission)

    final = wait_until_idle(status, 'construction area clear then place', 30)
    receipt = final.get('last_completed_batch') or {}
    require(receipt.get('task_types') == ['clearing_area', 'placing'], final)

    verify = json_command(
        "/silent-command local s=game.surfaces[1]; "
        f"local p1={{x={fixture['inside1']['x']},y={fixture['inside1']['y']}}}; "
        f"local p2={{x={fixture['inside2']['x']},y={fixture['inside2']['y']}}}; "
        f"local blocker_position={{x={fixture['blocker_position']['x']},y={fixture['blocker_position']['y']}}}; "
        f"local pres={{x={fixture['resource_position']['x']},y={fixture['resource_position']['y']}}}; "
        f"local pb={{x={fixture['building_position']['x']},y={fixture['building_position']['y']}}}; "
        f"local po={{x={fixture['outside']['x']},y={fixture['outside']['y']}}}; "
        f"local c={{x={center['x']},y={center['y']}}}; "
        f"local i1=#s.find_entities_filtered{{name={fixture['tree1']!r},position=p1,radius=0.3}}; "
        f"local i2=#s.find_entities_filtered{{name={fixture['tree2']!r},position=p2,radius=0.3}}; "
        f"local blocker=#s.find_entities_filtered{{name={fixture['blocker']!r},position=blocker_position,radius=0.3}}; "
        f"local resource=#s.find_entities_filtered{{name={fixture['resource']!r},position=pres,radius=0.3}}; "
        "local building=#s.find_entities_filtered{name='wooden-chest',position=pb,radius=0.3}; "
        f"local o=#s.find_entities_filtered{{name={fixture['tree1']!r},position=po,radius=0.3}}; "
        "local chest=#s.find_entities_filtered{name='wooden-chest',position=c,radius=0.3}; "
        "local function placed_building(p) local items=p and p.items_to_place_this; return p and p.is_building==true and (p.is_entity_with_owner==true or (items and #items>0)) end; "
        "local function clearable(e) local p=e and e.prototype; local mp=p and p.mineable_properties; return e and e.valid and e.minable==true and p and mp and mp.minable==true and p.type~='resource' and p.type~='character' and not placed_building(p) end; "
        "local function describe(e) local p=e.prototype; local mp=p.mineable_properties; local items=p.items_to_place_this; return {name=e.name,type=e.type,prototype_type=p.type,position={x=e.position.x,y=e.position.y},unit_number=e.unit_number,is_building=p.is_building,is_entity_with_owner=p.is_entity_with_owner,item_to_place_count=items and #items or 0,entity_minable=e.minable,prototype_minable=mp and mp.minable or nil,count_as_rock=p.count_as_rock_for_filtered_deconstruction,clearable=clearable(e)} end; "
        f"local remaining_blocker_details={{}}; for _,e in pairs(s.find_entities_filtered{{name={fixture['blocker']!r},position=blocker_position,radius=0.3}}) do remaining_blocker_details[#remaining_blocker_details+1]=describe(e) end; "
        "local remaining_clearable={}; local footprint={{c.x-4,c.y-4},{c.x+4,c.y+4}}; for _,e in pairs(s.find_entities_filtered{area=footprint}) do "
        "if e.position.x>=c.x-4 and e.position.x<=c.x+4 and e.position.y>=c.y-4 and e.position.y<=c.y+4 and clearable(e) then remaining_clearable[#remaining_clearable+1]=describe(e) end end; "
        "rcon.print(helpers.table_to_json({inside1=i1,inside2=i2,blocker=blocker,resource=resource,building=building,outside=o,chest=chest,remaining_blocker_details=remaining_blocker_details,remaining_clearable_blockers=remaining_clearable}))",
        'construction area verification',
    )
    require(verify.get('inside1') == 0 and verify.get('inside2') == 0, verify)
    require(verify.get('blocker') == 0, verify)
    require(verify.get('resource') == 1, verify)
    require(verify.get('building') == 1, verify)
    require(verify.get('outside') == 1, verify)
    require(verify.get('chest') == 1, verify)

    payload = {
        'status': 'pass',
        'fixture': fixture,
        'admission': admission,
        'final_status': final,
        'verification': verify,
    }
    (results / 'construction-area-clearing.json').write_text(json.dumps(payload, indent=2))
    print(
        'PASS: heterogeneous finite blockers were cleared only inside the bounded footprint; '
        'resource/building/outside entities remained and queued construction resumed automatically',
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
        (args.results / 'construction-area-clearing-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
