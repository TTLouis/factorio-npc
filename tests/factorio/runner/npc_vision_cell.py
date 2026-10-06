"""Engine lane for the hidden NPC vision vehicle (sgluna-npc-vision).

The standalone NPC gets live map vision from a hidden car prototype that follows it and
charts a 5x5 chunk window through VehiclePrototype.chunk_exploration_radius. The owner's top
requirement is that the vehicle never interacts with the world, so this lane proves in a real
zero-player engine that:

  LIFECYCLE   exactly one vehicle exists for the NPC, follows it chunk by chunk and on the
              correction timer, is rebuilt (with orphans swept) after it disappears, is
              replaced with the NPC after death, and survives a real save/restart as the
              same single entity that still follows the NPC.
  INTERACTION nothing can target, damage, select, mine, clear or be blocked by it: the
              prototype and live entity flags, an enemy turret and biter next to an
              otherwise destructible instance, area clearing, NPC placement of a chest and a
              furnace on its exact tile, a belt and a burner inserter running through it,
              no item/recipe/technology, no pollution.
  INVISIBLE   the NPC's nearby-entity, entity-status, discovery and map reads never return it.
  EXPLORATION what the engine charts around it. Factorio charts nothing for a force with no
              connected player (not LuaForce.chart, not a powered radar), and this lane runs
              with zero players, so the result is recorded against those controls. If the
              engine does chart, the vehicle's whole window must be charted; if it does not,
              the named LIMITATION line is printed and the controls must also be empty. It is
              never faked with LuaForce.chart.

Phases: `prepare` runs everything above and ends with a server save; `verify` runs after the
real process restart (run_lane.sh) and checks the persisted vehicle.
"""
import argparse
import json
import re
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, remote_call
from runtime import operation_status_command, wait_until_idle

VISION = 'sgluna-npc-vision'
NPC_HOP_ONE = (-48.0, -16.0)  # chunk (-2, -1): its whole 5x5 window is inside the 256x256 test map
NPC_HOP_TWO = (-40.0, -10.0)  # same chunk: only the correction timer can move the vehicle
NPC_HOP_THREE = (40.0, 20.0)  # chunk (1, 0)
MAP_CHUNKS = range(-4, 4)     # the test map is 256x256 tiles
FOLLOW_TICKS = 150            # > the 60-tick correction interval
EAST = 4
WEST = 12


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def lua_table(values: list[dict]) -> list[dict]:
    # An empty Lua table serializes as {} rather than [].
    return values if isinstance(values, list) else []


