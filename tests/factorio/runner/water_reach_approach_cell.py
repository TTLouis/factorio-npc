#!/usr/bin/env python3
"""Native regression for AB-3 (18ab): water the actor cannot walk onto.

Runs on a world generated from the 18ab seed with default map settings. The harness
generates terrain and places the actor (declared fixture setup); everything under test
goes through the mod's own interfaces: get_fluid_source_tiles, the walk preflight, the
walk_to_position operation, get_placement_candidates and the prototype details.
Zero humans, speed one, no terrain edits.

Proves, natively:
  * the pathfinder answers "unreachable" for a walk to a water tile (the 18ab failure),
    while the same walk to the sample's approach position is reached;
  * each water sample carries an approach position the actor's character can stand on;
  * the walk preflight refuses the water tile (goal on a colliding tile the character cannot
    be placed on) with the layers the engine says collide and the nearest standing position,
    and accepts every approach, including one on a shoreline tile of the colliding kind;
  * an empty, narrower re-read does not evict the remembered positive read;
  * the offshore pump reports its fluid through the native fluid_io field, from the tiles.
"""
import argparse
import json
import math
import sys
import time
from pathlib import Path

from run import connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle

# The 18ab actor stood here when the first radius-256 read found water about 170 tiles away.
ACTOR_START = (-104.8, 19.1)
GENERATE_CHUNK_RADIUS = 12
WALK_REACH = 4


def require(condition, evidence):
    if not condition:
        raise AssertionError(json.dumps(evidence, sort_keys=True, default=str))


