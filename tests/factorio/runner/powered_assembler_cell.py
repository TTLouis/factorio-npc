#!/usr/bin/env python3
"""A1 harness proof for the powered assembler production cell (roadmap B1).

AUTONOMY RUNG: A1 (`docs/NPC_PRODUCTION_VALIDATION_ROADMAP.md` section 2).

    The exact layout below is a TEST-ONLY HARNESS FIXTURE. It exists solely to
    prove that the runtime can place, power, configure and operate a production
    cell in real Factorio. It is NOT a known-good blueprint library, NOT a
    layout generator, and it MUST NEVER be exposed to the model through prompts,
    observations, retrieval, skills or A2/A3 context (roadmap section 2.1).
    If you are wiring production layouts into a model-facing path, do not import
    anything from this file.

What this proves end to end against real Factorio, via authoritative game state
read over RCON rather than operation receipts alone:

    BUILT       every machine exists at the exact requested position/direction
    CONNECTED   one electric network spans power source, pole, machines
                and the inserter pickup/drop geometry hits the intended tiles
    CONFIGURED  the assembler carries the intended recipe
    OPERATING   the assembler is powered and never reports no_power
    PRODUCING   the output chest gear count rises above its measured baseline
                inside a bounded tick window, the input plates are consumed,
                and the assembler reports finished products

Placement-only success is explicitly NOT accepted as a pass.

KNOWN BLOCKER (runtime, outside this test's ownership): the final step of this
gate exercises autorio_operations.set_machine_recipe, which kills the Factorio
server because packages/autorio/src/recipe_configuration.ts reads the
non-existent LuaRecipe.categories. Until that is fixed this gate is RED by
design, and everything above that step is the evidence it produces.
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


RECIPE = 'iron-gear-wheel'
PLATES_PER_GEAR = 2
TARGET_GEARS = 10
INPUT_PLATES = 40
PRODUCTION_ROUND_TICKS = 600
PRODUCTION_ROUNDS = 12

# Verified empirically against Factorio 2.0.77 headless in this harness: an
# inserter's `direction` points at the tile it PICKS UP from, and it drops on the
# opposite side. A west-facing inserter therefore moves items west -> east.
WEST = 12

# A1 harness fixture layout. Tile offsets from the cleared build origin.
# Test-only coordinates; never a reusable AIRI blueprint (roadmap section 9).
#
#        chest -> inserter -> assembling-machine-1 -> inserter -> chest
#        powered by solar panels through one medium electric pole
#
CELL = [
    {'key': 'input_chest', 'name': 'wooden-chest', 'dx': -4, 'dy': 0, 'direction': None},
    {'key': 'input_inserter', 'name': 'inserter', 'dx': -3, 'dy': 0, 'direction': WEST},
    {'key': 'assembler', 'name': 'assembling-machine-1', 'dx': -1, 'dy': 0, 'direction': None},
    {'key': 'output_inserter', 'name': 'inserter', 'dx': 1, 'dy': 0, 'direction': WEST},
    {'key': 'output_chest', 'name': 'wooden-chest', 'dx': 2, 'dy': 0, 'direction': None},
    {'key': 'pole', 'name': 'medium-electric-pole', 'dx': -1, 'dy': 3, 'direction': None},
    {'key': 'solar_a', 'name': 'solar-panel', 'dx': -3, 'dy': 5, 'direction': None},
    {'key': 'solar_b', 'name': 'solar-panel', 'dx': 0, 'dy': 5, 'direction': None},
    {'key': 'solar_c', 'name': 'solar-panel', 'dx': 3, 'dy': 5, 'direction': None},
]

# The NPC stands north of the cell so no placement target collides with its own
# character and every target stays inside player build reach (build_distance-0.25).
ACTOR_STANCE = (-1, -3)

CONSTRUCTION_ITEMS = [
    ('wooden-chest', 2),
    ('inserter', 2),
    ('assembling-machine-1', 1),
    ('medium-electric-pole', 1),
    ('solar-panel', 3),
    ('iron-plate', INPUT_PLATES),
]

POWERED_KEYS = ['assembler', 'input_inserter', 'output_inserter', 'pole', 'solar_a', 'solar_b', 'solar_c']


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def close_enough(a: float, b: float) -> bool:
    return abs(float(a) - float(b)) < 1e-6


def tile_of(position: dict) -> tuple[int, int]:
    return (int(math.floor(float(position['x']))), int(math.floor(float(position['y']))))


def cell_probe_command(specs: dict[str, dict]) -> str:
    # Authoritative world read. Identity is always confirmed through the exact
    # unit_number; the positional lookup is only a fallback index, because
    # game.get_entity_by_unit_number() does not reliably resolve entities that
    # the NPC created earlier in the same session (see powered-assembler-cell
    # evidence `unit_number_index`).
    rendered = ','.join(
        "{{k='{key}',id={id},n='{name}',x={x},y={y}}}".format(
            key=key, id=spec['unit'], name=spec['name'], x=spec['x'], y=spec['y'])
        for key, spec in specs.items()
    )
    return (
        '/silent-command local s=game.surfaces[1]; local specs={' + rendered + '}; '
        'local out={}; local idx={}; '
        'for _,sp in pairs(specs) do local e=game.get_entity_by_unit_number(sp.id); '
        'local direct=e~=nil and e.valid; idx[sp.k]=direct; '
        'if not direct then e=nil; '
        'for _,c in pairs(s.find_entities_filtered{position={sp.x,sp.y},radius=0.2,name=sp.n}) do '
        'if c.valid and c.unit_number==sp.id then e=c end end end; '
        'local k=sp.k; '
        'if e and e.valid then '
        'local d={name=e.name,type=e.type,x=e.position.x,y=e.position.y,direction=e.direction,unit_number=e.unit_number}; '
        "if e.type=='assembling-machine' or e.type=='inserter' or e.type=='solar-panel' or e.type=='electric-pole' then "
        'd.network=e.electric_network_id; d.status=e.status; '
        'for n,v in pairs(defines.entity_status) do if v==e.status then d.status_name=n end end; end; '
        "if e.type=='assembling-machine' then local rec=e.get_recipe(); d.recipe=rec and rec.name or nil; "
        'd.products_finished=e.products_finished; d.energy=e.energy; d.crafting_progress=e.crafting_progress; '
        "d.plates=e.get_item_count('iron-plate'); d.gears=e.get_item_count('iron-gear-wheel'); end; "
        "if e.type=='inserter' then d.pickup={x=e.pickup_position.x,y=e.pickup_position.y}; "
        'd.drop={x=e.drop_position.x,y=e.drop_position.y}; d.energy=e.energy; '
        'd.held=e.held_stack.valid_for_read and e.held_stack.name or nil; end; '
        "if e.type=='container' then d.plates=e.get_item_count('iron-plate'); "
        "d.gears=e.get_item_count('iron-gear-wheel'); end; "
        'out[k]=d; end; end; '
        'rcon.print(helpers.table_to_json({cell=out,unit_number_index=idx,'
        'tick=game.tick,speed=game.speed}))'
    )


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'rung': 'A1', 'scenario': 'B1'}

    def flush() -> None:
        evidence['transcript'] = transcript
        (results / 'powered-assembler-cell.json').write_text(json.dumps(evidence, indent=2))

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({
            'elapsed_seconds': round(time.monotonic() - started, 3),
            'command': text,
            'response': response,
        })
        flush()
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def operation_admission(expression: str, context: str) -> dict:
        # autorio exposes both scalar-boolean and [boolean, message] admissions.
        return json_command(
            '/silent-command local result=' + expression + '; '
            'local accepted=false; local message=nil; '
            "if type(result)=='table' then accepted=result[1]==true; message=result[2] "
            'else accepted=result==true end; '
            'rcon.print(helpers.table_to_json({accepted=accepted,message=message}))',
            f'{context} admission',
        )

    def run_operation(expression: str, context: str, timeout: float = 30.0) -> dict:
        admission = operation_admission(expression, context)
        require(admission.get('accepted') is True, {'context': context, 'admission': admission})
        status = wait_until_idle(operation_status, context, timeout)
        return (status.get('basic_operation') or {}).get('last_result') or {}

    # ---- fixture ---------------------------------------------------------
    inserts = ' '.join(
        f"inv.insert{{name='{name}',count={count}}};" for name, count in CONSTRUCTION_ITEMS
    )
    counts = ','.join(
        f"{name.replace('-', '_')}=a.get_item_count('{name}')" for name, _ in CONSTRUCTION_ITEMS
    )
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-10,oy-8},{ox+10,oy+10}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-10,ox+10 do for y=oy-8,oy+10 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        'local inv=a.get_main_inventory(); inv.clear(); ' + inserts + ' '
        f'a.teleport({{ox+({ACTOR_STANCE[0]})+0.5,oy+({ACTOR_STANCE[1]})+0.5}}); '
        'game.speed=4; '
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,force=a.force.name,'
        'position=a.position,speed=game.speed,counts={' + counts + '}}))',
        'powered assembler cell fixture',
    )
    ox = fixture.get('ox')
    oy = fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    for name, count in CONSTRUCTION_ITEMS:
        require(fixture['counts'][name.replace('-', '_')] == count, fixture)
    require(close_enough(fixture['position']['x'], ox + ACTOR_STANCE[0] + 0.5), fixture)
    require(close_enough(fixture['position']['y'], oy + ACTOR_STANCE[1] + 0.5), fixture)
    evidence['fixture'] = fixture
    evidence['origin'] = {'x': ox, 'y': oy}
    flush()

    def expected_position(spec: dict) -> dict[str, float]:
        return {'x': ox + spec['dx'] + 0.5, 'y': oy + spec['dy'] + 0.5}

    # ---- BUILT -----------------------------------------------------------
    unit_numbers: dict[str, int] = {}
    placement_receipts: dict[str, dict] = {}
    for spec in CELL:
        target = expected_position(spec)
        direction = spec['direction']
        args = [repr(spec['name']), repr(target['x']), repr(target['y'])]
        if direction is not None:
            args.append(str(direction))
        receipt = run_operation(
            remote_call('autorio_operations', 'place_entity', *args),
            f"place {spec['key']} ({spec['name']})",
            20.0,
        )
        require(receipt.get('completed') is True and receipt.get('code') == 'completed', {
            'message': 'exact placement did not complete',
            'key': spec['key'],
            'expected_position': target,
            'receipt': receipt,
        })
        placed = receipt.get('placed_position') or {}
        require(close_enough(placed.get('x', 1e9), target['x']) and close_enough(placed.get('y', 1e9), target['y']), {
            'message': 'entity was not placed at the exact requested position',
            'key': spec['key'],
            'expected_position': target,
            'receipt': receipt,
        })
        require(receipt.get('placed_direction') == (direction or 0), {
            'message': 'entity was not placed with the exact requested direction',
            'key': spec['key'],
            'expected_direction': direction or 0,
            'receipt': receipt,
        })
        unit = receipt.get('placed_unit_number')
        require(isinstance(unit, int) and unit > 0, receipt)
        unit_numbers[spec['key']] = unit
        placement_receipts[spec['key']] = receipt
        evidence['placement_receipts'] = placement_receipts
        evidence['unit_numbers'] = unit_numbers
        flush()

    probe_specs = {
        spec['key']: {
            'unit': unit_numbers[spec['key']],
            'name': spec['name'],
            'x': expected_position(spec)['x'],
            'y': expected_position(spec)['y'],
        }
        for spec in CELL
    }
    probe_command = cell_probe_command(probe_specs)

    def probe(context: str) -> dict:
        observed = json_command(probe_command, context)
        cell = observed.get('cell') or {}
        require(len(cell) == len(CELL), {'message': 'cell entity missing from world', 'observed': observed})
        return observed

    built = probe('cell built state')
    evidence['built'] = built
    flush()
    for spec in CELL:
        entity = built['cell'][spec['key']]
        target = expected_position(spec)
        require(entity['name'] == spec['name'], {'key': spec['key'], 'entity': entity})
        require(close_enough(entity['x'], target['x']) and close_enough(entity['y'], target['y']), {
            'message': 'authoritative game state disagrees with the requested position',
            'key': spec['key'], 'expected': target, 'entity': entity,
        })
        require(entity.get('direction', 0) == (spec['direction'] or 0), {
            'message': 'authoritative game state disagrees with the requested direction',
            'key': spec['key'], 'entity': entity,
        })
    print(f'PASS: BUILT - {len(CELL)} cell entities exist at the exact requested positions/directions', flush=True)

    # ---- CONNECTED: inserter pickup/drop geometry ------------------------
    geometry = {
        'input_inserter': {
            'pickup': (ox - 4, oy),           # input chest tile
            'drop': (ox - 2, oy),             # assembler west column
        },
        'output_inserter': {
            'pickup': (ox, oy),               # assembler east column
            'drop': (ox + 2, oy),             # output chest tile
        },
    }
    observed_geometry = {}
    for key, expected in geometry.items():
        entity = built['cell'][key]
        pickup_tile = tile_of(entity['pickup'])
        drop_tile = tile_of(entity['drop'])
        observed_geometry[key] = {'pickup_tile': pickup_tile, 'drop_tile': drop_tile, 'entity': entity}
        require(pickup_tile == expected['pickup'], {
            'message': 'inserter pickup geometry does not reach the intended source tile',
            'key': key, 'expected_pickup_tile': expected['pickup'], 'observed': observed_geometry[key],
        })
        require(drop_tile == expected['drop'], {
            'message': 'inserter drop geometry does not reach the intended destination tile',
            'key': key, 'expected_drop_tile': expected['drop'], 'observed': observed_geometry[key],
        })
    evidence['geometry'] = observed_geometry
    flush()
    print('PASS: CONNECTED - both inserters pick up and drop on the intended tiles', flush=True)

    # ---- CONNECTED: one electric network ---------------------------------
    networks = {key: built['cell'][key].get('network') for key in POWERED_KEYS}
    evidence['networks'] = networks
    flush()
    require(all(isinstance(value, int) for value in networks.values()), {
        'message': 'a powered cell entity is not attached to any electric network',
        'networks': networks,
    })
    require(len(set(networks.values())) == 1, {
        'message': 'power source and consumers are on different electric networks',
        'networks': networks,
    })
    print(f'PASS: CONNECTED - power source, pole and consumers share electric network {list(networks.values())[0]}', flush=True)

    # ---- exact-reference diagnostic --------------------------------------
    # Diagnostic only, never asserted: try an exact operation on the unit number
    # that place_entity itself just returned, before any observation call has
    # had a chance to record an entity-reference hint. The receipt captured here
    # tells a future reader whether exact operations can address a freshly built
    # entity directly, or whether they depend on an incidental observation.
    evidence['exact_reference_before_observation'] = run_operation(
        remote_call(
            'autorio_operations',
            'move_items_exact',
            repr('iron-plate'),
            str(unit_numbers['input_chest']),
            '1',
            'true',
        ),
        'exact transfer before observation (diagnostic)',
        20.0,
    )
    flush()

    # Observation step: the NPC looks at what it just built. This uses the
    # production observation API, and is also what populates the runtime's
    # entity-reference hints that exact operations resolve through.
    observation = json_command(
        lua_json(remote_call('autorio_tools', 'get_nearby_entities', '20')),
        'observe the constructed cell',
    )
    observed_units = {
        entity.get('unit_number')
        for entity in (observation.get('entities') or [])
        if isinstance(entity.get('unit_number'), int)
    }
    evidence['observed_units'] = sorted(observed_units)
    flush()
    missing = {key: unit for key, unit in unit_numbers.items() if unit not in observed_units}
    require(not missing, {
        'message': 'observation did not return the entities the NPC just built',
        'missing': missing,
        'observation': observation,
    })

    # ---- CONFIGURED ------------------------------------------------------
    # Read-only grounding evidence: which category fields the live LuaRecipe
    # actually exposes. Keep this next to the recipe step so a failure here is
    # diagnosable as fixture vs runtime without a second Docker cycle.
    recipe_probe = json_command(
        "/silent-command local f=game.forces['" + fixture['force'] + "']; "
        f"local r=f.recipes['{RECIPE}']; local out={{found=r~=nil}}; "
        'if r then out.enabled=r.enabled; '
        'local function probe(key) local ok,value=pcall(function() return r[key] end); '
        "return {ok=ok,type=type(value),text=(type(value)=='string' or type(value)=='number' "
        "or type(value)=='boolean') and tostring(value) or nil} end; "
        "out.category=probe('category'); out.categories=probe('categories'); "
        "out.additional_categories=probe('additional_categories'); "
        "out.machine_categories=prototypes.entity['assembling-machine-1'].crafting_categories; end; "
        'rcon.print(helpers.table_to_json(out))',
        'live recipe category grounding',
    )
    evidence['recipe_probe'] = recipe_probe
    flush()

    # DEFECT WORKAROUND (runtime, not owned by this test): the NPC operation
    # autorio_operations.set_machine_recipe currently kills the Factorio server
    # (packages/autorio/src/recipe_configuration.ts reads LuaRecipe.categories,
    # which does not exist -> "LuaRecipe doesn't contain key categories" inside
    # on_tick). The engine-level configuration below is the SAME LuaEntity call
    # the runtime would make, and is used only so that the rest of the cell
    # (power, insertion, crafting, extraction, semantic verification) can still
    # be proven in this run. The NPC operation path is still exercised, and
    # still asserted, as the final step of this gate. Once the runtime defect is
    # fixed, delete this block and configure the recipe through the operation.
    engine_recipe = json_command(
        '/silent-command local s=game.surfaces[1]; local e=nil; '
        'for _,c in pairs(s.find_entities_filtered{'
        f"position={{{ox - 1 + 0.5},{oy + 0.5}}},radius=0.2,name='assembling-machine-1'}}) do "
        f'if c.unit_number=={unit_numbers["assembler"]} then e=c end end; assert(e); '
        f"e.set_recipe('{RECIPE}'); local r=e.get_recipe(); "
        'rcon.print(helpers.table_to_json({recipe=r and r.name or nil,unit_number=e.unit_number}))',
        'engine-level recipe configuration (defect workaround)',
    )
    require(engine_recipe.get('recipe') == RECIPE, engine_recipe)
    configured = probe('cell configured state')
    evidence['configured'] = configured
    flush()
    require(configured['cell']['assembler'].get('recipe') == RECIPE, {
        'message': 'authoritative game state does not show the intended recipe',
        'assembler': configured['cell']['assembler'],
    })
    print(f'PASS: CONFIGURED - assembler recipe is {RECIPE} in authoritative game state '
          '(engine-level; the NPC operation path is asserted at the end of this gate)', flush=True)

    # ---- OPERATING -------------------------------------------------------
    require(configured['cell']['assembler'].get('status_name') != 'no_power', {
        'message': 'assembler reports no_power after construction',
        'assembler': configured['cell']['assembler'],
        'networks': networks,
    })
    require(float(configured['cell']['assembler'].get('energy') or 0) > 0, {
        'message': 'assembler holds no energy despite being on the power network',
        'assembler': configured['cell']['assembler'],
    })
    print('PASS: OPERATING - assembler is powered and has no structural power blocker', flush=True)

    # ---- input delivery --------------------------------------------------
    supply_receipt = run_operation(
        remote_call(
            'autorio_operations',
            'move_items_exact',
            repr('iron-plate'),
            str(unit_numbers['input_chest']),
            str(INPUT_PLATES),
            'true',
        ),
        'load input chest with iron plates',
        20.0,
    )
    require(supply_receipt.get('completed') is True and supply_receipt.get('code') == 'completed', supply_receipt)
    require((supply_receipt.get('moved_count') or 0) > 0, supply_receipt)

    baseline = probe('cell production baseline')
    evidence['baseline'] = baseline
    flush()
    # The cell is already live at this point, so a plate may already sit in the
    # input inserter's hand or in the assembler. Account for the whole cell
    # rather than the chest alone.
    staged_plates = (
        (baseline['cell']['input_chest'].get('plates') or 0)
        + (baseline['cell']['assembler'].get('plates') or 0)
    )
    require(staged_plates >= INPUT_PLATES - 1, {
        'message': 'the NPC did not deliver the input material into the cell',
        'staged_plates': staged_plates,
        'cell': baseline['cell'],
    })
    baseline_gears = baseline['cell']['output_chest'].get('gears') or 0
    evidence['baseline_gears'] = baseline_gears
    flush()

    # ---- PRODUCING -------------------------------------------------------
    observed = baseline
    rounds_used = 0
    no_power_seen: list[dict] = []
    for attempt in range(PRODUCTION_ROUNDS):
        if (observed['cell']['output_chest'].get('gears') or 0) - baseline_gears >= TARGET_GEARS:
            break
        run_operation(
            remote_call('autorio_operations', 'wait', str(PRODUCTION_ROUND_TICKS)),
            f'observe production round {attempt + 1}',
            40.0,
        )
        observed = probe(f'cell production round {attempt + 1}')
        rounds_used = attempt + 1
        if observed['cell']['assembler'].get('status_name') == 'no_power':
            no_power_seen.append(observed['cell']['assembler'])
        evidence['last_round'] = observed
        evidence['rounds_used'] = rounds_used
        flush()

    require(not no_power_seen, {
        'message': 'assembler lost power during the observation window',
        'samples': no_power_seen,
    })

    produced = observed['cell']['output_chest'].get('gears') or 0
    finished = observed['cell']['assembler'].get('products_finished') or 0
    plates_left = observed['cell']['input_chest'].get('plates')
    require(produced - baseline_gears >= TARGET_GEARS, {
        'message': 'powered assembler cell did not deliver the expected output within the bounded tick window',
        'expected_gear_increase': TARGET_GEARS,
        'baseline_gears': baseline_gears,
        'observed_gears': produced,
        'rounds_used': rounds_used,
        'tick_budget': PRODUCTION_ROUNDS * PRODUCTION_ROUND_TICKS,
        'cell': observed['cell'],
    })
    require(finished >= TARGET_GEARS, {
        'message': 'assembler did not report finishing the observed products',
        'products_finished': finished,
        'observed_gears': produced,
        'cell': observed['cell'],
    })
    require(plates_left <= INPUT_PLATES - PLATES_PER_GEAR * TARGET_GEARS, {
        'message': 'input material was not consumed in proportion to the produced output',
        'plates_left': plates_left,
        'observed_gears': produced,
        'cell': observed['cell'],
    })

    print(
        'PASS: PRODUCING - A1 powered assembler cell produced '
        f'{produced} {RECIPE} into the output chest (assembler products_finished={finished}, '
        f'input plates {INPUT_PLATES}->{plates_left}) within {rounds_used} bounded observation rounds',
        flush=True,
    )

    # ---- CONFIGURED through the NPC operation path -----------------------
    # Deliberately last: this is the only remaining unproven link, and the known
    # runtime defect makes it fatal to the Factorio process, so running it any
    # earlier would destroy the evidence above. Clear the recipe first so this
    # is a real empty -> configured transition, not the runtime's
    # already-has-recipe shortcut.
    command(
        '/silent-command local s=game.surfaces[1]; local e=nil; '
        'for _,c in pairs(s.find_entities_filtered{'
        f"position={{{ox - 1 + 0.5},{oy + 0.5}}},radius=0.2,name='assembling-machine-1'}}) do "
        f'if c.unit_number=={unit_numbers["assembler"]} then e=c end end; assert(e); '
        'e.set_recipe(nil); rcon.print(tostring(e.get_recipe()==nil))'
    )
    try:
        operation_recipe_receipt = run_operation(
            remote_call('autorio_operations', 'set_machine_recipe', str(unit_numbers['assembler']), repr(RECIPE)),
            'set assembler recipe through the NPC operation',
            20.0,
        )
    except (ConnectionError, OSError) as exc:
        evidence['operation_recipe_crash'] = f'{type(exc).__name__}: {exc}'
        flush()
        raise AssertionError({
            'message': (
                'RUNTIME DEFECT: autorio_operations.set_machine_recipe killed the Factorio server. '
                'packages/autorio/src/recipe_configuration.ts supports_recipe_category() reads '
                "LuaRecipe.categories, which does not exist in Factorio 2.0 -> \"LuaRecipe doesn't "
                'contain key categories.\" raised inside autorio::on_tick. Use recipe.category plus '
                'recipe.additional_categories the way knowledge.ts and bootstrap_planning.ts already do. '
                'Everything else in this A1 cell passed; only NPC-driven recipe configuration is unproven.'
            ),
            'live_recipe_fields': recipe_probe,
            'rcon_error': f'{type(exc).__name__}: {exc}',
        }) from exc
    evidence['operation_recipe_receipt'] = operation_recipe_receipt
    flush()
    require(
        operation_recipe_receipt.get('completed') is True
        and operation_recipe_receipt.get('code') == 'completed',
        {
            'message': 'the NPC operation could not configure the assembler recipe',
            'receipt': operation_recipe_receipt,
            'live_recipe_fields': recipe_probe,
        },
    )
    operation_configured = probe('cell state after NPC recipe configuration')
    evidence['operation_configured'] = operation_configured
    flush()
    require(operation_configured['cell']['assembler'].get('recipe') == RECIPE, {
        'message': 'authoritative game state does not show the recipe the NPC operation set',
        'assembler': operation_configured['cell']['assembler'],
    })
    print('PASS: CONFIGURED - the NPC operation path set the assembler recipe from empty', flush=True)

    command('/silent-command game.speed=1; rcon.print("true")')
    evidence.update({
        'status': 'pass',
        'produced_gears': produced,
        'products_finished': finished,
        'plates_left': plates_left,
        'rounds_used': rounds_used,
        'final': observed,
    })
    flush()
    print(
        f'PASS: A1 powered assembler production cell complete - BUILT, CONNECTED, CONFIGURED, '
        f'OPERATING and PRODUCING all verified in authoritative game state (actor_id={actor_id})',
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
        (args.results / 'powered-assembler-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        try:
            if client:
                client.command('/silent-command game.speed=1')
        except Exception:
            pass
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