def run(client: Rcon, results: Path, phase: str, save_path: Path | None, process_log_dir: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'phase': phase}
    evidence_path = results / f'npc-vision-{phase}.json'

    def flush() -> None:
        evidence['transcript'] = transcript
        evidence_path.write_text(json.dumps(evidence, indent=2))

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
        flush()
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def lua(*parts: str) -> str:
        return '/silent-command ' + ' '.join(parts)

    def tick() -> int:
        # Polled often, so it stays out of the transcript.
        return int(client.command(lua('rcon.print(game.tick)')))

    def wait_ticks(count: int) -> None:
        target = tick() + count
        while tick() < target:
            time.sleep(0.1)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        admission = json_command(
            lua('local result=' + expression + ';',
                'local accepted=false; local message=nil;',
                "if type(result)=='table' then accepted=result[1]==true; message=result[2] else accepted=result==true end;",
                'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))'),
            f'{context} admission',
        )
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        status = wait_until_idle(operation_status, context, timeout)
        return (status.get('basic_operation') or {}).get('last_result') or {}

    def actor_status() -> dict:
        return json_command(lua("rcon.print(helpers.table_to_json(remote.call('autorio_actor','status')))"), 'actor status')

    def actor_id() -> int:
        return actor_status()['actor']['actor_id']

    def actor_lookup() -> str:
        return ("local s=game.surfaces[1]; local a=nil; "
                "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
                f"if e.unit_number=={actor_id()} then a=e end end; assert(a,'NPC missing'); ")

    def vision_status() -> dict:
        return json_command(lua("rcon.print(helpers.table_to_json(remote.call('autorio_npc_vision','status')))"), 'vision status')

    def vision_entities() -> list[dict]:
        return lua_table(json_command(
            lua('local out={}; for _,sf in pairs(game.surfaces) do',
                f"for _,e in pairs(sf.find_entities_filtered{{name='{VISION}'}}) do",
                'out[#out+1]={unit=e.unit_number,x=e.position.x,y=e.position.y,surface=sf.index,health=e.health,destructible=e.destructible} end end;',
                'rcon.print(helpers.table_to_json(out))'),
            'vision entities',
        ))

    def npc_position() -> dict:
        return actor_status()['actor']['position']

    def window(cx: int, cy: int, radius: int = 2) -> dict:
        return json_command(
            lua('local s=game.surfaces[1]; local f=game.forces.player; local charted,visible,generated,total=0,0,0,0;',
                f'for x={cx - radius},{cx + radius} do for y={cy - radius},{cy + radius} do',
                f'if x>={MAP_CHUNKS.start} and x<={MAP_CHUNKS.stop - 1} and y>={MAP_CHUNKS.start} and y<={MAP_CHUNKS.stop - 1} then total=total+1;',
                'if f.is_chunk_charted(s,{x,y}) then charted=charted+1 end; if f.is_chunk_visible(s,{x,y}) then visible=visible+1 end;',
                'if s.is_chunk_generated({x,y}) then generated=generated+1 end end end end;',
                'rcon.print(helpers.table_to_json({charted=charted,visible=visible,generated=generated,total=total}))'),
            f'chunk window ({cx},{cy})',
        )

    def generate(cx: int, cy: int, radius: int) -> None:
        json_command(
            lua('local s=game.surfaces[1]; s.request_to_generate_chunks({%d,%d},%d); s.force_generate_chunk_requests(); rcon.print("{}")' % (cx * 32 + 16, cy * 32 + 16, radius)),
            f'generate chunks around ({cx},{cy})',
        )

    def chunk_of(position: dict) -> tuple[int, int]:
        return (int(position['x'] // 32), int(position['y'] // 32))

    def near(a: dict, b: dict, tolerance: float = 0.05) -> bool:
        return abs(a['x'] - b['x']) <= tolerance and abs(a['y'] - b['y']) <= tolerance

    def process_log_text() -> str:
        text = ''
        for path in sorted(process_log_dir.glob('factorio-process-*.log')):
            text += path.read_text(errors='replace')
        return text

    def trace_lines(event: str) -> list[str]:
        return [line.split('[AUTORIO] ', 1)[1] for line in process_log_text().splitlines() if f'[AUTORIO] {event}' in line]

    humans = json_command(lua('rcon.print(helpers.table_to_json({connected=#game.connected_players}))'), 'human count')
    require(humans['connected'] == 0, humans)
    evidence['connected_players'] = 0

    if phase == 'verify':
        verify_after_restart(
            client, results, evidence, flush, command, json_command, lua, wait_ticks, actor_status, actor_lookup,
            vision_status, vision_entities, npc_position, near, trace_lines,
        )
        return

    # ---- 1. prototype facts the engine reports ---------------------------------------------------
    proto = json_command(
        lua(f"local p=prototypes.entity['{VISION}']; assert(p,'prototype missing'); local layers=0; for _ in pairs(p.collision_mask.layers) do layers=layers+1 end;",
            'local mask={}; for k,_ in pairs(p.trigger_target_mask) do mask[#mask+1]=k end;',
            'local emits=0; for _,v in pairs(p.emissions_per_second) do emits=emits+math.abs(v) end;',
            'local places=0; for name,item in pairs(prototypes.item) do if item.place_result and item.place_result.name==p.name then places=places+1 end end;',
            'local unlocks=0; for _,tech in pairs(prototypes.technology) do for _,effect in pairs(tech.effects) do',
            f"if effect.type=='unlock-recipe' and effect.recipe=='{VISION}' then unlocks=unlocks+1 end end end;",
            'local mineable=p.mineable_properties and p.mineable_properties.minable or false;',
            'local to_place=p.items_to_place_this and #p.items_to_place_this or 0;',
            "local function field(name) local ok,value=pcall(function() return p[name] end); if ok then return value end; return 'unreadable' end;",
            "rcon.print(helpers.table_to_json({type=p.type,radius=field('chunk_exploration_radius'),collision_layers=layers,trigger_mask=mask,",
            "selectable=p.selectable_in_game,military=field('is_military_target'),passengers=field('allow_passengers'),",
            f"emissions=emits,item_exists=prototypes.item['{VISION}']~=nil,recipe_exists=prototypes.recipe['{VISION}']~=nil,",
            'placed_by_items=places,unlocking_technologies=unlocks,mineable=mineable,items_to_place=to_place,',
            'inventory_size=p.get_inventory_size(defines.inventory.car_trunk) or 0,',
            'flags={not_on_map=p.has_flag("not-on-map"),not_blueprintable=p.has_flag("not-blueprintable"),not_deconstructable=p.has_flag("not-deconstructable"),',
            'not_upgradable=p.has_flag("not-upgradable"),no_copy_paste=p.has_flag("no-copy-paste"),not_in_kill_statistics=p.has_flag("not-in-kill-statistics")}}))'),
        'prototype facts',
    )
    evidence['prototype'] = proto
    require(proto['type'] == 'car', proto)
    require(proto['radius'] == 2, proto)  # never grown: the 5x5 window of KNOWLEDGE_CHUNK_RADIUS
    require(proto['collision_layers'] == 0, proto)
    require(proto['trigger_mask'] == ['sgluna-untargetable'], proto)
    require(proto['selectable'] is False, proto)
    require(proto['military'] is False, proto)
    require(proto['passengers'] is False, proto)
    require(proto['emissions'] == 0, proto)
    require(proto['item_exists'] is False and proto['recipe_exists'] is False, proto)
    require(proto['placed_by_items'] == 0 and proto['unlocking_technologies'] == 0, proto)
    require(proto['mineable'] is False and proto['items_to_place'] == 0, proto)
    require(proto['inventory_size'] == 0, proto)
    require(all(proto['flags'].values()), proto)
    print('PASS: prototype is a hidden car with radius 2, no collision, not selectable, not a military target, no item/recipe/technology, no emissions', flush=True)

    # ---- 2. the live vehicle ---------------------------------------------------------------------
    json_command(lua("remote.call('autorio_operations','cancel_all_tasks'); rcon.print('{}')"), 'cancel tasks')
    wait_ticks(FOLLOW_TICKS)
    first = vision_status()
    require(first.get('present') is True, first)
    entities = vision_entities()
    require(len(entities) == 1 and entities[0]['unit'] == first['unit_number'], (first, entities))
    require(first['actor_id'] == actor_id(), first)
    require(first['force'] == 'player', first)
    require(first['destructible'] is False and first['minable'] is False and first['operable'] is False and first['rotatable'] is False, first)
    require(first['is_military_target'] is False, first)
    require(near(first['position'], npc_position()), (first, npc_position()))
    evidence['live_vehicle'] = first
    unit_number = first['unit_number']
    # The common smoke (run.py) clears the area around the NPC, which can remove the first vehicle;
    # the controller rebuilds it, so the live one is the last `created` line.
    created = trace_lines('npc.vision.created')
    require(created and f"actor_id={first['actor_id']}" in created[-1] and f'unit_number={unit_number}' in created[-1] and 'reason=no_vehicle' in created[-1], created)
    print(f'PASS: one live vehicle (unit {unit_number}, active={first["active"]}) with every runtime flag off, on the NPC, traced: {created[-1]}', flush=True)

    # ---- 3. it follows the NPC: new chunk, then the correction timer -----------------------------
    def teleport_npc(x: float, y: float, radius: int = 4) -> dict:
        moved = json_command(
            lua(actor_lookup(), "local p=s.find_non_colliding_position('character',{%s,%s},%d,0.5); assert(p,'no spot'); a.teleport(p);" % (x, y, radius),
                'rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))'),
            'teleport NPC',
        )
        return moved

    for label, target in (('new_chunk', NPC_HOP_ONE), ('same_chunk_timer', NPC_HOP_TWO), ('second_new_chunk', NPC_HOP_THREE)):
        before_chunk = chunk_of(npc_position())
        moved = teleport_npc(*target)
        wait_ticks(FOLLOW_TICKS)
        status = vision_status()
        entities = vision_entities()
        require(len(entities) == 1 and entities[0]['unit'] == unit_number, (label, status, entities))
        require(near(status['position'], moved), (label, status, moved))
        require(near(status['position'], npc_position()), (label, status, npc_position()))
        evidence[f'follow_{label}'] = {'from_chunk': before_chunk, 'to_chunk': chunk_of(moved), 'vehicle': status['position'], 'npc': moved}
        if label == 'same_chunk_timer':
            require(before_chunk == chunk_of(moved), 'timer hop must stay inside one chunk')
    print('PASS: the vehicle followed the NPC across a new chunk, within a chunk (timer), and into another chunk, always the same single entity', flush=True)

    # ---- 4. what the engine charts (zero connected players) ---------------------------------------
    teleport_npc(*NPC_HOP_ONE)
    wait_ticks(FOLLOW_TICKS)
    npc_chunk = chunk_of(npc_position())
    npc_window = window(*npc_chunk)
    probes = {}
    generate(2, 2, 3)
    generate(-3, 2, 3)
    generate(1, 1, 1)
    generate(1, -2, 3)
    for label, (px, py), active in (('far_active', (80.0, 80.0), True), ('far_inactive', (-80.0, 80.0), False)):
        made = json_command(
            lua("local s=game.surfaces[1]; local e=s.create_entity{name='%s',position={%s,%s},force='player',raise_built=false};" % (VISION, px, py),
                'e.active=%s; rcon.print(helpers.table_to_json({unit=e.unit_number,active=e.active}))' % ('true' if active else 'false')),
            f'exploration probe {label}',
        )
        probes[label] = {'unit': made['unit'], 'active': made['active'], 'chunk': (int(px // 32), int(py // 32))}
    # Control 1: the force chart API itself. Control 2: a powered radar (the removed design).
    control_chunk = (1, 1)
    json_command(
        lua("local s=game.surfaces[1]; game.forces.player.chart(s,{{32,32},{63,63}}); rcon.print('{}')"),
        'control LuaForce.chart',
    )
    radar = json_command(
        lua("local s=game.surfaces[1]; local f=game.forces.player; local tiles={}; for x=50,70 do for y=-70,-50 do tiles[#tiles+1]={name='landfill',position={x,y}} end end;",
            's.set_tiles(tiles,true,false,true);',
            "local r=s.create_entity{name='radar',position={60.5,-59.5},force=f}; local p=s.create_entity{name='small-electric-pole',position={63.5,-59.5},force=f};",
            "local g=s.create_entity{name='electric-energy-interface',position={65,-57},force=f}; g.power_production=10000000; g.electric_buffer_size=10000000; g.energy=10000000;",
            'rcon.print(helpers.table_to_json({built=r~=nil and p~=nil and g~=nil}))'),
        'control radar',
    )
    require(radar['built'] is True, radar)
    wait_ticks(600)
    radar_state = json_command(
        lua("local r=game.surfaces[1].find_entities_filtered{name='radar'}[1]; rcon.print(helpers.table_to_json({status=r.status,working=(r.status==defines.entity_status.working)}))"),
        'control radar state',
    )
    windows = {
        'npc_window': {'chunk': npc_chunk, **window(*npc_chunk)},
        'far_active': {**window(*probes['far_active']['chunk']), 'active': probes['far_active']['active']},
        'far_inactive': {**window(*probes['far_inactive']['chunk']), 'active': probes['far_inactive']['active']},
        'control_force_chart': window(*control_chunk, 0),
        'control_radar': window(1, -2, 1),
    }
    evidence['exploration'] = {'windows': windows, 'radar_control': radar_state, 'connected_players': 0}
    require(radar_state['working'] is True, ('the radar control must be powered and working, or it proves nothing', radar_state))
    require(all(w['generated'] == w['total'] for w in windows.values()), ('every probed chunk is generated', windows))
    vehicle_windows = [windows['npc_window'], windows['far_active'], windows['far_inactive']]
    controls = [windows['control_force_chart'], windows['control_radar']]
    controls_chart = any(w['charted'] > 0 for w in controls)
    if any(w['charted'] > 0 for w in vehicle_windows):
        # The engine does chart here, so the vehicle must chart its whole window (a far
        # probe is outside anything the mod charts itself).
        for key in ('npc_window', 'far_active'):
            require(windows[key]['charted'] == windows[key]['total'], (key, windows[key]))
        evidence['exploration']['result'] = 'explores_with_zero_players'
        evidence['exploration']['active_matters'] = windows['far_active']['charted'] != windows['far_inactive']['charted']
        print(f"PASS: the vehicle charts its window with zero connected players (active={windows['far_active']['charted']}/{windows['far_active']['total']}, "
              f"inactive={windows['far_inactive']['charted']}/{windows['far_inactive']['total']})", flush=True)
    else:
        # Nothing charted anywhere: it only counts as an engine property if the controls
        # that must chart do not chart either. A vehicle-only failure is a real failure.
        require(not controls_chart, ('the engine charts for the controls but not for the vehicle', windows))
        evidence['exploration']['result'] = 'limitation_zero_connected_players'
        evidence['exploration']['active_matters'] = 'not_observable_without_a_connected_player'
        print('LIMITATION zero_connected_players_no_engine_chart: Factorio 2.0.77 charts nothing for a force with no connected player, '
              'for the vehicle (active and inactive), LuaForce.chart and a powered working radar alike '
              f"(charted/total chunks: npc window {windows['npc_window']['charted']}/{windows['npc_window']['total']}, "
              f"far active {windows['far_active']['charted']}/{windows['far_active']['total']}, "
              f"far inactive {windows['far_inactive']['charted']}/{windows['far_inactive']['total']}, "
              f"LuaForce.chart control {windows['control_force_chart']['charted']}/{windows['control_force_chart']['total']}, "
              f"radar control {windows['control_radar']['charted']}/{windows['control_radar']['total']}). "
              'Vehicle exploration with a connected player is therefore NOT proven here; the NPC keeps its own map knowledge for this case.', flush=True)
    json_command(
        lua(f"for _,e in pairs(game.surfaces[1].find_entities_filtered{{name={{'radar','small-electric-pole','electric-energy-interface'}}}}) do e.destroy() end;",
            f"for _,e in pairs(game.surfaces[1].find_entities_filtered{{name='{VISION}'}}) do",
            f"if e.unit_number~={unit_number} then e.destroy() end end; rcon.print('{{}}')"),
        'remove exploration probes',
    )
    require(len(vision_entities()) == 1, 'probes removed, live vehicle kept')
    flush()

    # ---- 5. the vehicle cannot be damaged or blocked; nothing sees it ------------------------------
    damage = json_command(
        lua(f"local e=game.surfaces[1].find_entities_filtered{{name='{VISION}'}}[1]; local before=e.health; local dealt=e.damage(1000,'enemy'); local after=e.valid and e.health or -1;",
            'rcon.print(helpers.table_to_json({before=before,dealt=dealt,after=after,valid=e.valid,minable=e.minable,destructible=e.destructible}))'),
        'damage the live vehicle',
    )
    require(damage['dealt'] == 0 and damage['valid'] is True and damage['before'] == damage['after'], damage)
    evidence['live_damage'] = damage

    # A car always has a driver seat in the engine's eyes, so entry is tried every way the API offers,
    # on the live vehicle (every runtime flag off) and on a fresh instance (operable, destructible), with
    # the NPC standing on it. Nothing may end up inside, and nobody may be driving.
    json_command(
        lua(actor_lookup(), f"local fresh=s.create_entity{{name='{VISION}',position=a.position,force='player',raise_built=false}};",
            'rcon.print(helpers.table_to_json({unit=fresh.unit_number}))'),
        'driver test instance',
    )
    entry = json_command(
        lua(actor_lookup(), f"local live=nil; local fresh=nil; for _,e in pairs(s.find_entities_filtered{{name='{VISION}'}}) do if e.unit_number=={unit_number} then live=e else fresh=e end end;",
            'local out={}; for label,v in pairs({live=live,fresh=fresh}) do local r={};',
            "local attempts={{'set_driver',function() v.set_driver(a) end},{'set_passenger',function() v.set_passenger(a) end},",
            "{'set_driving',function() a.set_driving(true) end},{'set_driving_forced',function() a.set_driving(true,true) end}};",
            'for _,attempt in ipairs(attempts) do local ok,err=pcall(attempt[2]);',
            'r[attempt[1]]={threw=not ok,driver=v.get_driver()~=nil,passenger=v.get_passenger()~=nil,npc_driving=a.driving,npc_vehicle=a.vehicle~=nil}; if a.driving then a.set_driving(false) end end;',
            'out[label]=r end; fresh.destroy(); rcon.print(helpers.table_to_json(out))'),
        'vehicle entry attempts',
    )
    # Control (alone, so set_driving cannot pick the vision vehicle): an ordinary car does take the NPC, so the
    # attempts above can fail only because of the prototype.
    control_car = json_command(
        lua(actor_lookup(), "local car=s.create_entity{name='car',position=a.position,force='player'}; assert(car,'control car');",
            "car.set_driver(a); local entered=car.get_driver()~=nil and a.driving; if a.driving then a.set_driving(false) end; car.destroy();",
            'rcon.print(helpers.table_to_json({entered=entered}))'),
        'control car entry',
    )
    require(control_car['entered'] is True, ('an ordinary car must accept the NPC as driver', control_car))
    for label, attempts in entry.items():
        for attempt, result in attempts.items():
            require(result['driver'] is False and result['passenger'] is False and result['npc_driving'] is False and result['npc_vehicle'] is False,
                    ('the NPC got inside the vision vehicle', label, attempt, result))
    evidence['driver_entry'] = {**entry, 'control_car': control_car}
    print('PASS: set_driver, set_passenger and set_driving (also forced) never put the NPC inside the live vehicle or a fresh instance while an ordinary car takes it as driver', flush=True)
    require(len(vision_entities()) == 1, 'only the live vehicle is left after the entry attempts')

    # Arena for placement, belts and clearing around the NPC (a test-only fixture, not a blueprint).
    teleport_npc(*NPC_HOP_ONE)
    json_command(lua("remote.call('autorio_operations','cancel_all_tasks'); rcon.print('{}')"), 'cancel tasks')
    wait_ticks(FOLLOW_TICKS)
    items = [('wooden-chest', 3), ('stone-furnace', 1), ('transport-belt', 4), ('burner-inserter', 1), ('coal', 12)]
    inserts = ' '.join(f"inv.insert{{name='{name}',count={count}}};" for name, count in items)
    arena = json_command(
        lua(actor_lookup(), 'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y);',
            f"for _,e in pairs(s.find_entities_filtered{{area={{{{ox-12,oy-8}},{{ox+12,oy+12}}}}}}) do if e~=a and e.type~='character' and e.name~='{VISION}' then e.destroy() end end;",
            'local tiles={}; for x=ox-12,ox+12 do for y=oy-8,oy+12 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);',
            'local inv=a.get_main_inventory(); inv.clear(); ' + inserts,
            'a.teleport({ox-2+0.5,oy-3+0.5}); game.speed=4;',
            'rcon.print(helpers.table_to_json({ox=ox,oy=oy,x=a.position.x,y=a.position.y}))'),
        'arena fixture',
    )
    ox, oy = arena['ox'], arena['oy']
    evidence['arena'] = arena
    # Test instances of the same prototype, standing exactly where the NPC will build.
    def make_instance(x: float, y: float) -> int:
        made = json_command(
            lua(f"local e=game.surfaces[1].create_entity{{name='{VISION}',position={{{x},{y}}},force='player',raise_built=false}};",
                'rcon.print(helpers.table_to_json({unit=e.unit_number,x=e.position.x,y=e.position.y}))'),
            'test instance',
        )
        require(abs(made['x'] - x) < 0.01 and abs(made['y'] - y) < 0.01, made)
        return made['unit']

    def instance_valid(unit: int) -> dict:
        return json_command(
            lua('local found=nil; for _,sf in pairs(game.surfaces) do',
                f"for _,e in pairs(sf.find_entities_filtered{{name='{VISION}'}}) do if e.unit_number=={unit} then found=e end end end;",
                'rcon.print(helpers.table_to_json({valid=found~=nil,x=found and found.position.x or 0,y=found and found.position.y or 0}))'),
            'instance state',
        )

    # 5a. placement: a chest and a furnace on the exact tile it occupies.
    chest_at = {'x': ox + 4 + 0.5, 'y': oy + 0.5}
    chest_instance = make_instance(chest_at['x'], chest_at['y'])
    placed = run_operation(remote_call('autorio_operations', 'place_entity', repr('wooden-chest'), str(chest_at['x']), str(chest_at['y'])), 'chest on the vehicle tile')
    require(placed.get('completed') is True and placed.get('code') == 'completed', placed)
    require(abs(placed['placed_position']['x'] - chest_at['x']) < 1e-6 and abs(placed['placed_position']['y'] - chest_at['y']) < 1e-6, placed)
    require(instance_valid(chest_instance)['valid'] is True, 'the vehicle survived the chest placed on its tile')
    furnace_at = {'x': ox + 5.0, 'y': oy + 3.0}
    furnace_instance = make_instance(furnace_at['x'] - 0.5, furnace_at['y'] - 0.5)
    placed_furnace = run_operation(remote_call('autorio_operations', 'place_entity', repr('stone-furnace'), str(furnace_at['x']), str(furnace_at['y'])), 'furnace over the vehicle')
    require(placed_furnace.get('completed') is True and placed_furnace.get('code') == 'completed', placed_furnace)
    require(instance_valid(furnace_instance)['valid'] is True, 'the vehicle survived the furnace built over it')
    evidence['placement'] = {'chest': placed, 'furnace': placed_furnace}
    print('PASS: the NPC placed a wooden chest and a stone furnace on the exact tile the vehicle occupies; the vehicle was not an obstacle and was not removed', flush=True)

    # 5b. a belt and a burner inserter run through it: coal moves chest -> inserter -> belts, past the vehicle.
    src_chest = run_operation(remote_call('autorio_operations', 'place_entity', repr('wooden-chest'), str(ox - 6 + 0.5), str(oy + 0.5)), 'source chest')
    require(src_chest.get('code') == 'completed', src_chest)
    json_command(
        lua(f"local c=game.surfaces[1].find_entities_filtered{{name='wooden-chest',position={{{ox - 6 + 0.5},{oy + 0.5}}},radius=0.2}}[1]; c.insert{{name='coal',count=8}}; rcon.print('{{}}')"),
        'fill source chest',
    )
    inserter_instance = make_instance(ox - 5 + 0.5, oy + 0.5)
    inserter = run_operation(remote_call('autorio_operations', 'place_entity', repr('burner-inserter'), str(ox - 5 + 0.5), str(oy + 0.5), str(WEST)), 'inserter on the vehicle tile')
    require(inserter.get('code') == 'completed', inserter)
    json_command(
        lua(f"local i=game.surfaces[1].find_entities_filtered{{name='burner-inserter',position={{{ox - 5 + 0.5},{oy + 0.5}}},radius=0.2}}[1]; i.insert{{name='coal',count=2}}; rcon.print('{{}}')"),
        'fuel the burner inserter',
    )
    belt_instance = make_instance(ox - 3 + 0.5, oy + 0.5)
    for dx in (-4, -3, -2, -1):
        belt = run_operation(remote_call('autorio_operations', 'place_entity', repr('transport-belt'), str(ox + dx + 0.5), str(oy + 0.5), str(EAST)), f'belt {dx}')
        require(belt.get('code') == 'completed', belt)
    deadline = time.monotonic() + 60.0
    moved = None
    while time.monotonic() < deadline:
        moved = json_command(
            lua('local s=game.surfaces[1]; local total=0; local at_end=0;',
                f"for dx=-4,-1 do local b=s.find_entities_filtered{{name='transport-belt',position={{{ox}+dx+0.5,{oy + 0.5}}},radius=0.2}}[1];",
                'local n=b.get_transport_line(1).get_item_count()+b.get_transport_line(2).get_item_count(); total=total+n; if dx==-1 then at_end=n end end;',
                "local chest=s.find_entities_filtered{name='wooden-chest',position={%s,%s},radius=0.2}[1];" % (ox - 6 + 0.5, oy + 0.5),
                'rcon.print(helpers.table_to_json({on_belts=total,at_end=at_end,left_in_chest=chest.get_item_count("coal")}))'),
            'belt transport',
        )
        if moved['at_end'] > 0:
            break
        time.sleep(0.5)
    require(moved is not None and moved['at_end'] > 0, ('coal never crossed the vehicle tile to the end of the belt', moved))
    require(instance_valid(inserter_instance)['valid'] is True and instance_valid(belt_instance)['valid'] is True, 'vehicles survived under the inserter and belt')
    evidence['transport'] = moved
    print(f'PASS: a burner inserter and a belt built on vehicle tiles moved coal past them to the belt end ({moved})', flush=True)

    # 5c. area clearing neither removes it nor trips over it, but still clears a real blocker.
    clear_x, clear_y = ox + 8.5, oy + 9.5
    clear_instance = make_instance(clear_x, clear_y)
    tree = json_command(
        lua("local s=game.surfaces[1]; local name=nil; for _,n in ipairs({'tree-01','tree-02','tree-04','dead-tree-desert'}) do if prototypes.entity[n] then name=n; break end end; assert(name,'no tree prototype');",
            f"local t=s.create_entity{{name=name,position={{{clear_x + 1.0},{clear_y - 1.0}}}}}; rcon.print(helpers.table_to_json({{name=name,placed=t~=nil,x=t and t.position.x or 0,y=t and t.position.y or 0}}))"),
        'clearing control tree',
    )
    require(tree['placed'] is True, tree)
    cleared = run_operation(remote_call('autorio_operations', 'clear_construction_area', str(clear_x), str(clear_y), '6', '6'), 'area clearing over the vehicle', 40.0)
    require(instance_valid(clear_instance)['valid'] is True, 'area clearing must never remove the vehicle')
    remaining_tree = json_command(
        lua(f"rcon.print(helpers.table_to_json({{n=#game.surfaces[1].find_entities_filtered{{name='{tree['name']}',position={{{tree['x']},{tree['y']}}},radius=0.3}}}}))"),
        'clearing control',
    )
    require(remaining_tree['n'] == 0, ('area clearing still removed the real blocker', remaining_tree, cleared))
    evidence['clearing'] = {'receipt': cleared, 'tree': tree, 'remaining_tree': remaining_tree}
    print('PASS: area clearing removed a tree beside the vehicle and left the vehicle alone', flush=True)

    # 5d. the NPC cannot see or reach it: observation, discovery, map reads and exact references.
    raw = json_command(
        lua(actor_lookup(), 'local all=s.find_entities_filtered{position=a.position,radius=20}; local vision=0; local units={};',
            f"for _,e in pairs(all) do if e.name=='{VISION}' then vision=vision+1; units[#units+1]=e.unit_number end end;",
            'rcon.print(helpers.table_to_json({all=#all,vision=vision,units=units,x=a.position.x,y=a.position.y}))'),
        'raw scan',
    )
    require(raw['vision'] >= 5, ('the engine itself does hold the vision entities near the NPC', raw))
    units = raw['units'] if isinstance(raw['units'], list) else []
    seen: dict[str, str] = {}
    seen['nearby'] = command(lua("rcon.print(helpers.table_to_json(remote.call('autorio_tools','get_nearby_entities',20)))"))
    seen['status'] = command(lua(f"rcon.print(helpers.table_to_json(remote.call('autorio_tools','get_entity_status','{VISION}',20)))"))
    seen['discovery'] = command(lua(f"rcon.print(helpers.table_to_json(remote.call('autorio_discovery','find_entities','{VISION}',512,8)))"))
    seen['map_area'] = command(lua(f"rcon.print(helpers.table_to_json(remote.call('autorio_map','query_area',1,{raw['x']},{raw['y']},20,64)))"))
    seen['map_area_by_name'] = command(lua(f"rcon.print(helpers.table_to_json(remote.call('autorio_map','query_area',1,{raw['x']},{raw['y']},20,64,'{VISION}')))"))
    for unit in units[:3]:
        seen[f'inspect_{unit}'] = command(lua(f"rcon.print(helpers.table_to_json(remote.call('autorio_map','inspect_entity',{unit})))"))
    # Reads that list entities must not return it; reads that were asked about it by name or unit
    # number echo the request, so they are checked by what they answer instead.
    for name in ('nearby', 'map_area'):
        require(VISION not in seen[name], (name, 'a read named the vision vehicle', seen[name][:400]))
        for unit in units:
            require(re.search(rf'"unit_number":\s*{unit}(?!\d)', seen[name]) is None, (name, 'a read returned a vision unit number', unit))
    nearby = decode_json(seen['nearby'], 'nearby entities')
    require(nearby['matched_count'] == raw['all'] - raw['vision'], ('nearby reads count everything but the vision entities', nearby['matched_count'], raw))
    require(nearby['matched_count'] > 0 and 'wooden-chest' in seen['nearby'], 'the nearby read still sees ordinary entities')
    require(decode_json(seen['status'], 'status').get('found') is False, seen['status'])
    require(decode_json(seen['discovery'], 'discovery').get('found') is False, seen['discovery'])
    area = decode_json(seen['map_area'], 'map area')
    require(area.get('ok') is True and area.get('returned_count', 0) > 0, area)
    require(decode_json(seen['map_area_by_name'], 'map area by name').get('returned_count') == 0, seen['map_area_by_name'])
    for unit in units[:3]:
        require(decode_json(seen[f'inspect_{unit}'], 'inspect').get('ok') is False, seen[f'inspect_{unit}'])
    evidence['invisible'] = {'engine_entities_in_radius': raw['all'], 'vision_in_radius': raw['vision'], 'nearby_matched': nearby['matched_count']}
    print(f"PASS: the NPC's nearby, status, discovery and map reads never returned the vehicle ({raw['vision']} present in the engine within 20 tiles)", flush=True)

    # Remove the arena's test instances and everything built for them.
    json_command(
        lua(actor_lookup(), f"for _,e in pairs(s.find_entities_filtered{{name='{VISION}'}}) do if e.unit_number~={unit_number} then e.destroy() end end;",
            "for _,e in pairs(s.find_entities_filtered{position=a.position,radius=30,name={'wooden-chest','stone-furnace','transport-belt','burner-inserter'}}) do e.destroy() end; game.speed=1; rcon.print('{}')"),
        'remove arena',
    )
    require(len(vision_entities()) == 1, 'only the live vehicle is left')

    # ---- 6. enemies: nothing hostile targets or damages it ----------------------------------------------
    # Runtime reality this test found: an enemy that is told to hunt an area attacks any destructible
    # entity of the player force, military target or not (a plain chest dies the same way), so the
    # prototype flags alone do not stop it. The runtime `destructible = false` does: such an entity is
    # no valid target at all. The live configuration is therefore tested against a hunting biter and
    # an armed enemy turret, with a destructible instance as the control that proves the hunters work.
    hostile_before = json_command(lua('rcon.print(helpers.table_to_json({peaceful=game.surfaces[1].peaceful_mode}))'), 'peaceful mode')
    json_command(
        lua('local s=game.surfaces[1]; local f=game.forces; s.peaceful_mode=false; game.speed=4;',
            "f.enemy.set_cease_fire('player',false); f.player.set_cease_fire('enemy',false); f.enemy.set_friend('player',false);",
            'local tiles={}; for x=-120,-60 do for y=-120,-60 do tiles[#tiles+1]={name="landfill",position={x,y}} end end; s.set_tiles(tiles,true,false,true);',
            f"for _,e in pairs(s.find_entities_filtered{{area={{{{-120,-120}},{{-60,-60}}}}}}) do if e.type~='character' and e.name~='{VISION}' then e.destroy() end end;",
            f"local live=s.create_entity{{name='{VISION}',position={{-100.5,-100.5}},force='player',raise_built=false}}; live.destructible=false;",
            f"local control=s.create_entity{{name='{VISION}',position={{-80.5,-100.5}},force='player',raise_built=false}};",
            "local t=s.create_entity{name='gun-turret',position={-90,-112},force='enemy'}; t.insert{name='firearm-magazine',count=10};",
            "for _,pos in pairs({{-100.5,-100.5},{-80.5,-100.5}}) do local b=s.create_entity{name='small-biter',position={pos[1]+6,pos[2]},force='enemy'};",
            "b.commandable.set_command{type=defines.command.attack_area,destination={pos[1],pos[2]},radius=20,distraction=defines.distraction.by_anything} end;",
            'rcon.print(helpers.table_to_json({live=live.unit_number,control=control.unit_number,live_destructible=live.destructible,control_destructible=control.destructible}))'),
        'hostile arena',
    )

    def hostile_state() -> dict:
        return json_command(
            lua("local s=game.surfaces[1]; local t=s.find_entities_filtered{name='gun-turret',force='enemy'}[1]; local live=nil; local control=nil;",
                f"for _,e in pairs(s.find_entities_filtered{{name='{VISION}',area={{{{-120,-120}},{{-60,-60}}}}}}) do if e.destructible then control=e else live=e end end;",
                "local p=s.find_entities_filtered{name='gun-turret',force='player'}[1]; local biters={}; for _,b in pairs(s.find_entities_filtered{name='small-biter'}) do",
                "local c=b.commandable.command; biters[#biters+1]={x=b.position.x,y=b.position.y,command=c and c.type or -1,health=b.health} end;",
                "rcon.print(helpers.table_to_json({ammo=t.get_inventory(defines.inventory.turret_ammo).get_item_count('firearm-magazine'),",
                "live_valid=live~=nil,live_health=live and live.health or -1,control_valid=control~=nil,player_turret_health=p and p.health or -1,biters=biters}))"),
            'hostile state',
        )

    hostile_start = hostile_state()
    require(hostile_start['live_valid'] is True and hostile_start['control_valid'] is True and hostile_start['ammo'] == 10, hostile_start)
    wait_ticks(900)
    isolated = hostile_state()
    require(isolated['live_valid'] is True and isolated['live_health'] == hostile_start['live_health'], ('hunters damaged the live vehicle', hostile_start, isolated))
    require(isolated['ammo'] == 10, ('the enemy turret shot at something', isolated))
    require(isolated['control_valid'] is False, ('the hunting biter never engaged even a destructible instance, so the isolation proves nothing', isolated))
    pollution = json_command(lua('local s=game.surfaces[1]; rcon.print(helpers.table_to_json({here=s.get_pollution({-100.5,-100.5})}))'), 'pollution')
    require(pollution['here'] == 0, pollution)
    # Control: the same enemy turret does shoot a player military target put in its range.
    json_command(lua("game.surfaces[1].create_entity{name='gun-turret',position={-90,-104},force='player'}; rcon.print('{}')"), 'control turret')
    wait_ticks(600)
    control = hostile_state()
    require(control['ammo'] < 10 and control['player_turret_health'] < 400, ('the enemy turret must engage a real target or the isolation proves nothing', control))
    require(control['live_valid'] is True and control['live_health'] == hostile_start['live_health'], ('enemies damaged the live vehicle', control))
    evidence['hostile'] = {'start': hostile_start, 'isolated_900_ticks': isolated, 'with_control_target': control, 'pollution': pollution, 'peaceful_before': hostile_before}
    json_command(
        lua('local s=game.surfaces[1]; for _,e in pairs(s.find_entities_filtered{area={{-120,-120},{-60,-60}}}) do if e.type~="character" then e.destroy() end end;',
            f"s.peaceful_mode={'true' if hostile_before['peaceful'] else 'false'}; game.speed=1; rcon.print('{{}}')"),
        'remove hostile arena',
    )
    require(len(vision_entities()) == 1, 'only the live vehicle is left after the hostile arena')
    print(f"PASS: a hunting biter and an armed enemy turret never harmed the live vehicle in 1500 ticks (health {isolated['live_health']}, ammo {isolated['ammo']}); "
          f"the same hunter destroyed a destructible instance and the turret shot a real target (ammo {control['ammo']}); no pollution", flush=True)

    # ---- 7. rebuilt after removal, orphans swept -----------------------------------------------------
    current_actor = actor_id()
    old_unit = unit_number
    created_before = len(trace_lines('npc.vision.created'))
    json_command(
        lua(f"local s=game.surfaces[1]; s.create_entity{{name='{VISION}',position={{5,5}},force='player',raise_built=false}};",
            f"for _,e in pairs(s.find_entities_filtered{{name='{VISION}'}}) do if e.unit_number=={old_unit} then e.destroy() end end; rcon.print('{{}}')"),
        'remove the live vehicle and leave an orphan',
    )
    wait_ticks(20)
    rebuilt = vision_status()
    entities = vision_entities()
    require(rebuilt.get('present') is True and rebuilt['unit_number'] != old_unit and rebuilt['actor_id'] == current_actor, rebuilt)
    require(len(entities) == 1 and entities[0]['unit'] == rebuilt['unit_number'], ('the orphan was swept', entities))
    time.sleep(1.0)
    destroyed = trace_lines('npc.vision.destroyed')
    swept = trace_lines('npc.vision.swept')
    require(any(f'unit_number={old_unit}' in line and 'reason=entity_invalid' in line for line in destroyed), destroyed)
    require(any('destroyed=1' in line and 'reason=before_create:no_vehicle' in line for line in swept), swept)
    require(len(trace_lines('npc.vision.created')) == created_before + 1, trace_lines('npc.vision.created'))
    evidence['rebuilt'] = {'old_unit': old_unit, 'new': rebuilt, 'destroyed': destroyed[-1], 'swept': swept[-1]}
    unit_number = rebuilt['unit_number']
    print(f'PASS: after the vehicle was removed it was rebuilt (unit {old_unit} -> {unit_number}) and an orphan was swept; traced: {swept[-1]}', flush=True)

    # ---- 8. death: the vehicle goes with the body and is rebuilt for the replacement -----------------
    old_actor = current_actor
    death = json_command(
        lua(actor_lookup(), 'local ok=a.die(game.forces.enemy); rcon.print(helpers.table_to_json({died=ok,old_valid=a.valid}))'),
        'NPC death',
    )
    require(death['died'] is True and death['old_valid'] is False, death)
    deadline = time.monotonic() + 20.0
    replacement = None
    while time.monotonic() < deadline:
        candidate = vision_status()
        if candidate.get('present') is True and candidate['actor_id'] != old_actor:
            replacement = candidate
            break
        time.sleep(0.2)
    require(replacement is not None, 'no vision vehicle for the replacement NPC')
    entities = vision_entities()
    require(len(entities) == 1 and entities[0]['unit'] == replacement['unit_number'] and replacement['unit_number'] != unit_number, (replacement, entities))
    require(replacement['actor_id'] == actor_id(), replacement)
    time.sleep(1.0)
    require(any(f'actor_id={old_actor}' in line and 'reason=actor_replaced' in line for line in trace_lines('npc.vision.destroyed')), trace_lines('npc.vision.destroyed'))
    evidence['death'] = {'old_actor': old_actor, 'replacement': replacement}
    unit_number = replacement['unit_number']
    print(f"PASS: after the NPC died the old vehicle was destroyed and exactly one was built for replacement actor {replacement['actor_id']}", flush=True)

    # ---- 9. save for the real restart ---------------------------------------------------------------
    wait_ticks(FOLLOW_TICKS)
    teleport_npc(*NPC_HOP_THREE)
    wait_ticks(FOLLOW_TICKS)
    before_save = vision_status()
    require(before_save.get('present') is True and near(before_save['position'], npc_position()), before_save)
    require(save_path is not None, '--save is required for the prepare phase')
    old_mtime = save_path.stat().st_mtime_ns
    command(lua('game.server_save()'))
    save_deadline = time.monotonic() + 20.0
    while time.monotonic() < save_deadline:
        try:
            stat = save_path.stat()
        except FileNotFoundError:
            time.sleep(0.1)
            continue
        if stat.st_mtime_ns > old_mtime and stat.st_size > 0:
            break
        time.sleep(0.1)
    else:
        raise AssertionError(f'server save did not update {save_path}')
    evidence['before_save'] = before_save
    evidence['status'] = 'prepared'
    flush()
    (results / 'npc-vision-before.json').write_text(json.dumps({'actor_id': before_save['actor_id'], 'unit_number': before_save['unit_number'], 'position': before_save['position']}, indent=2))
    print(f"[npc-test] Saved NPC vision state for restart: actor_id={before_save['actor_id']}, vehicle unit={before_save['unit_number']}", flush=True)


def verify_after_restart(client, results, evidence, flush, command, json_command, lua, wait_ticks, actor_status, actor_lookup,
                         vision_status, vision_entities, npc_position, near, trace_lines) -> None:
    before = json.loads((results / 'npc-vision-before.json').read_text())
    probe = command(lua('rcon.print("SGLUNA_RESTART_READY")'))
    require(probe == 'SGLUNA_RESTART_READY', probe)
    # The supervisor issues this replicated repair command once the server has loaded the save.
    json_command(lua("rcon.print(helpers.table_to_json(remote.call('autorio_actor','reconcile_after_load')))"), 'post-restart reconciliation')
    wait_ticks(120)

    status = vision_status()
    require(status.get('present') is True, ('the vehicle did not survive the restart', status))
    require(status['actor_id'] == before['actor_id'] and status['unit_number'] == before['unit_number'], (before, status))
    entities = vision_entities()
    require(len(entities) == 1 and entities[0]['unit'] == before['unit_number'], ('exactly one vehicle after reload', entities))
    require(status['destructible'] is False and status['minable'] is False and status['operable'] is False and status['rotatable'] is False, status)
    require(near(status['position'], npc_position()), (status, npc_position()))
    evidence['after_restart'] = status

    # It still follows the NPC after the reload.
    moved = json_command(
        lua(actor_lookup(), "local p=s.find_non_colliding_position('character',{-60,30},20,0.5); assert(p); a.teleport(p);",
            'rcon.print(helpers.table_to_json({x=a.position.x,y=a.position.y}))'),
        'teleport NPC after reload',
    )
    wait_ticks(150)
    followed = vision_status()
    require(len(vision_entities()) == 1 and followed['unit_number'] == before['unit_number'], followed)
    require(near(followed['position'], moved), (followed, moved))
    evidence['follows_after_restart'] = {'vehicle': followed['position'], 'npc': moved}

    # The restart rebuilt nothing and swept nothing: the persisted entity was simply reused.
    created = trace_lines('npc.vision.created')
    destroyed = trace_lines('npc.vision.destroyed')
    built_before_save = [line for line in created if f"actor_id={before['actor_id']}" in line and f"unit_number={before['unit_number']}" in line]
    require(len(built_before_save) == 1, ('the vehicle was created once, before the save', created))
    restarted_log = (results / 'factorio-process-2.log').read_text(errors='replace')
    require('npc.vision.created' not in restarted_log and 'npc.vision.destroyed' not in restarted_log, 'the restarted server rebuilt or destroyed a vehicle instead of reusing the saved one')
    evidence['trace'] = {'created': created, 'destroyed': destroyed}
    evidence['status'] = 'pass'
    flush()
    print(f"PASS: after a real restart exactly one vision vehicle (unit {before['unit_number']}) survived, was not rebuilt, and still follows the NPC", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    parser.add_argument('--phase', choices=['prepare', 'verify'], default='prepare')
    parser.add_argument('--save', type=Path)
    args = parser.parse_args()
    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results, args.phase, args.save, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / f'npc-vision-{args.phase}-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