def run(client, results):
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    evidence = {'status': 'fail', 'scenario': 'water-reach-approach', 'transcript': []}
    output = results / 'water-reach-approach-cell.json'

    def command(text, label):
        raw = client.command(text)
        evidence['transcript'].append({'label': label, 'command': text[:600], 'response': raw[:4000]})
        output.write_text(json.dumps(evidence, indent=2))
        return decode_json(raw, label)

    actor = ("local a=nil; for _,e in pairs(game.surfaces[1].find_entities_filtered{name='character'}) do "
             f"if e.unit_number=={actor_id} then a=e end end; assert(a); local s=a.surface; ")

    def lua(body, label):
        return command('/silent-command ' + actor + body, label)

    def tool(name, args, label):
        return command(lua_json(remote_call('autorio_tools', name, args)), label)

    def preflight(x, y, reach, label):
        return command(lua_json(remote_call('autorio_preflight', 'operation', "'walk_to_position'",
                                            f'{{x={x},y={y},reach_distance={reach}}}')), label)

    def walk(x, y, label, reach=WALK_REACH):
        started = lua(f"local ok=remote.call('autorio_operations','walk_to_position',{x},{y},{reach}); "
                      "rcon.print(helpers.table_to_json({accepted=ok}))", f'{label}: start')
        require(started.get('accepted') is True or (isinstance(started.get('accepted'), list) and started['accepted'][0] is True), started)
        wait_until_idle(lambda ctx: command(operation_status_command(), ctx), label, 90)
        result = command(lua_json(remote_call('autorio_navigation', 'status')), f'{label}: result').get('last_result') or {}
        position = lua("rcon.print(helpers.table_to_json({position=a.position}))", f'{label}: position')['position']
        return result, position

    def place_actor(x, y, label):
        return lua(f"local p=s.find_non_colliding_position(a.name,{{x={x},y={y}}},8,0.5); assert(p); a.teleport(p); "
                   "rcon.print(helpers.table_to_json({position=a.position,tile=s.get_tile(a.position).name}))", label)

    # --- Fixture: generated terrain around the spawn (the live server had 168 of 289 chunks) -----------------
    lua(f"s.request_to_generate_chunks({{0,0}},{GENERATE_CHUNK_RADIUS}); rcon.print(helpers.table_to_json({{ok=true}}))", 'request chunks')
    corners = ','.join(f"s.is_chunk_generated({{{sx * GENERATE_CHUNK_RADIUS},{sy * GENERATE_CHUNK_RADIUS}}})" for sx in (-1, 1) for sy in (-1, 1))
    deadline = time.monotonic() + 240
    while True:
        generated = lua(f"local g={{{corners}}}; rcon.print(helpers.table_to_json({{done=g[1] and g[2] and g[3] and g[4]}}))", 'chunks generated?')
        if generated.get('done'):
            break
        require(time.monotonic() < deadline, generated)
        time.sleep(1.0)
    lua("remote.call('autorio_operations','cancel_all_tasks'); rcon.print(helpers.table_to_json({ok=true}))", 'cancel work')
    placed = place_actor(*ACTOR_START, 'place the actor where the 18ab read happened')
    state = lua("rcon.print(helpers.table_to_json({humans=#game.connected_players,speed=game.speed,character=a.name}))", 'fixture state')
    evidence['fixture'] = {'placed': placed, 'state': state}
    require(state['humans'] == 0 and state['speed'] == 1 and placed['tile'] != 'water', evidence['fixture'])

    # --- 1. The read: samples carry an approach the character can stand on ----------------------------------
    far = tool('get_fluid_source_tiles', "{fluid_name='water',search_radius=256,limit=8}", 'water read, radius 256')
    samples = far.get('samples') or []
    require(far.get('ok') is True and len(samples) > 0 and far.get('approach_search_radius') == 16, far)
    fluid_name = far['fluid_name']
    # Radius 128 does not reach this water (it is about 170 tiles away): the honest empty read of 18ab.
    near_empty = tool('get_fluid_source_tiles', f"{{fluid_name='{fluid_name}',search_radius=128,limit=8}}", 'water read, radius 128')
    require(near_empty.get('ok') is True and near_empty.get('returned_count') == 0, near_empty)
    evidence['reads'] = {'far': far, 'near_empty': near_empty}

    for sample in samples:
        approach = sample.get('approach')
        require(isinstance(approach, dict), sample)
        engine = lua(f"local ap={{x={approach['x']},y={approach['y']}}}; local t=s.get_tile(math.floor(ap.x),math.floor(ap.y)); "
                     f"local st=s.get_tile({sample['position']['x']},{sample['position']['y']}); "
                     "local layers=prototypes.entity[a.name].collision_mask.layers; local shared=0; local sample_shared=0; "
                     "for layer,_ in pairs(layers) do if t.prototype.collision_mask.layers[layer] then shared=shared+1 end; "
                     "if st.prototype.collision_mask.layers[layer] then sample_shared=sample_shared+1 end end; "
                     "rcon.print(helpers.table_to_json({can_stand=s.can_place_entity{name=a.name,position=ap,force=a.force},"
                     "approach_tile=t.name,approach_shared=shared,sample_tile=st.name,sample_shared=sample_shared,"
                     "sample_fluid=st.prototype.fluid and st.prototype.fluid.name}))", 'engine view of a sample and its approach')
        # The character's mask considers tile transitions, so a shoreline tile of the colliding kind can still hold it: the engine decides.
        require(engine['can_stand'] is True, {'sample': sample, 'engine': engine})
        require(engine['sample_shared'] >= 1 and engine['sample_fluid'] == fluid_name, {'sample': sample, 'engine': engine})
        require(math.hypot(approach['x'] - sample['position']['x'], approach['y'] - sample['position']['y']) <= 17, sample)

    water = samples[0]['position']
    approach = samples[0]['approach']

    # --- 2. The preflight: refuses the water tile, accepts its approach -------------------------------------
    refused = preflight(water['x'], water['y'], WALK_REACH, 'preflight the water tile')
    expected = lua(f"local st=s.get_tile({water['x']},{water['y']}); local out={{}}; "
                   "for layer,_ in pairs(prototypes.entity[a.name].collision_mask.layers) do if st.prototype.collision_mask.layers[layer] then out[#out+1]=layer end end; "
                   "table.sort(out); rcon.print(helpers.table_to_json({layers=out,tile=st.name}))", 'engine: layers the water tile shares with the character')
    require(refused.get('ok') is False and refused.get('code') == 'navigation_position_inside_tile_collision', refused)
    require(refused.get('colliding_layers') == expected['layers'] and refused.get('tile') == expected['tile'], {'refused': refused, 'engine': expected})
    nearest = refused.get('nearest_walkable_position')
    require(isinstance(nearest, dict), refused)
    nearest_check = lua(f"rcon.print(helpers.table_to_json({{can_stand=s.can_place_entity{{name=a.name,position={{x={nearest['x']},y={nearest['y']}}},force=a.force}}}}))", 'nearest standing position')
    require(nearest_check['can_stand'] is True, {'refused': refused, 'check': nearest_check})
    accepted = preflight(approach['x'], approach['y'], WALK_REACH, 'preflight the approach')
    require(accepted.get('ok') is True, accepted)
    # Every approach is accepted, also one that lies on a tile of the colliding kind (a shoreline tile the character fits on).
    for sample in samples:
        verdict = preflight(sample['approach']['x'], sample['approach']['y'], WALK_REACH, 'preflight a sample approach')
        require(verdict.get('ok') is True, {'sample': sample, 'verdict': verdict})
    on_water = [sample for sample in samples if lua(f"rcon.print(helpers.table_to_json({{tile=s.get_tile(math.floor({sample['approach']['x']}),math.floor({sample['approach']['y']})).name}}))", 'approach tile')['tile']
                == lua(f"rcon.print(helpers.table_to_json({{tile=s.get_tile({sample['position']['x']},{sample['position']['y']}).name}}))", 'sample tile')['tile']]
    evidence['preflight'] = {'water_tile': refused, 'approach': accepted, 'approaches_on_the_colliding_kind': on_water}

    # --- 3. Native confirmation of the 18ab failure, then the walk that works -------------------------------
    # The operation itself performs no preflight: this is the doomed request the preflight now stops.
    doomed, doomed_position = walk(water['x'], water['y'], 'walk to the water tile (no preflight)')
    require(doomed.get('code') == 'unreachable' and doomed.get('accepted') is False and doomed.get('path_attempts') == 4, doomed)
    evidence['doomed_walk'] = {'result': doomed, 'position': doomed_position}
    place_actor(*ACTOR_START, 'back to the start')
    reached, reached_position = walk(approach['x'], approach['y'], 'walk to the approach')
    require(reached.get('code') == 'reached' and reached.get('completed') is True, reached)
    distance_to_approach = math.hypot(reached_position['x'] - approach['x'], reached_position['y'] - approach['y'])
    distance_to_water = math.hypot(reached_position['x'] - water['x'], reached_position['y'] - water['y'])
    require(distance_to_approach <= WALK_REACH + 0.5 and distance_to_water < 8, {'reached': reached, 'position': reached_position})
    evidence['approach_walk'] = {'result': reached, 'position': reached_position, 'distance_to_approach': distance_to_approach}
    if on_water:
        # The preflight accepted this goal; the pathfinder must agree, or the preflight would be hiding a refusal.
        place_actor(*ACTOR_START, 'back to the start for the shoreline approach')
        shore = on_water[0]['approach']
        shore_result, shore_position = walk(shore['x'], shore['y'], 'walk to an approach on a shoreline tile')
        require(shore_result.get('code') == 'reached', {'approach': shore, 'result': shore_result})
        evidence['shoreline_approach_walk'] = {'approach': shore, 'result': shore_result, 'position': shore_position}

    # --- 3b. The shoreline itself: a goal the character fits on is reached, one on the water just past it never is ----
    # Both points come from the engine: walk from the approach towards the water tile centre; the first point whose tile
    # collides with the character and where it cannot be placed is the wet goal, the last point before it where the character
    # can be placed is the land goal.
    pair = lua(f"local ap={{x={approach['x']},y={approach['y']}}}; local tc={{x={water['x']}+0.5,y={water['y']}+0.5}}; "
               "local layers=prototypes.entity[a.name].collision_mask.layers; "
               "local function collides(p) local t=s.get_tile(math.floor(p.x),math.floor(p.y)); "
               "for l,_ in pairs(layers) do if t.prototype.collision_mask.layers[l] then return true end end return false end; "
               "local land=nil; local wet=nil; "
               "for i=0,400 do local f=i/400; local p={x=ap.x+(tc.x-ap.x)*f,y=ap.y+(tc.y-ap.y)*f}; "
               "local fits=s.can_place_entity{name=a.name,position=p,force=a.force}; "
               "if fits then land=p elseif collides(p) then wet=p; break end end; "
               "rcon.print(helpers.table_to_json({land=land,wet=wet}))", 'engine: shoreline points between the approach and the water')
    require(pair.get('land') and pair.get('wet'), pair)
    gap = math.hypot(pair['land']['x'] - pair['wet']['x'], pair['land']['y'] - pair['wet']['y'])
    require(gap < 1.0, pair)
    shore_reach = 0.5
    land_reach = 1.0  # the character stops against the shore a little short of a goal at the water's edge
    place_actor(approach['x'] - 15, approach['y'], 'near the shoreline')
    require(preflight(pair['land']['x'], pair['land']['y'], land_reach, 'preflight where the character fits').get('ok') is True, pair)
    wet_verdict = preflight(pair['wet']['x'], pair['wet']['y'], shore_reach, 'preflight just past the shore')
    require(wet_verdict.get('ok') is False and wet_verdict.get('code') == 'navigation_position_inside_tile_collision', {'pair': pair, 'verdict': wet_verdict})
    land_result, _ = walk(pair['land']['x'], pair['land']['y'], 'walk to the point where the character fits', land_reach)
    require(land_result.get('code') == 'reached', {'pair': pair, 'result': land_result})
    place_actor(approach['x'] - 15, approach['y'], 'near the shoreline again')
    wet_result, _ = walk(pair['wet']['x'], pair['wet']['y'], 'walk to the point just past the shore (no preflight)', shore_reach)
    require(wet_result.get('code') == 'unreachable' and wet_result.get('path_attempts') == 4, {'pair': pair, 'result': wet_result})
    evidence['shoreline_pair'] = {'points': pair, 'gap': gap, 'land_result': land_result, 'wet_result': wet_result, 'wet_verdict': wet_verdict}

    # --- 4. The remembered positive survives an empty narrower re-read --------------------------------------
    # The 18ab order, from the original position: the radius-256 read finds water, a radius-128 read is empty,
    # then pump sites are requested.
    place_actor(*ACTOR_START, 'back to the start for the re-read')
    positive = tool('get_fluid_source_tiles', f"{{fluid_name='{fluid_name}',search_radius=256,limit=8}}", 'positive read again')
    require(len(positive.get('samples') or []) > 0, positive)
    empty = tool('get_fluid_source_tiles', f"{{fluid_name='{fluid_name}',search_radius=128,limit=8}}", 'empty narrower re-read')
    require(empty.get('returned_count') == 0 and empty.get('empty_result_is_conclusive') is True, empty)
    sites = tool('get_placement_candidates', "{entity_name='offshore-pump',radius=8,limit=5}", 'pump sites after the empty re-read')
    require(sites.get('code') not in ('water_source_not_exposed', 'water_search_required'), sites)
    require(sites.get('ok') is True and len(sites.get('candidates') or []) > 0, sites)
    evidence['positive_kept'] = {'empty_read': empty, 'sites': {k: sites.get(k) for k in ('ok', 'code', 'ordering')}, 'candidates': len(sites['candidates'])}

    # --- 5. The native fluid field: the offshore pump's water comes from the tiles --------------------------
    types = lua("local function first(t) for n,_ in pairs(prototypes.get_entity_filtered{{filter='type',type=t}}) do return n end end; "
                "rcon.print(helpers.table_to_json({pump=first('offshore-pump'),boiler=first('boiler')}))", 'prototype names by type')
    require(types['pump'] and types['boiler'], types)
    details = {}
    for role in ('pump', 'boiler'):
        details[role] = command(lua_json(remote_call('autorio_prototypes', 'details', repr(types[role]))), f'{role} details')['entity']
    pump = details['pump']
    require(all(not box.get('filter') for box in pump['fluidboxes']), pump)
    # The tile fluids are the options of ONE output port (the pump yields the fluid of the tile it stands on), never several products.
    require(len(pump['fluid_io']) == 1 and pump['fluid_io'][0]['source'] == 'tile_fluid' and pump['fluid_io'][0]['production_type'] == 'output' and 'fluid' not in pump['fluid_io'][0], pump)
    pump_fluids = set(pump['fluid_io'][0]['fluid_options'])
    require(fluid_name in pump_fluids, pump)
    tile_fluids = lua("local out={}; local seen={}; for _,t in pairs(prototypes.tile) do local f=t.fluid and t.fluid.name; if f and not seen[f] then seen[f]=true; out[#out+1]=f end end; "
                      "table.sort(out); rcon.print(helpers.table_to_json({fluids=out}))", 'engine: fluids of the tile prototypes')['fluids']
    require(sorted(pump_fluids) == tile_fluids and pump['fluid_io_truncated'] is False, {'pump': pump['fluid_io'], 'tiles': tile_fluids})
    boiler_io = details['boiler']['fluid_io']
    boiler_filters = [box['filter'] for box in details['boiler']['fluidboxes'] if box.get('filter')]
    require(sorted(io['fluid'] for io in boiler_io) == sorted(boiler_filters) and all(io['source'] == 'fluidbox_filter' for io in boiler_io) and len(boiler_io) >= 1, details['boiler'])
    evidence['fluid_io'] = {'pump': pump['fluid_io'], 'boiler': boiler_io}

    final = lua("rcon.print(helpers.table_to_json({humans=#game.connected_players,speed=game.speed}))", 'final state')
    require(final['humans'] == 0 and final['speed'] == 1, final)
    evidence['status'] = 'pass'
    output.write_text(json.dumps(evidence, indent=2))
    print('PASS: water-reach-approach: approach positions, tile-collision walk refusal, unreachable water walk vs reached approach, '
          'positive read kept across an empty re-read, native fluid_io', flush=True)


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
        (args.results / 'water-reach-approach-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
