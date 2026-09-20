#!/usr/bin/env python3
import argparse
import json
import sys
import time
from pathlib import Path

from run import assert_true, connect_with_retry, decode_json, lua_json, remote_call
from runtime import verify_free_running_ticks


def is_lua_sequence(value: object) -> bool:
    # Factorio serializes an empty Lua table as {}, while populated array-like
    # tables serialize as JSON arrays. Accept both representations here.
    return isinstance(value, list) or value == {}


def run(client, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'swarm-map-remote-transcript.json'
    started = time.monotonic()

    def command(value: str) -> str:
        response = client.command(value)
        transcript.append({
            'command': value,
            'response': response,
            'elapsed_seconds': round(time.monotonic() - started, 3),
        })
        transcript_path.write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def call(interface: str, method: str, *args: str):
        response = command(lua_json(remote_call(interface, method, *args)))
        return decode_json(response, f'{interface}.{method}')

    verify_free_running_ticks(command, results)

    # The actor-scoped learning pipeline used to exist as a module without being
    # registered in control.ts. A real remote call makes that wiring part of the
    # live Factorio contract instead of only a unit-test assumption.
    learning = call('autorio_swarm_learning_pipeline', 'status')
    assert_true('policy' in learning, f'swarm learning pipeline remote is not live: {learning!r}')
    assert_true(is_lua_sequence(learning.get('opportunities')), f'learning status lacks opportunities: {learning!r}')
    assert_true(is_lua_sequence(learning.get('verification_queue')), f'learning status lacks verification queue: {learning!r}')

    swarm = call('autorio_swarm', 'status')
    actors = sorted(swarm.get('actors') or [], key=lambda entry: entry['actorId'])
    assert_true(len(actors) >= 2, f'map gate requires two live swarm actors: {swarm!r}')
    target = actors[0]
    actor_id = target['actorId']
    agent_id = target['agent']['id']
    runtime = target['runtime']
    actor = target['actor']
    before_revision = runtime['bodyRevision']
    before_physical = runtime['physical']['physicalActorId']
    position = actor['position']

    context = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(context.get('ok') is True, f'swarm map context failed: {context!r}')
    observer = context.get('observer') or {}
    assert_true(observer.get('actor_id') == actor_id, f'map context crossed logical actor identity: {context!r}')
    assert_true(observer.get('agent_id') == agent_id, f'map context crossed agent identity: {context!r}')
    assert_true(observer.get('body_revision') == before_revision, f'map context has stale body revision: {context!r}')
    assert_true((context.get('policy') or {}).get('actor_scoped') is True, f'map context lacks actor-scoped policy: {context!r}')

    # A zero-player test save intentionally starts with no charted map. Prove
    # the production map service fails closed first. Then establish visibility
    # through a real same-force powered radar instead of bypassing fog/chart
    # policy with a debug-only map mutation.
    prechart_query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(
        prechart_query.get('ok') is False and prechart_query.get('code') == 'area_uncharted',
        f'uncharted map query did not fail closed: {prechart_query!r}',
    )
    prechart_observer = prechart_query.get('observer') or {}
    assert_true(prechart_observer.get('actor_id') == actor_id, f'uncharted query lost actor provenance: {prechart_query!r}')
    assert_true(prechart_observer.get('body_revision') == before_revision, f'uncharted query lost body revision: {prechart_query!r}')

    # Give the radar a real electric network. Writing LuaEntity.energy only
    # fills the radar's tiny per-tick input buffer; it does not keep the radar
    # powered long enough for Factorio's periodic nearby-coverage pulse. A full
    # accumulator can sustain one 300 kW radar for longer than this gate while
    # a substation connects both entities through normal engine power semantics.
    radar_create_expr = (
        '(function() local s=game.surfaces[1]; local f=game.forces["player"]; '
        f'local rp=s.find_non_colliding_position("radar", {{x={position["x"]},y={position["y"]}}}, 24, 1); '
        'if not rp then return {ok=false,code="no_radar_position"} end; '
        'local r=s.create_entity{name="radar",position=rp,force=f,raise_built=false}; '
        'if not r then return {ok=false,code="radar_create_failed"} end; '
        'local pp=s.find_non_colliding_position("substation",{x=rp.x+4,y=rp.y},3,0.5); '
        'if not pp then r.destroy{raise_destroy=false}; return {ok=false,code="no_substation_position"} end; '
        'local p=s.create_entity{name="substation",position=pp,force=f,raise_built=false}; '
        'if not p then r.destroy{raise_destroy=false}; return {ok=false,code="substation_create_failed"} end; '
        'local ap=s.find_non_colliding_position("accumulator",{x=pp.x+4,y=pp.y},3,0.5); '
        'if not ap then p.destroy{raise_destroy=false}; r.destroy{raise_destroy=false}; return {ok=false,code="no_accumulator_position"} end; '
        'local a=s.create_entity{name="accumulator",position=ap,force=f,raise_built=false}; '
        'if not a then p.destroy{raise_destroy=false}; r.destroy{raise_destroy=false}; return {ok=false,code="accumulator_create_failed"} end; '
        'a.energy=5000000; '
        'return {ok=true,radar_position=r.position,substation_position=p.position,accumulator_position=a.position,accumulator_energy=a.energy} end)()'
    )
    radar = decode_json(command(lua_json(radar_create_expr)), 'temporary powered radar fixture')
    assert_true(
        radar.get('ok') is True
        and radar.get('radar_position') is not None
        and radar.get('substation_position') is not None
        and radar.get('accumulator_position') is not None,
        f'could not create temporary powered radar fixture: {radar!r}',
    )
    radar_position = radar['radar_position']
    radar_x = radar_position['x']
    radar_y = radar_position['y']
    substation_position = radar['substation_position']
    accumulator_position = radar['accumulator_position']

    chunk_x = int(position['x'] // 32)
    chunk_y = int(position['y'] // 32)
    chart_state_expr = (
        '(function() local f=game.forces["player"]; local s=game.surfaces[1]; '
        f'local r=s.find_entity("radar",{{x={radar_x},y={radar_y}}}); '
        f'local a=s.find_entity("accumulator",{{x={accumulator_position["x"]},y={accumulator_position["y"]}}}); '
        f'local c={{x={chunk_x},y={chunk_y}}}; '
        'return {radar_found=(r~=nil), radar_valid=(r and r.valid) or false, '
        'radar_energy=(r and r.valid and r.energy) or 0, '
        'accumulator_found=(a~=nil), accumulator_energy=(a and a.valid and a.energy) or 0, '
        'charted=f.is_chunk_charted(s,c), visible=f.is_chunk_visible(s,c), '
        'requested=f.is_chunk_requested_for_charting(s,c)} end)()'
    )
    chart_state = None
    deadline = time.monotonic() + 12.0
    while time.monotonic() < deadline:
        chart_state = decode_json(command(lua_json(chart_state_expr)), 'radar chart state')
        if chart_state.get('charted') is True and chart_state.get('visible') is True:
            break
        time.sleep(0.1)
    assert_true(
        chart_state is not None and chart_state.get('charted') is True and chart_state.get('visible') is True,
        f'powered radar did not make actor chunk charted+visible within 12s: {chart_state!r}; radar={radar!r}',
    )

    query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(query.get('ok') is True, f'live actor-local map query failed with real radar visibility: {query!r}')
    query_observer = query.get('observer') or {}
    assert_true(query_observer.get('actor_id') == actor_id, f'map query lost actor provenance: {query!r}')
    assert_true(query_observer.get('body_revision') == before_revision, f'map query lost body revision: {query!r}')

    destroyed = call('autorio_swarm', 'destroy_body', repr(actor_id))
    assert_true(destroyed.get('ok') is True, f'could not destroy body for map stale-body gate: {destroyed!r}')

    missing = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(missing.get('ok') is False and missing.get('code') == 'no_body', f'map service accepted a missing/stale body: {missing!r}')

    replaced = call(
        'autorio_swarm',
        'replace_body',
        repr(actor_id),
        repr(position['x']),
        repr(position['y']),
        '1',
        repr('player'),
    )
    assert_true(replaced.get('ok') is True, f'could not replace body for map rebind gate: {replaced!r}')
    after_runtime = replaced['runtime']
    after_revision = after_runtime['bodyRevision']
    after_physical = after_runtime['physical']['physicalActorId']
    assert_true(after_revision > before_revision, f'body revision did not advance after replacement: before={before_revision}, after={after_runtime!r}')
    assert_true(after_physical != before_physical, f'physical body id did not change after replacement: before={before_physical}, after={after_physical}')

    rebound = call('autorio_swarm_map', 'context', repr(actor_id))
    assert_true(rebound.get('ok') is True, f'map service did not rebind replacement body: {rebound!r}')
    rebound_observer = rebound.get('observer') or {}
    assert_true(rebound_observer.get('actor_id') == actor_id, f'rebound map context changed logical actor: {rebound!r}')
    assert_true(rebound_observer.get('body_revision') == after_revision, f'rebound map context retained stale body revision: {rebound!r}')

    rebound_query = call(
        'autorio_swarm_map',
        'query_area',
        repr(actor_id),
        '1',
        repr(position['x']),
        repr(position['y']),
        '4',
        '16',
    )
    assert_true(rebound_query.get('ok') is True, f'map query failed after replacement: {rebound_query!r}')
    assert_true((rebound_query.get('observer') or {}).get('body_revision') == after_revision, f'post-replacement query used stale provenance: {rebound_query!r}')

    cleanup_expr = (
        '(function() local s=game.surfaces[1]; '
        f'local r=s.find_entity("radar",{{x={radar_x},y={radar_y}}}); '
        f'local p=s.find_entity("substation",{{x={substation_position["x"]},y={substation_position["y"]}}}); '
        f'local a=s.find_entity("accumulator",{{x={accumulator_position["x"]},y={accumulator_position["y"]}}}); '
        'if r and r.valid then r.destroy{raise_destroy=false} end; '
        'if p and p.valid then p.destroy{raise_destroy=false} end; '
        'if a and a.valid then a.destroy{raise_destroy=false} end; return true end)()'
    )
    decode_json(command(lua_json(cleanup_expr)), 'temporary powered radar fixture cleanup')

    result = {
        'status': 'pass',
        'actor_id': actor_id,
        'agent_id': agent_id,
        'before_body_revision': before_revision,
        'after_body_revision': after_revision,
        'before_physical_actor_id': before_physical,
        'after_physical_actor_id': after_physical,
        'prechart_code': prechart_query.get('code'),
        'radar': radar,
        'chart_state': chart_state,
        'query_returned_count': query.get('returned_count'),
        'rebound_query_returned_count': rebound_query.get('returned_count'),
        'learning_policy': learning.get('policy'),
        'transcript': transcript,
    }
    (results / 'swarm-map-remote.json').write_text(json.dumps(result, indent=2))
    print(
        'PASS: actor-scoped map remote rejected uncharted access, used real radar visibility, preserved logical provenance, '
        f'rejected a missing body, and rebound {actor_id} from body revision {before_revision} to {after_revision}; '
        'swarm learning pipeline remote is live'
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
        (args.results / 'swarm-map-remote-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
