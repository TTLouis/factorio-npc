#!/usr/bin/env python3
"""Engine proof for the minimal steam power lane (plan 4.1, fluid track rung C1).

AUTONOMY RUNG: A1 (`docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` section 2).

    Everything below is a TEST-ONLY HARNESS FIXTURE. It proves that the bounded
    operations the model would use can build and run a water -> steam ->
    electricity -> mining chain in real Factorio. It is NOT a blueprint library
    and MUST NEVER be exposed to the model through prompts, observations,
    retrieval, skills or A2/A3 context. The geometry is derived here, from the
    fluid ports the runtime itself reports, exactly as a planner would have to;
    do not import anything from this file into a model-facing path.

Chain: offshore pump on a shoreline -> boiler (coal) -> steam engine -> small
electric poles -> electric mining drill on iron ore -> chest. The NPC actor is
given the items (setup); every entity is then placed through the NPC's own
operations (place_candidate / place_entity) and fuelled through supply_entity.
The lake and the ore patch are scripted terrain (setup only). Nothing is
teleported, inserted or created behind the operations after the setup.

Gates (semantic output, never placement alone):
    WATER_EDGE   getPlacementCandidates(offshore-pump) returns only shoreline
                  spots facing the water; the operation refuses a pump on dry
                  land and a pump facing away from the water
    PUMP         the pump is built from a candidate and reports its output port
    FLUID_ALIGN  a boiler whose water port is not aligned with the pump port
                  builds but does not connect; the aligned boiler connects
                  (pump <-> boiler, boiler <-> engine, read back through the
                  same get_entity_status spatial data the model sees)
    FLUID_FLOW   the boiler holds water, the engine holds steam
    POWER        pump, poles, engine and drill are on one electric network and
                  the engine's output matches the drill's demand
    DRILL        the electric mining drill is `working` in every sample of the
                  measurement window
    ORE          ore in the chest rises at the drill's computed rate

Goal conditions (plan 3.7), read through autorio_tools.evaluate_condition, the
call the harness uses for goal checks:
    GOAL_UNPOWERED  with everything built but the boiler unfuelled,
                     entity_working and electric_network_satisfied for the
                     drill are false and production_rate iron-ore is unmet
    GOAL_RUNNING    once the engine powers the drill, both are true in every
                     sample of the measurement window, with the steam engine
                     named as the network's producer
    GOAL_RATE       production_rate iron-ore over the last minute equals the
                     ore the chest gained over that minute and the drill's
                     computed rate; a boiler refuel INSIDE that window (a fuel
                     insert, timed and checked to lie within the void span)
                     did not void it
    GOAL_HAND_MINED the engine counts ore the NPC mines by hand as force
                     production (sentinel); while it mines, and for the window
                     after, the rate is void for the mined item (iron-ore), and
                     once the window has passed the rate is the drill's alone
                     again
    GOAL_HAND_FED   one non-fuel item put into the chest by the NPC voids the rate
    GOAL_HAND_FED_MACHINE
                     a furnace hand-fed a stack of ore keeps smelting long after
                     1.1x a one-minute window: the engine's iron-plate rate shows
                     the hand-fed output (would-be false positive) yet the rate
                     is void while the furnace still holds the hand-fed ore, and
                     for one window after it is used up

Orientation rules found on Factorio 2.0.77 (entity `direction` in the receipt
is the game's 0 north, 4 east, 8 south, 12 west):
    * A fluid port reported by get_placement_candidates / get_entity_status has
      `position` = the entity's OWN edge tile that carries the connection and
      `direction` = the side it faces; the tile it connects to is
      `position + unit(direction)`. Two entities connect when each port's
      target tile is the other port's own tile (and the fluid boxes are
      compatible). There is no separate "pipe position" outside the entity.
    * Offshore pump (1x1): `direction` is the side the WATER is on; the output
      port faces the opposite side. Water west -> direction 12 -> output faces
      east. The manual build check accepts it only on a land tile whose
      `direction` side is water.
    * Boiler (3x2 facing north): `direction` is the side the STEAM leaves. The
      two water ports sit at the two ends of the long axis, on the row away
      from the steam side, facing along the axis (north: on the south row,
      facing west and east). Steam port: the middle tile of the steam row.
    * Steam engine (3x5): the two steam ports are the two ends of the long axis
      (north/south: facing north and south from the end tiles); direction N and
      S are the same footprint, E and W the same footprint rotated.
    * Chain: pump water-west (dir 12) -> boiler dir 0 with its west water port
      on the tile east of the pump -> engine dir 0 (or 8) with its south steam
      port on the tile north of the boiler's steam port.
    * `covers_position` on the connection tile returns footprints that merely
      contain the tile; most are NOT aligned. Pick by `fluid_ports`, and with
      `limit` 8 an aligned engine is not always in the returned set, in which
      case the exact position is solved from a candidate's port offset.
"""

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle

NORTH, EAST, SOUTH, WEST = 0, 4, 8, 12
DIRECTION_VECTORS = {NORTH: (0, -1), EAST: (1, 0), SOUTH: (0, 1), WEST: (-1, 0)}

COAL = 10
ORE_AMOUNT = 2000
WARMUP_ROUND_TICKS = 120
WARMUP_ROUNDS = 25
SAMPLE_TICKS = 100
SAMPLES = 15
# Electric mining drill on iron ore: speed 0.5, mining time 1 s, no bonus.
DRILL_WATTS_FALLBACK = 90000
POWER_TOLERANCE = 0.05
# Goal conditions (plan 3.7).
WORKING = "{kind='entity_working',entity_name='electric-mining-drill',minimum=1}"
POWERED = "{kind='electric_network_satisfied',entity_name='electric-mining-drill',minimum=1}"
RATE_PER_MINUTE = 25
RATE = f"{{kind='production_rate',item_name='iron-ore',per_minute={RATE_PER_MINUTE}}}"
RATE_WINDOW_TICKS = 3600
# The void span is the window plus 10 % (goal_world_conditions.ts), plus slack.
RATE_VOID_TICKS = 3960 + 120
# Items per minute: the engine's flow buckets do not end exactly on the tick
# the chest was read, and one ore can be between the drill and the chest.
RATE_TOLERANCE = 2.0
HAND_MINE = 2
WAIT_CHUNK_TICKS = 600
# GOAL_HAND_FED_MACHINE: a stone furnace smelts iron ore at 3.2 s per plate, so
# this stack keeps it busy for 7680 ticks, well past the 3960-tick void span.
FED_ORE = 40
FED_COAL = 3
FED_WAIT_TICKS = RATE_VOID_TICKS + 300
PLATE_RATE = "{kind='production_rate',item_name='iron-plate',per_minute=5}"

ITEMS = [
    ('offshore-pump', 1),
    ('boiler', 2),
    ('steam-engine', 1),
    ('small-electric-pole', 3),
    ('electric-mining-drill', 1),
    ('wooden-chest', 1),
    ('coal', COAL + 4),
]


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def opposite(direction: int) -> int:
    return (direction + 8) % 16


