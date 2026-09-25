#!/usr/bin/env python3
"""Real-engine proof that planning/observation tools survive TypeScriptToLua.

TypeScriptToLua only emits `#x` for `x.length`, and plain `obj.f(...)` calls
for Factorio methods, when it knows the type. On `any` values it emitted a
literal `.length` field (nil on Lua tables; LuaFluidBox raises on the unknown
key) and Lua method calls that pass the object as the first argument. Mocked
unit tests cannot see either, so this cell calls each affected remote tool in
real Factorio and checks the answer, not just the absence of an error. See
docs/validation/AUTORIO_GENERATED_LUA_ENGINE_DEFECTS_2026-09-25.md.

It covers the paths belt_transport_cell.py does not reach: that cell measures
belt lanes and an inserter instance and analyzes a belt/inserter area; this one
covers the scope depth limit, the prototype capacity query and fluid
connections.

It also proves exact entity references for map operations
(docs/NPC_SPATIAL_PLACEMENT_ARCHITECTURE.md, "Resolution scopes"):
game.get_entity_by_unit_number() does not index ordinary buildings, so a
observed unit number must resolve through the observation hint, and map
deconstruction must honour the force policy. The engine charts nothing with
zero players, so map operations read the NPC's own map knowledge.

Gates:
    MAP_REF     with zero players, a map-observed chest the unit-number index
                misses is inspected, marked and unmarked by unit number
    FORCE       deconstruction rejects an enemy-force chest with wrong_force; a
                neutral crash-site wreck passes the policy and the engine's
                refusal is reported as deconstruction_rejected
    NEARBY      capped nearby observation keeps unit-numbered entities first,
                nearest first, and counts the resource tiles it dropped
    SCOPE       scope_context reaches its depth limit and reports the truncation
    CAPACITY    inserter capacity reads the prototype movement speeds
    FACTORY     factory-area analysis of two joined pipes and a filled chest
                returns the engine fluid connection
"""

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(json.dumps(message, sort_keys=True) if not isinstance(message, str) else message)


