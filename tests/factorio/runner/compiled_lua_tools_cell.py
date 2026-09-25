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

Gates:
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
        'rcon.print(helpers.table_to_json({ox=ox,oy=oy,pipes={p1.unit_number,p2.unit_number},chest=chest.unit_number}))',
        'compiled lua tools fixture',
    )
    ox, oy = fixture.get('ox'), fixture.get('oy')
    require(isinstance(ox, int) and isinstance(oy, int), fixture)
    evidence['fixture'] = fixture

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
    for gate in (scope_gate, capacity_gate, factory_gate):
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