def tile_key(point: dict) -> tuple[float, float]:
    return (round(float(point['x']), 3), round(float(point['y']), 3))


def target_tile(port: dict) -> tuple[float, float]:
    """The tile a fluid port connects to: its own edge tile stepped along its facing."""
    dx, dy = DIRECTION_VECTORS[int(port['direction'])]
    x, y = tile_key(port['position'])
    return (x + dx, y + dy)


def ports_aligned(first: dict, second: dict) -> bool:
    """Each port's target tile is the other port's own tile, and they face each other."""
    return (
        int(first['direction']) == opposite(int(second['direction']))
        and target_tile(first) == tile_key(second['position'])
        and target_tile(second) == tile_key(first['position'])
    )


def ports_of(candidate: dict, filter_name: str | None = None) -> list[dict]:
    return [
        port for port in candidate.get('fluid_ports') or []
        if filter_name is None or port.get('filter') == filter_name
    ]


def aligned_candidates(candidates: list[dict], other_port: dict, filter_name: str) -> list[dict]:
    """Candidates with a `filter_name` port aligned with `other_port`."""
    result = []
    for candidate in candidates:
        for port in ports_of(candidate, filter_name):
            if ports_aligned(other_port, port):
                result.append({'candidate': candidate, 'port': port})
                break
    return result


def solve_aligned_placement(candidates: list[dict], other_port: dict, filter_name: str) -> dict | None:
    """Exact centre and direction that put a candidate's `filter_name` port in line with `other_port`.

    A candidate's port offset from its centre depends only on its direction, so
    any candidate of the wanted direction gives the offset. The port must sit on
    the tile `other_port` points at and face back at it.
    """
    wanted_tile = target_tile(other_port)
    for candidate in candidates:
        for port in ports_of(candidate, filter_name):
            if int(port['direction']) != opposite(int(other_port['direction'])):
                continue
            offset = (
                round(float(port['position']['x']) - float(candidate['position']['x']), 3),
                round(float(port['position']['y']) - float(candidate['position']['y']), 3),
            )
            position = {'x': wanted_tile[0] - offset[0], 'y': wanted_tile[1] - offset[1]}
            solved_port = {
                'position': {'x': wanted_tile[0], 'y': wanted_tile[1]},
                'direction': port['direction'],
            }
            if ports_aligned(other_port, solved_port):
                return {'position': position, 'direction': candidate['direction'], 'port': solved_port}
    return None