def guarded_remote(interface: str, method: str, *args: str) -> str:
    rendered = ', '.join([repr(interface), repr(method), *args])
    return (
        '/silent-command local ok, value = pcall(function() return remote.call(' + rendered + ') end); '
        'rcon.print(helpers.table_to_json({ok=ok, value=ok and value or nil, error=(not ok) and tostring(value) or nil}))'
    )


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    actor_id = json.loads((results / 'runner.json').read_text())['actor_id']
    transcript: list[dict[str, object]] = []
    started = time.monotonic()
    evidence: dict[str, Any] = {'status': 'fail', 'actor_id': actor_id, 'scenario': 'compiled-lua-tools'}

    def flush() -> None:
        evidence['transcript'] = transcript
        (results / 'compiled-lua-tools-cell.json').write_text(json.dumps(evidence, indent=2))

    def json_command(text: str, context: str) -> Any:
        response = client.command(text)
        transcript.append({'elapsed_seconds': round(time.monotonic() - started, 3), 'command': text, 'response': response})
        flush()
        return decode_json(response, context)

    def tool(context: str, interface: str, method: str, *args: str) -> Any:
        wrapped = json_command(guarded_remote(interface, method, *args), context)
        evidence[context] = wrapped
        require(wrapped.get('ok') is True, {'context': context, 'message': 'remote call raised in Lua', 'error': wrapped.get('error')})
        return wrapped.get('value') or {}

    # ---- fixture: landfill beside the NPC, two joined pipes, a filled chest ----
    fixture = json_command(
        "/silent-command local s=game.surfaces[1]; local a=nil; "
        "for _,e in pairs(s.find_entities_filtered{name='character'}) do "
        f"if e.unit_number=={actor_id} then a=e end end; assert(a); "
        "remote.call('autorio_operations','cancel_all_tasks'); "
        'local ox=math.floor(a.position.x); local oy=math.floor(a.position.y); '
        'local area={{ox-10,oy-10},{ox+10,oy+10}}; '
        "for _,e in pairs(s.find_entities_filtered{area=area}) do "
        "if e~=a and e.type~='character' then e.destroy() end end; "
        'local tiles={}; for x=ox-10,ox+10 do for y=oy-10,oy+10 do '
        "tiles[#tiles+1]={name='landfill',position={x,y}} end end; "
        's.set_tiles(tiles,true,false,true); s.always_day=true; '
        "a.force.recipes['iron-gear-wheel'].enabled=true; "
        "local p1=s.create_entity{name='pipe',position={ox+3.5,oy-5.5},force=a.force}; "
        "local p2=s.create_entity{name='pipe',position={ox+4.5,oy-5.5},force=a.force}; "
        "local chest=s.create_entity{name='iron-chest',position={ox+6.5,oy-5.5},force=a.force}; "
        "chest.insert{name='iron-plate',count=7}; "
        # Chests on other forces for the deconstruction force policy.
        "local enemy=s.create_entity{name='wooden-chest',position={ox+6.5,oy+4.5},force='enemy'}; "
        "local wreck=s.create_entity{name='crash-site-chest-1',position={ox+9,oy+5},force='neutral'}; assert(wreck); "
        # Resource tiles next to the NPC to crowd a capped nearby observation.
        "for x=ox-5,ox+4 do assert(s.create_entity{name='iron-ore',position={x+0.5,oy+2.5},amount=100}) end; "
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,pipes={p1.unit_number,p2.unit_number},chest=chest.unit_number,'
        'enemy=enemy.unit_number,wreck=wreck.unit_number,'
        'chest_indexed=game.get_entity_by_unit_number(chest.unit_number)~=nil}))',
        'compiled lua tools fixture',
    )
    ox, oy = fixture.get('ox'), fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    evidence['fixture'] = fixture

    def engine(context: str, lua: str) -> Any:
        return json_command('/silent-command local s=game.surfaces[1]; ' + lua, context)

    def engine_chart() -> Any:
        # Evidence only: with zero connected players the engine charts nothing
        # for the NPC force, which is why map operations read the mod's own
        # map knowledge (docs/NPC_CHARACTER_ARCHITECTURE.md, "Map knowledge").
        state = engine(
            'engine chart state',
            "local a=nil; for _,e in pairs(s.find_entities_filtered{name='character'}) do "
            f"if e.unit_number=={actor_id} then a=e end end; assert(a); local f=a.force; "
            "local c={x=math.floor(a.position.x/32),y=math.floor(a.position.y/32)}; "
            'rcon.print(helpers.table_to_json({players=#game.connected_players,charted=f.is_chunk_charted(s,c),'
            "visible=f.is_chunk_visible(s,c),knowledge=remote.call('autorio_map','context').map_knowledge}))",
        )
        evidence['engine_chart'] = state
        return state

    def marked(unit: int) -> bool:
        state = engine(
            'deconstruction marker',
            f"local found=nil; for _,e in pairs(s.find_entities_filtered{{area={{{{{ox - 10},{oy - 10}}},{{{ox + 10},{oy + 10}}}}}}}) do "
            f"if e.unit_number=={unit} then found=e end end; assert(found); "
            'rcon.print(helpers.table_to_json({marked=found.to_be_deconstructed()}))',
        )
        return state.get('marked') is True

    # ---- MAP_REF: map ops on an ordinary building, zero players ----------
    def map_ref_gate() -> None:
        chest = fixture['chest']
        chart = engine_chart()
        require(((chart.get('knowledge') or {}).get('explored_chunks') or 0) >= 25, {'message': 'NPC map knowledge missing its 5x5 window', 'chart': chart})
        before = tool('map_inspect_unobserved', 'autorio_map', 'inspect_entity', str(chest))
        if fixture.get('chest_indexed') is False:
            # Documents the engine gap the hint resolver closes.
            require(before.get('code') == 'entity_not_found', {'message': 'unobserved chest resolved without a hint', 'result': before})
        observed = tool('map_query', 'autorio_map', 'query_area', '1', str(ox + 6.5), str(oy - 5.5), '3', '16')
        require(observed.get('ok') is True, {'context': 'map_query', 'result': observed})
        require(chest in [e.get('unit_number') for e in observed.get('entities') or []], {'message': 'map query did not return the chest', 'result': observed})
        inspected = tool('map_inspect', 'autorio_map', 'inspect_entity', str(chest))
        require(inspected.get('ok') is True and (inspected.get('entity') or {}).get('unit_number') == chest, {'context': 'map_inspect', 'result': inspected})
        mark = tool('map_mark', 'autorio_map_deconstruction', 'mark', str(chest))
        require(mark.get('code') == 'deconstruction_marked' and marked(chest), {'context': 'map_mark', 'result': mark})
        cancel = tool('map_cancel', 'autorio_map_deconstruction', 'cancel', str(chest))
        require(cancel.get('code') == 'deconstruction_cancelled' and not marked(chest), {'context': 'map_cancel', 'result': cancel})
        print(f"PASS: MAP_REF - with {chart.get('players')} players (engine charted={chart.get('charted')}), map-observed chest {chest} "
              f"(indexed={fixture.get('chest_indexed')}) inspected, marked and unmarked", flush=True)

    # ---- FORCE: deconstruction force policy ------------------------------
    def force_gate() -> None:
        observed = tool('force_query', 'autorio_map', 'query_area', '1', str(ox + 7.5), str(oy + 4.5), '3', '16')
        units = [e.get('unit_number') for e in observed.get('entities') or []]
        require(fixture['enemy'] in units and fixture['wreck'] in units, {'message': 'map query missed the force chests', 'result': observed})
        enemy = tool('force_enemy', 'autorio_map_deconstruction', 'mark', str(fixture['enemy']))
        require(enemy.get('code') == 'wrong_force' and not marked(fixture['enemy']), {'context': 'force_enemy', 'result': enemy})
        # The policy admits neutral entities, but on 2.0.77 the engine refuses
        # order_deconstruction on neutral unit-numbered containers (it accepts
        # neutral trees, which have no unit number). The NPC must report that
        # refusal rather than claim a marker.
        wreck = tool('force_neutral', 'autorio_map_deconstruction', 'mark', str(fixture['wreck']))
        require(wreck.get('code') == 'deconstruction_rejected' and wreck.get('accepted') is False and not marked(fixture['wreck']), {'context': 'force_neutral', 'result': wreck})
        print('PASS: FORCE - enemy chest rejected with wrong_force; neutral wreck passed the policy and the engine refusal was reported', flush=True)

    # ---- NEARBY: capped observation ordering ------------------------------
    def nearby_gate() -> None:
        nearby = tool('nearby', 'autorio_tools', 'get_nearby_entities', '12', 'nil', 'nil', '3')
        entities = nearby.get('entities') or []
        require(len(entities) == 3 and nearby.get('truncated') is True, {'context': 'nearby', 'result': nearby})
        require(all(isinstance(e.get('unit_number'), int) for e in entities), {'message': 'resource tiles displaced unit-numbered entities', 'result': nearby})
        actor = nearby.get('actor_position') or {}
        distances = [(e['position']['x'] - actor['x']) ** 2 + (e['position']['y'] - actor['y']) ** 2 for e in entities]
        require(distances == sorted(distances), {'message': 'nearby entities are not nearest first', 'result': nearby})
        counts = nearby.get('type_counts') or {}
        require(counts.get('resource') == 10, {'message': 'type_counts must count every ore tile', 'type_counts': counts})
        print(f"PASS: NEARBY - kept {[e['name'] for e in entities]}, type_counts {counts}", flush=True)

    # ---- SCOPE: the depth-limit branch read recipe.ingredients.length -----
    def scope_gate() -> None:
        scope = tool(
            'scope',
            'autorio_planning', 'scope_context',
            "{calculation_id='compiled-lua-scope',target={type='item',name='iron-gear-wheel'},max_depth=0}",
        )
        require(scope.get('ok') is True, {'context': 'scope', 'result': scope})
        coverage = scope.get('coverage') or {}
        require('depth limit 0 reached' in (coverage.get('truncation_reasons') or []), {'message': 'depth truncation missing', 'coverage': coverage})
        require(coverage.get('complete') is False, {'message': 'scope claimed complete coverage at the depth limit', 'coverage': coverage})
        print(f"PASS: SCOPE - depth-limited scope reports {coverage['truncation_reasons']}", flush=True)

    # ---- CAPACITY: prototype speed getters were called with the prototype as quality
    def capacity_gate() -> None:
        capacity = tool('capacity', 'autorio_planning', 'capacity', "{kind='inserter',prototype_name='inserter'}")
        require(capacity.get('ok') is True, {'context': 'capacity', 'result': capacity})
        movement = capacity.get('movement') or {}
        for key in ('rotation_speed', 'extension_speed'):
            require(isinstance(movement.get(key), (int, float)) and movement[key] > 0, {'message': f'inserter {key} missing', 'movement': movement})
        print(f"PASS: CAPACITY - inserter rotation {movement['rotation_speed']}, extension {movement['extension_speed']}", flush=True)

    # ---- FACTORY: fluidbox length/get_pipe_connections and inventory reads -
    def factory_gate() -> None:
        factory = tool(
            'factory',
            'autorio_skills', 'analyze_area',
            f"{{area={{left_top={{x={ox + 2},y={oy - 7}}},right_bottom={{x={ox + 8},y={oy - 4}}}}}}}",
        )
        require(factory.get('ok') is True, {'context': 'factory', 'result': factory})
        require(factory.get('entity_count') == 3, {'message': 'expected the two pipes and the chest', 'result': factory})
        # Only the joined pipes can relate here, so every relation is a fluid connection.
        require((factory.get('relation_count') or 0) >= 1, {'message': 'engine fluid connection between the pipes was not observed', 'result': factory})
        print(f"PASS: FACTORY - analyzed {factory['entity_count']} entities with {factory['relation_count']} fluid relation(s)", flush=True)

    # Each gate is independent after the fixture; run them all so one crash
    # does not hide the others, then fail listing every failed gate.
    failures: dict[str, str] = {}
    for gate in (map_ref_gate, force_gate, nearby_gate, scope_gate, capacity_gate, factory_gate):
        try:
            gate()
        except Exception as exc:  # noqa: BLE001 - report every gate, fail below
            failures[gate.__name__] = str(exc)
            print(f'FAIL: {gate.__name__} - {exc}', flush=True)
    evidence['failures'] = failures

    json_command(
        '/silent-command local s=game.surfaces[1]; '
        f"for _,e in pairs(s.find_entities_filtered{{area={{{{{ox - 10},{oy - 10}}},{{{ox + 10},{oy + 10}}}}}}}) do "
        "if e.type~='character' then e.destroy() end end; rcon.print(helpers.table_to_json({cleaned=true}))",
        'compiled lua tools cleanup',
    )
    require(not failures, {'failed_gates': sorted(failures)})
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
        (args.results / 'compiled-lua-tools-cell-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