def connection_targets(status: dict) -> list[list[dict]]:
    """Per fluid storage of a get_entity_status answer: the entities its connections reach."""
    entity = status.get('entity') or {}
    storages = ((entity.get('spatial') or {}).get('fluid') or {}).get('storages') or []
    result = []
    for storage in storages:
        result.append([
            {'name': (connection.get('target') or {}).get('name'), 'unit_number': (connection.get('target') or {}).get('unit_number')}
            for connection in storage.get('connections') or []
            if connection.get('target') is not None
        ])
    return result


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'rung': 'A1', 'scenario': 'steam-power'}

    def flush() -> None:
        evidence['transcript'] = transcript[-250:]
        (results / 'steam-power-cell.json').write_text(json.dumps(evidence, indent=2))

    def command(text: str, record: bool = True) -> str:
        response = client.command(text)
        if record:
            transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
            flush()
        return response

    def json_command(text: str, context: str, record: bool = True) -> Any:
        return decode_json(command(text, record), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context, record=False)

    def admission(expression: str, context: str) -> dict:
        return json_command(
            '/silent-command local result=' + expression + '; '
            'local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            'else accepted=result==true end; '
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))',
            f'{context} admission',
        )

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        result = admission(expression, context)
        require(result.get('accepted') is True, {'context': context, 'admission': result})
        status = wait_until_idle(operation_status, context, timeout)
        receipt = (status.get('basic_operation') or {}).get('last_result') or {}
        require(receipt.get('completed') is True and receipt.get('code') == 'completed', {'context': context, 'receipt': receipt})
        return receipt

    def run_failed_operation(expression: str, context: str, expected_code: str, timeout: float = 30.0) -> dict:
        result = admission(expression, context)
        require(result.get('accepted') is True, {'context': context, 'admission': result})
        status = wait_until_idle(operation_status, context, timeout)
        receipt = (status.get('basic_operation') or {}).get('last_result') or {}
        require(receipt.get('completed') is not True and receipt.get('code') == expected_code, {
            'context': context, 'expected_code': expected_code, 'receipt': receipt,
        })
        return receipt

    def candidates(request: str, context: str, allow_empty: bool = False) -> dict:
        result = json_command(lua_json(remote_call('autorio_tools', 'get_placement_candidates', request)), context)
        require(result.get('ok') is True, {'context': context, 'result': result})
        if not allow_empty:
            require(len(result.get('candidates') or []) > 0, {'context': context, 'message': 'no candidates', 'result': result})
        return result

    def entity_status(name: str, context: str) -> dict:
        status = json_command(lua_json(remote_call('autorio_tools', 'get_entity_status', repr(name), '14')), context)
        require(status.get('found') is True, {'context': context, 'status': status})
        return status

    find_actor = (
        "local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
    )

    def evaluate(request: str, context: str) -> dict:
        """One goal condition, through the exact remote call the harness makes."""
        result = json_command(lua_json(remote_call('autorio_tools', 'evaluate_condition', request)), context)
        require(result.get('ok') is True, {'context': context, 'result': result})
        return result

    def game_tick() -> int:
        return json_command('/silent-command rcon.print(helpers.table_to_json({tick=game.tick}))', 'game tick', record=False)['tick']

    def wait_ticks(ticks: int, context: str) -> None:
        remaining = ticks
        while remaining > 0:
            chunk = min(WAIT_CHUNK_TICKS, remaining)
            run_operation(remote_call('autorio_operations', 'wait', str(chunk)), context, 40.0)
            remaining -= chunk

    # ---- fixture (setup only): lake, land, ore patch, the actor's items ----
    # Layout (tile offsets from the actor's tile): water for x <= -7, land
    # east of it, iron ore at x 6..12. The actor stands mid-way so every
    # placement is inside its build reach.
    inserts = ' '.join(f"inv.insert{{name='{name}',count={count}}};" for name, count in ITEMS)
    fixture = json_command(
        '/silent-command ' + find_actor +
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-24,oy-14},{ox+18,oy+14}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-24,ox+18 do for y=oy-14,oy+14 do '
        "tiles[#tiles+1]={name=(x<=ox-7) and 'water' or 'landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        'for x=ox+6,ox+12 do for y=oy-6,oy+2 do '
        f"s.create_entity{{name='iron-ore',position={{x+0.5,y+0.5}},amount={ORE_AMOUNT}}} end end; "
        # One ore tile inside the actor's reach and outside the drill's area,
        # for the NPC's own hand mining (GOAL_HAND_MINED).
        "s.create_entity{name='iron-ore',position={ox+2.5,oy+2.5},amount=50}; "
        'local inv=a.get_main_inventory(); inv.clear(); ' + inserts + ' '
        'a.teleport({ox+2.5,oy+0.5}); '
        'local previous_speed=game.speed; game.speed=4; '
        'local natural=s.count_tiles_filtered{name={"water","deepwater"},position={ox,oy},radius=16}; '
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,force=a.force.name,previous_speed=previous_speed,'
        'position=a.position,water_tiles_within_16=natural}))',
        'steam power fixture',
    )
    ox, oy = fixture.get('ox'), fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    force_name = fixture['force']
    evidence['fixture'] = fixture
    flush()

    def probe_command(specs: list[dict]) -> str:
        rendered = ','.join(
            "{{k='{key}',n='{name}',x={x},y={y}}}".format(**spec) for spec in specs
        )
        return (
            '/silent-command local s=game.surfaces[1]; '
            'local function status_name(e) for n,v in pairs(defines.entity_status) do if v==e.status then return n end end end; '
            'local function try(f) local ok,v=pcall(f) if ok then return v end return nil end; '
            'local function fluid(e,i) local f=e.fluidbox[i]; if f then return {name=f.name,amount=f.amount} end return nil end; '
            'local specs={' + rendered + '}; local out={}; '
            'for _,sp in ipairs(specs) do '
            'local e=s.find_entities_filtered{name=sp.n,position={sp.x,sp.y},radius=0.6}[1]; '
            'if e then local d={name=e.name,x=e.position.x,y=e.position.y,direction=e.direction,unit=e.unit_number,status=status_name(e)}; '
            'd.network=try(function() return e.electric_network_id end); '
            "if e.type=='offshore-pump' then d.water=fluid(e,1) end; "
            "if e.type=='boiler' then d.water=fluid(e,1); d.steam=fluid(e,2); "
            "d.coal=e.get_fuel_inventory().get_item_count('coal'); d.burning=try(function() return e.burner.remaining_burning_fuel end) end; "
            "if e.type=='generator' then d.steam=fluid(e,1); d.generated_per_tick=try(function() return e.energy_generated_last_tick end) end; "
            "if e.type=='mining-drill' then d.energy=e.energy; d.mining_progress=try(function() return e.mining_progress end); "
            'd.drop_target=e.drop_target and e.drop_target.unit_number or nil end; '
            "if e.type=='container' then d.ore=e.get_item_count('iron-ore') end; "
            'out[sp.k]=d end end; '
            f"local st=game.forces['{force_name}'].get_item_production_statistics(s); "
            "rcon.print(helpers.table_to_json({tick=game.tick,speed=game.speed,entities=out,ore_mined=st.get_input_count('iron-ore')}))"
        )

    def stance_ok(entity: dict) -> None:
        # Every target stays inside the actor's build reach (9.75 tiles).
        distance = math.hypot(entity['x'] - (ox + 2.5), entity['y'] - (oy + 0.5))
        require(distance < 9.5, {'message': 'layout falls outside the actor build reach', 'entity': entity, 'distance': distance})

    try:
        # ---- WATER_EDGE -------------------------------------------------
        shore_center = (ox - 5.5, oy + 2.5)
        pump_set = candidates(
            f"{{entity_name='offshore-pump',center={{x={shore_center[0]},y={shore_center[1]}}},radius=4,limit=8}}",
            'offshore pump candidates',
        )
        evidence['pump_candidates'] = pump_set
        flush()
        # radius 4 around the shore column: nine tiles, one legal facing each.
        require(pump_set['legal_candidate_count'] == 9, {
            'message': 'the pump query reports something other than the nine shoreline tiles as legal',
            'legal': pump_set['legal_candidate_count'], 'scanned': pump_set['scanned'],
        })
        for candidate in pump_set['candidates']:
            require(
                candidate['position']['x'] == ox - 5.5 and candidate['direction'] == WEST,
                {'message': 'a pump candidate is not on the shoreline facing the water', 'candidate': candidate},
            )
        dry = run_failed_operation(
            remote_call('autorio_operations', 'place_entity', repr('offshore-pump'), str(ox - 2.5), str(oy + 0.5), str(NORTH)),
            'pump on dry land refusal',
            'not_placeable',
        )
        facing_away = run_failed_operation(
            remote_call('autorio_operations', 'place_entity', repr('offshore-pump'), str(ox - 5.5), str(oy + 0.5), str(NORTH)),
            'pump facing away from the water refusal',
            'not_placeable',
        )
        evidence['pump_refusals'] = {'dry_land': dry, 'facing_away': facing_away}
        flush()
        print(f"PASS: WATER_EDGE - the pump query returns {pump_set['legal_candidate_count']} shoreline placements "
              f"(all on the water edge, direction west); dry land and a pump facing away from the water are refused as not_placeable", flush=True)

        # ---- PUMP -------------------------------------------------------
        pump_candidate = min(
            pump_set['candidates'],
            key=lambda c: (abs(c['position']['y'] - shore_center[1]), c['position']['y']),
        )
        pump_receipt = run_operation(
            remote_call('autorio_operations', 'place_candidate', repr(pump_set['candidate_set_id']), repr(pump_candidate['id'])),
            'place pump',
            30.0,
        )
        pump_unit = pump_receipt.get('placed_unit_number')
        require(isinstance(pump_unit, int), pump_receipt)
        require(pump_receipt.get('placed_direction') == WEST, {'message': 'pump was not placed facing the water', 'receipt': pump_receipt})
        pump_status = entity_status('offshore-pump', 'pump status')
        pump_ports = ((pump_status['entity'].get('spatial') or {}).get('fluid') or {}).get('storages') or []
        require(pump_ports and pump_ports[0].get('connections'), {'message': 'the placed pump reports no output port', 'status': pump_status})
        # The candidate's port and the placed pump's connection describe one tile.
        pump_port = ports_of(pump_candidate)[0]
        placed_connection = pump_ports[0]['connections'][0]
        require(
            tile_key(placed_connection['position']) == tile_key(pump_port['position'])
            and tile_key(placed_connection['target_position']) == target_tile(pump_port),
            {'message': 'candidate port and placed connection disagree', 'candidate_port': pump_port, 'connection': placed_connection},
        )
        pump_position = {'x': pump_receipt['placed_position']['x'], 'y': pump_receipt['placed_position']['y']}
        stance_ok({'x': pump_position['x'], 'y': pump_position['y']})
        evidence['pump'] = {'receipt': pump_receipt, 'port': pump_port, 'connection': placed_connection}
        print(f"PASS: PUMP - offshore pump {pump_unit} at ({pump_position['x']}, {pump_position['y']}) facing the water "
              f"(direction {pump_receipt['placed_direction']}); output port on its own tile, facing {pump_port['direction']}, "
              f"connects to tile {target_tile(pump_port)}", flush=True)

        # ---- FLUID_ALIGN: a misaligned boiler does not connect ----------
        boiler_set = candidates(
            f"{{entity_name='boiler',covers_position={{x={target_tile(pump_port)[0]},y={target_tile(pump_port)[1]}}},limit=8}}",
            'boiler candidates',
        )
        evidence['boiler_candidates'] = boiler_set
        aligned_boilers = aligned_candidates(boiler_set['candidates'], pump_port, 'water')
        aligned_ids = {entry['candidate']['id'] for entry in aligned_boilers}
        misaligned = [c for c in boiler_set['candidates'] if c['id'] not in aligned_ids]
        require(len(aligned_boilers) >= 1, {'message': 'no boiler candidate aligns its water port with the pump port', 'pump_port': pump_port, 'set': boiler_set})
        require(len(misaligned) >= 1, {'message': 'expected covering-but-misaligned boiler candidates', 'set': boiler_set})
        wrong = misaligned[0]
        wrong_receipt = run_operation(
            remote_call('autorio_operations', 'place_candidate', repr(boiler_set['candidate_set_id']), repr(wrong['id'])),
            'place misaligned boiler',
            30.0,
        )
        pump_after_wrong = entity_status('offshore-pump', 'pump status with a misaligned boiler')
        wrong_boiler = entity_status('boiler', 'misaligned boiler status')
        wrong_targets = connection_targets(wrong_boiler)
        pump_targets = connection_targets(pump_after_wrong)
        evidence['misaligned_boiler'] = {'candidate': wrong, 'receipt': wrong_receipt, 'boiler_targets': wrong_targets, 'pump_targets': pump_targets}
        flush()
        require(all(not group for group in wrong_targets) and all(not group for group in pump_targets), {
            'message': 'a misaligned boiler must not connect to the pump',
            'boiler_targets': wrong_targets, 'pump_targets': pump_targets, 'candidate': wrong,
        })
        # Test scaffolding only: remove the misaligned boiler (the aligned one follows).
        json_command(
            '/silent-command ' + find_actor +
            f"local b=s.find_entities_filtered{{name='boiler',position={{{wrong['position']['x']},{wrong['position']['y']}}},radius=0.6}}[1]; "
            'assert(b); b.destroy(); rcon.print(helpers.table_to_json({removed=true}))',
            'remove misaligned boiler',
        )

        # ---- FLUID_ALIGN: the aligned boiler -----------------------------
        boiler_set = candidates(
            f"{{entity_name='boiler',covers_position={{x={target_tile(pump_port)[0]},y={target_tile(pump_port)[1]}}},limit=8}}",
            'boiler candidates (fresh)',
        )
        aligned_boilers = aligned_candidates(boiler_set['candidates'], pump_port, 'water')
        require(len(aligned_boilers) >= 1, {'message': 'no aligned boiler candidate in the fresh set', 'set': boiler_set})
        chosen = aligned_boilers[0]
        boiler_candidate, water_port = chosen['candidate'], chosen['port']
        boiler_receipt = run_operation(
            remote_call('autorio_operations', 'place_candidate', repr(boiler_set['candidate_set_id']), repr(boiler_candidate['id'])),
            'place aligned boiler',
            30.0,
        )
        boiler_unit = boiler_receipt.get('placed_unit_number')
        require(isinstance(boiler_unit, int), boiler_receipt)
        boiler_status = entity_status('boiler', 'boiler status')
        pump_status = entity_status('offshore-pump', 'pump status with the aligned boiler')
        boiler_targets = connection_targets(boiler_status)
        require(any(t['name'] == 'offshore-pump' and t['unit_number'] == pump_unit for t in boiler_targets[0]), {
            'message': 'the aligned boiler is not connected to the pump', 'targets': boiler_targets,
        })
        require(any(t['name'] == 'boiler' and t['unit_number'] == boiler_unit for t in connection_targets(pump_status)[0]), {
            'message': 'the pump does not report the boiler', 'targets': connection_targets(pump_status),
        })
        steam_port = ports_of(boiler_candidate, 'steam')[0]
        boiler_position = boiler_receipt['placed_position']
        stance_ok(boiler_position)
        evidence['boiler'] = {
            'receipt': boiler_receipt, 'candidate': boiler_candidate, 'water_port': water_port, 'steam_port': steam_port,
            'aligned_candidates_in_set': len(aligned_boilers), 'candidates_in_set': len(boiler_set['candidates']),
        }
        flush()
        print(f"PASS: FLUID_ALIGN - a boiler covering the pump's target tile but not aligned (direction {wrong['direction']}) "
              f"builds without connecting; the aligned boiler (direction {boiler_receipt['placed_direction']}, water port "
              f"{tile_key(water_port['position'])} facing {water_port['direction']}) connects to the pump, "
              f"{len(aligned_boilers)} of {len(boiler_set['candidates'])} covering candidates align", flush=True)

        # ---- steam engine: the steam port must meet the boiler's steam port
        engine_tile = target_tile(steam_port)
        engine_set = candidates(
            f"{{entity_name='steam-engine',covers_position={{x={engine_tile[0]},y={engine_tile[1]}}},limit=8}}",
            'engine candidates',
        )
        evidence['engine_candidates'] = {'legal': engine_set['legal_candidate_count'], 'returned': engine_set['returned_candidate_count']}
        aligned_engines = aligned_candidates(engine_set['candidates'], steam_port, 'steam')
        if aligned_engines:
            engine_path = 'candidate'
            engine_receipt = run_operation(
                remote_call('autorio_operations', 'place_candidate', repr(engine_set['candidate_set_id']), repr(aligned_engines[0]['candidate']['id'])),
                'place engine from a candidate',
                30.0,
            )
        else:
            engine_path = 'solved'
            solved = solve_aligned_placement(engine_set['candidates'], steam_port, 'steam')
            require(solved is not None, {'message': 'cannot solve an aligned engine placement', 'steam_port': steam_port, 'set': engine_set})
            assert solved is not None
            engine_receipt = run_operation(
                remote_call('autorio_operations', 'place_entity', repr('steam-engine'),
                            str(solved['position']['x']), str(solved['position']['y']), str(solved['direction'])),
                'place engine at the solved position',
                30.0,
            )
        engine_unit = engine_receipt.get('placed_unit_number')
        require(isinstance(engine_unit, int), engine_receipt)
        engine_position = engine_receipt['placed_position']
        stance_ok(engine_position)
        engine_status = entity_status('steam-engine', 'engine status')
        boiler_status = entity_status('boiler', 'boiler status with the engine')
        require(any(t['name'] == 'boiler' and t['unit_number'] == boiler_unit for t in connection_targets(engine_status)[0]), {
            'message': 'the engine is not connected to the boiler', 'targets': connection_targets(engine_status),
        })
        require(any(t['name'] == 'steam-engine' and t['unit_number'] == engine_unit for group in connection_targets(boiler_status) for t in group), {
            'message': 'the boiler does not report the engine', 'targets': connection_targets(boiler_status),
        })
        # The arithmetic a planner would fall back on when no aligned candidate is
        # returned (a port offset from any candidate, applied to the target tile)
        # must land on the position the engine accepted and connected.
        solved = solve_aligned_placement(engine_set['candidates'], steam_port, 'steam')
        require(
            solved is not None
            and tile_key(solved['position']) == tile_key(engine_position)
            and solved['direction'] % 8 == engine_receipt['placed_direction'] % 8,
            {'message': 'the solved engine placement differs from the connected one', 'solved': solved, 'placed': engine_receipt},
        )
        evidence['engine'] = {'receipt': engine_receipt, 'path': engine_path, 'aligned_in_returned_set': len(aligned_engines), 'solved': solved}
        flush()
        print(f"PASS: FLUID_ALIGN - steam engine {engine_unit} (direction {engine_receipt['placed_direction']}, "
              f"placed by {engine_path}; {len(aligned_engines)} of {len(engine_set['candidates'])} returned candidates aligned, "
              f"{engine_set['legal_candidate_count']} legal covering) connects to the boiler's steam port", flush=True)

        # ---- drill on the ore, chest on its output ----------------------
        drill_set = candidates(
            f"{{entity_name='electric-mining-drill',center={{x={ox + 8.5},y={oy - 1.5}}},radius=1,target_resource='iron-ore',limit=3}}",
            'electric drill candidates',
        )
        drill_candidate = drill_set['candidates'][0]
        require(isinstance(drill_candidate.get('item_output_position'), dict), {'message': 'drill candidate has no output tile', 'candidate': drill_candidate})
        drill_receipt = run_operation(
            remote_call('autorio_operations', 'place_candidate', repr(drill_set['candidate_set_id']), repr(drill_candidate['id'])),
            'place drill',
            30.0,
        )
        drill_unit = drill_receipt.get('placed_unit_number')
        drill_position = drill_receipt['placed_position']
        stance_ok(drill_position)
        output = drill_candidate['item_output_position']
        chest_set = candidates(
            f"{{entity_name='wooden-chest',covers_position={{x={output['x']},y={output['y']}}},limit=4}}",
            'chest candidates',
        )
        chest_receipt = run_operation(
            remote_call('autorio_operations', 'place_candidate', repr(chest_set['candidate_set_id']), repr(chest_set['candidates'][0]['id'])),
            'place chest',
            30.0,
        )
        chest_position = chest_receipt['placed_position']

        # ---- poles: one by the engine, one by the drill, one between ----
        # Small pole: supply area 5x5, wire reach 7.5 (prototype values). The
        # engine's east neighbour column and the drill's west side are the two
        # ends; the middle pole keeps every wire under the reach.
        engine_half_width = 1.5 if engine_receipt['placed_direction'] in (NORTH, SOUTH) else 2.5
        pole_a = {'x': engine_position['x'] + engine_half_width + 0.5, 'y': engine_position['y']}
        pole_c = {'x': drill_position['x'] - 3, 'y': drill_position['y']}
        pole_b = {'x': math.floor((pole_a['x'] + pole_c['x']) / 2) + 0.5, 'y': math.floor((pole_a['y'] + pole_c['y']) / 2) + 0.5}
        poles = [pole_a, pole_b, pole_c]
        for first, second in zip(poles, poles[1:]):
            require(math.hypot(first['x'] - second['x'], first['y'] - second['y']) <= 7.5, {'message': 'pole spacing exceeds the wire reach', 'poles': poles})
        pole_units = []
        for index, pole in enumerate(poles):
            stance_ok(pole)
            receipt = run_operation(
                remote_call('autorio_operations', 'place_entity', repr('small-electric-pole'), str(pole['x']), str(pole['y'])),
                f'place pole {index + 1}',
                30.0,
            )
            pole_units.append(receipt.get('placed_unit_number'))
        evidence['layout'] = {
            'pump': pump_position, 'boiler': boiler_position, 'engine': engine_position,
            'drill': drill_position, 'chest': chest_position, 'poles': poles,
        }
        flush()

        # ---- GOAL_UNPOWERED: built, not running --------------------------
        # Every entity of the chain exists; the boiler has no fuel yet. This is
        # the state the live run's items_produced definition already called done.
        unpowered = {
            'working': evaluate(WORKING, 'entity_working before power'),
            'powered': evaluate(POWERED, 'electric_network_satisfied before power'),
            'rate': evaluate(RATE, 'production_rate before power'),
        }
        evidence['goal_unpowered'] = unpowered
        flush()
        require(unpowered['working']['satisfied'] is False and unpowered['working']['current'] == 0 and unpowered['working']['found'] == 1,
                {'message': 'entity_working holds before the drill has power', 'result': unpowered['working']})
        require(unpowered['powered']['satisfied'] is False and unpowered['powered']['current'] == 0 and unpowered['powered']['found'] == 1,
                {'message': 'electric_network_satisfied holds before the engine runs', 'result': unpowered['powered']})
        require(unpowered['rate']['satisfied'] is False, {'message': 'production_rate holds before the drill runs', 'result': unpowered['rate']})
        print(f"PASS: GOAL_UNPOWERED - drill built, boiler unfuelled: entity_working {unpowered['working']['current']}/1 "
              f"(statuses {unpowered['working']['statuses']}), electric_network_satisfied {unpowered['powered']['current']}/1, "
              f"production_rate iron-ore {unpowered['rate']['current']}/min (needs {RATE_PER_MINUTE})", flush=True)

        # ---- fuel through the NPC's own supply operation ----------------
        run_operation(
            remote_call('autorio_operations', 'supply_entity', str(boiler_unit), f"{{{{item_name='coal',count={COAL}}}}}"),
            'fuel the boiler',
            30.0,
        )

        specs = [
            {'key': 'pump', 'name': 'offshore-pump', 'x': pump_position['x'], 'y': pump_position['y']},
            {'key': 'boiler', 'name': 'boiler', 'x': boiler_position['x'], 'y': boiler_position['y']},
            {'key': 'engine', 'name': 'steam-engine', 'x': engine_position['x'], 'y': engine_position['y']},
            {'key': 'drill', 'name': 'electric-mining-drill', 'x': drill_position['x'], 'y': drill_position['y']},
            {'key': 'chest', 'name': 'wooden-chest', 'x': chest_position['x'], 'y': chest_position['y']},
        ] + [
            {'key': f'pole{i + 1}', 'name': 'small-electric-pole', 'x': pole['x'], 'y': pole['y']}
            for i, pole in enumerate(poles)
        ]
        probe = probe_command(specs)

        def sample(context: str, record: bool = False) -> dict:
            observed = json_command(probe, context, record)
            missing = [spec['key'] for spec in specs if spec['key'] not in observed['entities']]
            require(not missing, {'message': 'entities missing from the world', 'missing': missing, 'observed': observed})
            return observed

        # ---- warm up until the drill works ------------------------------
        warm = None
        for attempt in range(WARMUP_ROUNDS):
            run_operation(remote_call('autorio_operations', 'wait', str(WARMUP_ROUND_TICKS)), f'warm-up {attempt + 1}', 40.0)
            warm = sample(f'warm-up sample {attempt + 1}')
            if warm['entities']['drill']['status'] == 'working':
                break
        require(warm is not None and warm['entities']['drill']['status'] == 'working', {
            'message': 'the drill never reached working', 'last': warm,
        })
        evidence['warm'] = warm
        flush()

        # ---- FLUID_FLOW --------------------------------------------------
        entities = warm['entities']
        require((entities['boiler'].get('water') or {}).get('amount', 0) > 0, {'message': 'the boiler holds no water', 'boiler': entities['boiler']})
        require((entities['engine'].get('steam') or {}).get('amount', 0) > 0, {'message': 'the engine holds no steam', 'engine': entities['engine']})
        require((entities['boiler'].get('steam') or {}).get('name') == 'steam' or (entities['engine'].get('steam') or {}).get('name') == 'steam', warm)
        print(f"PASS: FLUID_FLOW - boiler water {entities['boiler']['water']['amount']:.1f}, "
              f"engine {entities['engine']['steam']['name']} {entities['engine']['steam']['amount']:.1f}, "
              f"pump {entities['pump']['status']}, boiler {entities['boiler']['status']}, engine {entities['engine']['status']}", flush=True)

        # ---- POWER: one network, engine output meets demand -------------
        networks = {key: entities[key].get('network') for key in ('engine', 'drill', 'pole1', 'pole2', 'pole3')}
        evidence['networks'] = networks
        require(all(isinstance(value, int) for value in networks.values()) and len(set(networks.values())) == 1, {
            'message': 'engine, poles and drill are not on one electric network', 'networks': networks,
        })
        prototype = json_command(
            "/silent-command local p=prototypes.entity['electric-mining-drill']; local o=prototypes.entity['iron-ore']; "
            "rcon.print(helpers.table_to_json({watts=p.get_max_energy_usage()*60,speed=p.mining_speed,"
            f"ore_time=o.mineable_properties.mining_time,productivity=game.forces['{force_name}'].mining_drill_productivity_bonus}}))",
            'drill prototype rates',
        )
        drill_watts = prototype['watts'] or DRILL_WATTS_FALLBACK
        evidence['drill_prototype'] = prototype

        # ---- DRILL + ORE: a measured window ------------------------------
        window_start = sample('window start')
        samples = [window_start]
        goal_samples = []
        for index in range(SAMPLES):
            run_operation(remote_call('autorio_operations', 'wait', str(SAMPLE_TICKS)), f'window {index + 1}', 40.0)
            samples.append(sample(f'window sample {index + 1}'))
            goal_samples.append({
                'working': evaluate(WORKING, f'entity_working window {index + 1}'),
                'powered': evaluate(POWERED, f'electric_network_satisfied window {index + 1}'),
            })
        window_end = samples[-1]
        evidence['window'] = samples
        flush()

        statuses = [entry['entities']['drill']['status'] for entry in samples]
        require(all(status == 'working' for status in statuses), {'message': 'the drill did not stay working', 'statuses': statuses})
        generated = [entry['entities']['engine'].get('generated_per_tick') for entry in samples[1:]]
        require(all(isinstance(value, (int, float)) for value in generated), {'message': 'engine output not readable', 'generated': generated})
        mean_watts = sum(generated) / len(generated) * 60
        require(abs(mean_watts - drill_watts) <= POWER_TOLERANCE * drill_watts, {
            'message': 'the engine output does not match the drill demand', 'mean_watts': mean_watts, 'drill_watts': drill_watts, 'generated_per_tick': generated,
        })
        seconds = (window_end['tick'] - window_start['tick']) / 60
        for key in ('pump', 'boiler', 'engine'):
            key_statuses = {entry['entities'][key]['status'] for entry in samples}
            require(key_statuses == {'working'}, {'message': f'the {key} did not stay working', 'statuses': sorted(key_statuses)})
        print(f"PASS: POWER - pump, three poles, engine and drill share electric network {networks['engine']}; "
              f"engine output {mean_watts:.0f} W against the drill's {drill_watts:.0f} W over {len(generated)} samples", flush=True)
        print(f"PASS: DRILL - electric mining drill {drill_unit} reported working in all {len(statuses)} samples "
              f"({seconds:.1f} s of game time)", flush=True)

        chest_gain = (window_end['entities']['chest']['ore'] or 0) - (window_start['entities']['chest']['ore'] or 0)
        stats_gain = window_end['ore_mined'] - window_start['ore_mined']
        expected_rate = prototype['speed'] / prototype['ore_time'] * (1 + prototype['productivity'])
        expected = expected_rate * seconds
        evidence['measured'] = {
            'seconds': seconds, 'chest_ore': chest_gain, 'statistics_ore': stats_gain,
            'expected_ore': expected, 'ore_per_minute': chest_gain / seconds * 60, 'expected_per_minute': expected_rate * 60,
        }
        flush()
        require(seconds >= 20, {'message': 'measurement window too short', 'measured': evidence['measured']})
        require(chest_gain > 0, {'message': 'no ore reached the chest', 'measured': evidence['measured']})
        # A periodic process counted between two instants is off by less than one
        # item; the chest adds up to one more item of output latency.
        require(abs(chest_gain - expected) <= 1.5 and abs(stats_gain - expected) <= 1.5, {
            'message': 'measured ore differs from the computed rate', 'measured': evidence['measured'],
        })
        print(f"PASS: ORE - {chest_gain} ore in the chest over {seconds:.1f} s of game time "
              f"({chest_gain / seconds * 60:.1f} per minute; computed {expected_rate * 60:g} per minute, statistics counted {stats_gain})", flush=True)

        # ---- GOAL_RUNNING ------------------------------------------------
        evidence['goal_running'] = goal_samples
        flush()
        for entry in goal_samples:
            require(entry['working']['satisfied'] is True and entry['working']['current'] == 1,
                    {'message': 'entity_working is not true while the drill works', 'result': entry['working']})
            require(entry['powered']['satisfied'] is True and entry['powered']['current'] == 1 and 'steam-engine' in entry['powered']['producers'],
                    {'message': 'electric_network_satisfied is not true while the engine powers the drill', 'result': entry['powered']})
        print(f"PASS: GOAL_RUNNING - entity_working and electric_network_satisfied true in all {len(goal_samples)} window samples "
              f"(producers {goal_samples[-1]['powered']['producers']})", flush=True)

        # ---- GOAL_RATE: the rate over the last minute is the drill's -------
        def chest_and_rate(context: str) -> dict:
            observed = sample(context, record=True)
            observed['rate'] = evaluate(RATE, f'{context} production_rate')
            return observed

        def rate_matches_chest(start: dict, end: dict, context: str) -> dict:
            ticks = end['tick'] - start['tick']
            chest_per_minute = ((end['entities']['chest']['ore'] or 0) - (start['entities']['chest']['ore'] or 0)) * RATE_WINDOW_TICKS / ticks
            rate = end['rate']
            summary = {'ticks': ticks, 'chest_per_minute': chest_per_minute, 'rate': rate, 'computed_per_minute': expected_rate * 60}
            require(ticks >= RATE_WINDOW_TICKS, {'context': context, 'message': 'the measured span is shorter than the window', **summary})
            require(rate['satisfied'] is True and rate.get('void_reason') is None, {'context': context, 'message': 'production_rate is not met while only the drill produces ore', **summary})
            require(abs(rate['current'] - chest_per_minute) <= RATE_TOLERANCE and abs(rate['current'] - expected_rate * 60) <= RATE_TOLERANCE,
                    {'context': context, 'message': 'production_rate differs from the ore the drill delivered', **summary})
            return summary

        # The boiler is refuelled (a fuel insert, allowed) half-way through the
        # measured window, so the read at the end is inside the void span of
        # that insert and must still not be void.
        rate_start = chest_and_rate('rate window start')
        wait_ticks(RATE_WINDOW_TICKS // 2, 'first half of the rate window')
        refuel_start = game_tick()
        run_operation(
            remote_call('autorio_operations', 'supply_entity', str(boiler_unit), "{{item_name='coal',count=2}}"),
            'refuel the boiler inside the rate window',
            30.0,
        )
        refuel_end = game_tick()
        wait_ticks(RATE_WINDOW_TICKS // 2, 'second half of the rate window')
        rate_end = chest_and_rate('rate window end')
        evidence['goal_rate'] = rate_matches_chest(rate_start, rate_end, 'GOAL_RATE')
        evidence['goal_rate']['refuel'] = {'start_tick': refuel_start, 'end_tick': refuel_end, 'read_tick': rate_end['tick'],
                                           'ticks_before_read': rate_end['tick'] - refuel_end}
        flush()
        require(0 < rate_end['tick'] - refuel_end < 3960 and refuel_start > rate_start['tick'],
                {'message': 'the boiler refuel is not inside the rate window', **evidence['goal_rate']})
        print(f"PASS: GOAL_RATE - production_rate iron-ore {rate_end['rate']['current']}/min over the last minute "
              f"(flow count {rate_end['rate']['produced']}); the chest gained {evidence['goal_rate']['chest_per_minute']:.1f}/min; "
              f"computed {expected_rate * 60:g}/min; the boiler was refuelled {rate_end['tick'] - refuel_end} ticks before the read "
              f"and the window was not void", flush=True)

        # ---- GOAL_HAND_MINED ---------------------------------------------
        hand_before = chest_and_rate('before hand mining')
        inventory_before = json_command('/silent-command ' + find_actor +
                                        "rcon.print(helpers.table_to_json({ore=a.get_main_inventory().get_item_count('iron-ore')}))", 'inventory before hand mining')['ore']
        result = admission(remote_call('autorio_operations', 'mine_resource_at', repr('iron-ore'), str(ox + 2.5), str(oy + 2.5), str(HAND_MINE)), 'hand mining')
        require(result.get('accepted') is True, {'context': 'hand mining', 'admission': result})
        while_mining = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            probe_mining = json_command(
                '/silent-command ' + find_actor +
                'local mining=a.mining_state.mining; local r=' + remote_call('autorio_tools', 'evaluate_condition', RATE) +
                '; rcon.print(helpers.table_to_json({mining=mining,rate=r}))',
                'rate while hand mining', record=False)
            if probe_mining['mining']:
                while_mining = probe_mining['rate']
                break
            time.sleep(0.02)
        require(while_mining is not None, 'the NPC never started hand mining')
        wait_until_idle(operation_status, 'hand mining', 60)
        hand_after = chest_and_rate('after hand mining')
        inventory_after = json_command('/silent-command ' + find_actor +
                                       "rcon.print(helpers.table_to_json({ore=a.get_main_inventory().get_item_count('iron-ore')}))", 'inventory after hand mining')['ore']
        chest_gain = (hand_after['entities']['chest']['ore'] or 0) - (hand_before['entities']['chest']['ore'] or 0)
        statistics_gain = hand_after['ore_mined'] - hand_before['ore_mined']
        mined = {
            'inventory_gain': inventory_after - inventory_before, 'chest_gain': chest_gain, 'statistics_gain': statistics_gain,
            'rate_while_mining': while_mining, 'rate_after_mining': hand_after['rate'],
        }
        evidence['goal_hand_mined'] = mined
        flush()
        require(mined['inventory_gain'] == HAND_MINE, {'message': 'the NPC did not mine the ore by hand', **mined})
        # Sentinel: the engine records hand-mined ore as force production. If a
        # future engine stops doing so, the void rule is still safe but this
        # measurement no longer explains why it exists.
        require(statistics_gain - chest_gain == HAND_MINE, {'message': 'the engine no longer counts hand-mined ore as production', **mined})
        for key in ('rate_while_mining', 'rate_after_mining'):
            require(mined[key]['satisfied'] is False and mined[key].get('void_reason') == 'hand_mined',
                    {'message': f'{key}: hand-mined ore was not excluded from production_rate', **mined})
            # The target is resolved from the mining position, so the recorded
            # item is the ore itself, not the catch-all that voids everything.
            require(mined[key].get('void_item') == 'iron-ore',
                    {'message': f'{key}: the hand-mining void did not name iron-ore', **mined})
        # A fresh window that starts after the void span: the rate is the
        # drill's alone again, measured against the chest over that window.
        wait_ticks(RATE_VOID_TICKS - RATE_WINDOW_TICKS, 'void span after hand mining')
        clean_start = chest_and_rate('clean window start')
        wait_ticks(RATE_WINDOW_TICKS, 'clean window')
        clean_end = chest_and_rate('clean window end')
        clean = rate_matches_chest(clean_start, clean_end, 'GOAL_HAND_MINED clean window')
        evidence['goal_hand_mined']['clean'] = clean
        flush()
        print(f"PASS: GOAL_HAND_MINED - the NPC mined {HAND_MINE} ore by hand; the statistics counted {statistics_gain} "
              f"(chest {chest_gain} + hand {statistics_gain - chest_gain}); production_rate void (hand_mined) while mining "
              f"and after, then {clean_end['rate']['current']}/min once the window passed", flush=True)

        # ---- GOAL_HAND_FED -----------------------------------------------
        chest_unit = chest_receipt.get('placed_unit_number')
        require(isinstance(chest_unit, int), chest_receipt)
        run_operation(
            remote_call('autorio_operations', 'supply_entity', str(chest_unit), "{{item_name='coal',count=1}}"),
            'hand-feed the chest', 30.0,
        )
        fed = evaluate(RATE, 'production_rate after hand feeding')
        evidence['goal_hand_fed'] = fed
        flush()
        require(fed['satisfied'] is False and fed.get('void_reason') == 'hand_inserted' and fed.get('void_item') == 'coal',
                {'message': 'a non-fuel hand insert did not void the rate window', 'result': fed})
        print(f"PASS: GOAL_HAND_FED - one coal put into the chest by hand voids production_rate ({fed['current']}/min measured, "
              f"void {fed['void_reason']} into {fed.get('void_entity')})", flush=True)

        # ---- GOAL_HAND_FED_MACHINE ----------------------------------------
        # The chest insert above voids for one window; let that pass, then hand
        # feed a furnace a stack of ore and read the plate rate past 1.1x the
        # window while the furnace is still smelting it.
        wait_ticks(RATE_VOID_TICKS, 'void span after the chest insert')
        quiet = evaluate(PLATE_RATE, 'iron-plate rate before the furnace')
        require(quiet.get('void_reason') is None, {'message': 'the iron-plate window was still void before the furnace was fed', 'result': quiet})
        json_command(
            '/silent-command ' + find_actor +
            "local inv=a.get_main_inventory(); inv.insert{name='stone-furnace',count=1}; "
            f"inv.insert{{name='coal',count={FED_COAL}}}; inv.insert{{name='iron-ore',count={FED_ORE}}}; "
            'rcon.print(helpers.table_to_json({ok=true}))',
            'furnace items (setup)',
        )
        furnace_receipt = run_operation(remote_call('autorio_operations', 'place_entity', repr('stone-furnace')), 'place the furnace', 30.0)
        furnace_unit = furnace_receipt.get('placed_unit_number')
        require(isinstance(furnace_unit, int), furnace_receipt)
        run_operation(remote_call('autorio_operations', 'supply_entity', str(furnace_unit), f"{{{{item_name='coal',count={FED_COAL}}}}}"), 'fuel the furnace', 30.0)
        fueled = evaluate(PLATE_RATE, 'iron-plate rate after fuelling the furnace')
        require(fueled.get('void_reason') is None, {'message': 'fuelling the furnace voided the rate window', 'result': fueled})
        run_operation(remote_call('autorio_operations', 'supply_entity', str(furnace_unit), f"{{{{item_name='iron-ore',count={FED_ORE}}}}}"), 'hand-feed the furnace', 30.0)
        fed_tick = game_tick()

        def furnace_state(context: str) -> dict:
            return json_command(
                "/silent-command local f=game.get_entity_by_unit_number(" + str(furnace_unit) + "); "
                "rcon.print(helpers.table_to_json({tick=game.tick,ore=f.get_inventory(defines.inventory.furnace_source).get_item_count('iron-ore'),"
                "plates=f.get_inventory(defines.inventory.furnace_result).get_item_count('iron-plate')}))",
                context, record=False)

        wait_ticks(FED_WAIT_TICKS, 'furnace smelts the hand-fed ore')
        smelting = furnace_state('furnace after 1.1x the window')
        machine_rate = evaluate(PLATE_RATE, 'iron-plate rate while the hand-fed furnace still smelts')
        evidence['goal_hand_fed_machine'] = {'fed_tick': fed_tick, 'furnace': smelting, 'rate': machine_rate}
        flush()
        require(smelting['tick'] - fed_tick > 3960 and smelting['ore'] > 0 and smelting['plates'] > 0,
                {'message': 'the furnace is not still smelting past 1.1x the window', **evidence['goal_hand_fed_machine']})
        # Load-bearing: the engine's own flow shows the hand-fed output, so
        # without the machine rule this window would read as automated output.
        require(machine_rate['current'] >= 5, {'message': 'the statistics do not show the furnace output', **evidence['goal_hand_fed_machine']})
        require(machine_rate['satisfied'] is False and machine_rate.get('void_reason') == 'hand_inserted' and machine_rate.get('void_entity') == 'stone-furnace'
                and machine_rate.get('void_item') == 'iron-ore' and machine_rate['void_tick'] <= fed_tick + 60,
                {'message': 'a machine still smelting hand-fed ore did not void the rate window', **evidence['goal_hand_fed_machine']})
        print(f"PASS: GOAL_HAND_FED_MACHINE - {smelting['tick'] - fed_tick} ticks after the hand feed (window x1.1 = 3960) the furnace still holds "
              f"{smelting['ore']} ore and the iron-plate rate reads {machine_rate['current']}/min, yet it is void ({machine_rate['void_reason']}, {machine_rate['void_entity']})", flush=True)

        # Once the hand-fed ore is used up the void holds for one more window
        # (the last plates are still in it), then clears.
        drained = None
        deadline_tick = fed_tick + FED_ORE * 200 + 1200
        while game_tick() < deadline_tick:
            state = furnace_state('furnace input')
            if state['ore'] == 0:
                drained = state
                break
            wait_ticks(WAIT_CHUNK_TICKS // 2, 'furnace drains')
        require(drained is not None, {'message': 'the furnace never used up the hand-fed ore', 'fed_tick': fed_tick})
        after_drain = evaluate(PLATE_RATE, 'iron-plate rate just after the furnace emptied')
        require(after_drain['satisfied'] is False and after_drain.get('void_reason') == 'hand_inserted',
                {'message': 'the window that still holds the hand-fed output was not void', 'result': after_drain})
        wait_ticks(RATE_VOID_TICKS, 'window after the furnace emptied')
        cleared = evaluate(PLATE_RATE, 'iron-plate rate after the void span')
        require(cleared.get('void_reason') is None, {'message': 'the void did not clear once the furnace was empty and the window passed', 'result': cleared})
        evidence['goal_hand_fed_machine'].update({'drained': drained, 'after_drain': after_drain, 'cleared': cleared})
        flush()
        print(f"PASS: GOAL_HAND_FED_MACHINE - void held until the ore was used up ({after_drain['void_reason']}), then one window later cleared "
              f"(iron-plate rate {cleared['current']}/min, void_reason {cleared.get('void_reason')})", flush=True)

        evidence['final'] = {
            'boiler_coal': window_end['entities']['boiler']['coal'],
            'boiler_burning': window_end['entities']['boiler'].get('burning'),
        }
    finally:
        # Restore the world even when a gate fails: entities, ore, lake and speed.
        json_command(
            '/silent-command ' + find_actor +
            f"game.speed={fixture.get('previous_speed') or 1}; "
            f"local ox={ox}; local oy={oy}; "
            'a.get_main_inventory().clear(); '
            'for _,e in pairs(s.find_entities_filtered{area={{ox-24,oy-14},{ox+18,oy+14}}}) do '
            "if e~=a and e.type~='character' then e.destroy() end end; "
            'local tiles={}; for x=ox-24,ox-7 do for y=oy-14,oy+14 do '
            "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
            's.set_tiles(tiles,true,false,true); '
            'rcon.print(helpers.table_to_json({cleaned=true}))',
            'steam power cleanup',
        )
    evidence['status'] = 'pass'
    flush()


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
        (args.results / 'steam-power-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
