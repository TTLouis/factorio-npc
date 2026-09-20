#!/usr/bin/env python3
import argparse
import json
import socket
import struct
import sys
import time
from pathlib import Path

from runtime import operation_status_command, verify_free_running_ticks, wait_until_idle

SERVERDATA_RESPONSE_VALUE = 0
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_AUTH_RESPONSE = 2
SERVERDATA_AUTH = 3


class Rcon:
    def __init__(self, host: str, port: int, password: str):
        self.host = host
        self.port = port
        self.password = password
        self.sock: socket.socket | None = None
        self.request_id = 0

    def connect(self) -> None:
        self.sock = socket.create_connection((self.host, self.port), timeout=5)
        self._send(SERVERDATA_AUTH, self.password)
        while True:
            request_id, packet_type, _ = self._recv()
            if packet_type == SERVERDATA_AUTH_RESPONSE:
                if request_id == -1:
                    raise RuntimeError('RCON authentication failed')
                return

    def close(self) -> None:
        if self.sock:
            self.sock.close()
            self.sock = None

    def command(self, command: str) -> str:
        request_id = self._send(SERVERDATA_EXECCOMMAND, command)
        while True:
            response_id, packet_type, body = self._recv()
            if response_id == request_id and packet_type == SERVERDATA_RESPONSE_VALUE:
                return body.strip()

    def _send(self, packet_type: int, body: str) -> int:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        self.request_id += 1
        payload = struct.pack('<ii', self.request_id, packet_type) + body.encode() + b'\x00\x00'
        self.sock.sendall(struct.pack('<i', len(payload)) + payload)
        return self.request_id

    def _recv(self) -> tuple[int, int, str]:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        size = struct.unpack('<i', self._read_exact(4))[0]
        payload = self._read_exact(size)
        request_id, packet_type = struct.unpack('<ii', payload[:8])
        body = payload[8:-2].decode(errors='replace')
        return request_id, packet_type, body

    def _read_exact(self, size: int) -> bytes:
        if not self.sock:
            raise RuntimeError('RCON is not connected')
        data = bytearray()
        while len(data) < size:
            chunk = self.sock.recv(size - len(data))
            if not chunk:
                raise ConnectionError('RCON socket closed')
            data.extend(chunk)
        return bytes(data)


def connect_with_retry(host: str, port: int, password: str, timeout: float = 30.0) -> Rcon:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        client = Rcon(host, port, password)
        try:
            client.connect()
            return client
        except Exception as exc:
            last_error = exc
            client.close()
            time.sleep(0.5)
    raise RuntimeError(f'Factorio RCON did not become ready: {last_error}')


def lua_json(expr: str) -> str:
    return f"/silent-command rcon.print(helpers.table_to_json({expr}))"


def lua_text(expr: str) -> str:
    return f"/silent-command rcon.print(tostring({expr}))"


def remote_call(interface: str, method: str, *args: str) -> str:
    rendered = ', '.join([repr(interface), repr(method), *args])
    return f'remote.call({rendered})'


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def decode_json(response: str, context: str):
    if not response:
        raise RuntimeError(f'{context} returned an empty RCON response')
    try:
        return json.loads(response)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'{context} returned non-JSON RCON output: {response!r}') from exc


def squared_distance(a: dict[str, float], b: dict[str, float]) -> float:
    return (a['x'] - b['x']) ** 2 + (a['y'] - b['y']) ** 2


def run(client: Rcon, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'runner-transcript.json'
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

    def operation_status(context: str) -> dict:
        response = command(operation_status_command())
        return decode_json(response, context)

    def actor_status(context: str) -> dict:
        response = command(lua_json(remote_call('autorio_actor', 'status')))
        return decode_json(response, context)

    def wait_for_idle(context: str, timeout: float = 10.0) -> dict:
        return wait_until_idle(operation_status, context, timeout)

    # Factorio 2.0 requires the first Lua console command to be repeated before
    # it disables achievements and actually executes Lua. RCON receives an empty
    # response for the rejected first attempt, which previously looked like a
    # JSON parsing failure. Use a harmless, identical probe twice and require the
    # expected marker before running any test commands.
    lua_probe = '/silent-command rcon.print("AIRI_RCON_READY")'
    probe_response = command(lua_probe)
    if probe_response != 'AIRI_RCON_READY':
        probe_response = command(lua_probe)
    assert_true(
        probe_response == 'AIRI_RCON_READY',
        f'Factorio Lua console handshake failed over RCON: {probe_response!r}',
    )

    # Prove this is a continuously ticking zero-player world, not a paused
    # server taking a single simulation step for each RCON status request.
    simulation_clock = verify_free_running_ticks(command, results)

    response = command(lua_json(remote_call('autorio_actor', 'set_mode', repr('npc'))))
    set_mode = decode_json(response, 'autorio_actor.set_mode')
    assert_true(set_mode[0] is True, f'could not enable npc mode: {set_mode!r}')

    status = actor_status('autorio_actor.status')
    assert_true(status['mode'] == 'npc', f"expected npc mode, got {status!r}")
    assert_true(status['connected_players'] == 0, f"NPC test unexpectedly has players: {status!r}")
    assert_true(status['actor'] is not None, f"standalone actor was not created: {status!r}")
    assert_true(status['actor']['valid'] is True, f"standalone actor is invalid: {status!r}")
    assert_true(status['actor']['kind'] == 'standalone_character', f"wrong actor kind: {status!r}")
    assert_true(isinstance(status['actor']['actor_id'], int), f"NPC has no stable unit identity: {status!r}")

    first_actor_id = status['actor']['actor_id']
    initial_position = status['actor']['position']
    second_status = actor_status('autorio_actor.status (repeat)')
    assert_true(second_status['actor']['actor_id'] == first_actor_id, 'actor resolution created or selected a different NPC')

    # Actor diagnostics return a scalar boolean, not a table, so they must not
    # be passed through helpers.table_to_json(). The diagnostic call itself also
    # exercises character-safe actor inspection in zero-player NPC mode.
    response = command(lua_text(remote_call('autorio_operations', 'log_actor_info')))
    assert_true(response == 'true', f'actor diagnostics failed in zero-player mode: {response!r}')

    response = command(lua_json(remote_call(
        'autorio_preflight',
        'operation',
        repr('gather_resource'),
        "{resource_name='sgluna-missing-resource',count=1,search_radius=32}",
    )))
    preflight = decode_json(response, 'autorio_preflight.operation')
    assert_true(preflight.get('ok') is False, f'unknown resource preflight unexpectedly passed: {preflight!r}')
    assert_true(preflight.get('code') == 'unknown_prototype', f'wrong preflight code: {preflight!r}')
    assert_true(preflight.get('operation') == 'gather_resource', f'preflight lost operation identity: {preflight!r}')
    after_preflight = operation_status('autorio_operations.status (after preflight rejection)')
    assert_true(after_preflight.get('task_state') == 'idle', f'preflight rejection started work: {after_preflight!r}')
    assert_true(after_preflight.get('queue_empty') is True and after_preflight.get('queue_length') == 0,
                f'preflight rejection queued work: {after_preflight!r}')

    # Exercise the real control.ts on_tick dispatcher with the simplest bounded
    # task. If control.ts still resolved game.connected_players[0], this task
    # would remain stuck forever with zero connected players.
    response = command(lua_json(remote_call('autorio_operations', 'wait', '3')))
    wait_result = decode_json(response, 'autorio_operations.wait')
    assert_true(wait_result[0] is True, f'could not start wait task: {wait_result!r}')

    wait_status = wait_for_idle('autorio_operations.status (wait)', 5.0)
    assert_true(wait_status['actor']['actor_id'] == first_actor_id, f'control loop switched actors: {wait_status!r}')
    assert_true(wait_status.get('queue_empty') is True, f'wait task left queued work behind: {wait_status!r}')
    assert_true(wait_status.get('queue_length') == 0, f'wait task status did not expose an empty bounded queue: {wait_status!r}')

    # Create a deterministic, obstacle-free movement corridor. The test harness
    # owns this setup directly; production/model code still uses only Autorio's
    # structured operation interface. A wooden chest is unique on the test map,
    # so walk_to_entity cannot accidentally select a generated resource patch.
    movement_fixture = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "local tiles={}; "
        "for x=-2,12 do for y=-2,2 do tiles[#tiles+1]={name='landfill',position={x=x,y=y}} end end; "
        "s.set_tiles(tiles,true,false,true); "
        "for _,e in pairs(s.find_entities_filtered{area={{-2,-2},{12,2}}}) do "
        "if e.name~='character' then e.destroy() end end; "
        "local target=s.create_entity{name='wooden-chest',position={x=10,y=0},force=game.forces.player}; "
        "rcon.print(helpers.table_to_json({created=target~=nil,position=target and target.position or nil}))"
    )
    fixture = decode_json(command(movement_fixture), 'movement fixture setup')
    assert_true(fixture['created'] is True, f'could not create deterministic movement target: {fixture!r}')
    target_position = fixture['position']

    response = command(lua_text(remote_call('autorio_operations', 'walk_to_entity', repr('wooden-chest'), '50')))
    assert_true(response == 'true', f'could not start movement task: {response!r}')

    movement_status = wait_for_idle('autorio_operations.status (movement)', 10.0)
    assert_true(movement_status['actor']['actor_id'] == first_actor_id, f'movement switched actors: {movement_status!r}')

    moved_position = movement_status['actor']['position']
    assert_true(
        squared_distance(initial_position, moved_position) >= 4.0,
        f'NPC did not move a meaningful distance: start={initial_position!r}, end={moved_position!r}',
    )
    assert_true(
        squared_distance(moved_position, target_position) <= 16.0,
        f'NPC stopped too far from deterministic target: actor={moved_position!r}, target={target_position!r}',
    )

    # NPC-native mining: remove the movement target and place a single resource
    # entity inside AIRI's reach. Capture its actual engine position: resources
    # may snap to tile centers, so the requested position is not a safe lookup.
    mining_fixture = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest'}) do e.destroy() end; "
        "local a=s.find_entities_filtered{name='character'}[1]; "
        "local ore=s.create_entity{name='iron-ore',position={x=10,y=0},amount=20}; "
        "rcon.print(helpers.table_to_json({created=ore~=nil,amount=ore and ore.amount or nil,"
        "position=ore and ore.position or nil,"
        "inventory=a and a.get_item_count('iron-ore') or nil,actor_position=a and a.position or nil}))"
    )
    mining_before = decode_json(command(mining_fixture), 'mining fixture setup')
    assert_true(mining_before['created'] is True, f'could not create deterministic ore target: {mining_before!r}')
    ore_position = mining_before['position']
    assert_true(
        squared_distance(mining_before['actor_position'], ore_position) <= 16.0,
        f'NPC is outside deterministic mining reach setup: {mining_before!r}',
    )

    response = command(lua_text(remote_call('autorio_operations', 'mine_entity', repr('iron-ore'), '3')))
    assert_true(response == 'true', f'could not start NPC mining task: {response!r}')

    mining_status = wait_for_idle('autorio_operations.status (mining)', 12.0)
    assert_true(mining_status['actor']['actor_id'] == first_actor_id, f'mining switched actors: {mining_status!r}')

    mining_inspect = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "local a=s.find_entities_filtered{name='character'}[1]; "
        "local ore=s.find_entities_filtered{name='iron-ore',"
        f"position={{x={ore_position['x']},y={ore_position['y']}}},radius=0.25}}[1]; "
        "rcon.print(helpers.table_to_json({found=ore~=nil,amount=ore and ore.amount or 0,"
        "inventory=a and a.get_item_count('iron-ore') or 0,mining=a and a.mining_state.mining or false}))"
    )
    mining_after = decode_json(command(mining_inspect), 'mining result inspection')
    # A missing target must not be accepted as successful depletion: this
    # deterministic 20-unit patch must still exist after exactly three cycles.
    assert_true(mining_after['found'] is True, f'deterministic ore target disappeared: {mining_after!r}')
    assert_true(
        mining_after['inventory'] == mining_before['inventory'] + 3,
        f'NPC mining did not add exactly three iron ore to inventory: before={mining_before!r}, after={mining_after!r}',
    )
    assert_true(
        mining_after['amount'] == mining_before['amount'] - 3,
        f'NPC mining did not consume exactly three resource units: before={mining_before!r}, after={mining_after!r}',
    )
    assert_true(mining_after['mining'] is False, f'NPC remained in mining state after task completion: {mining_after!r}')

    # NPC-native crafting: seed exact ingredients as deterministic test setup,
    # then let the standalone character's real hand-crafting queue run. No
    # on_player_crafted_item event exists for this actor, so completion must be
    # observed from the character queue by Autorio itself.
    crafting_fixture = (
        "/silent-command "
        "local a=game.surfaces[1].find_entities_filtered{name='character'}[1]; "
        "local inv=a and a.get_main_inventory(); "
        "local inserted=inv and inv.insert{name='iron-plate',count=4} or 0; "
        "rcon.print(helpers.table_to_json({inserted=inserted,plates=a and a.get_item_count('iron-plate') or 0,"
        "gears=a and a.get_item_count('iron-gear-wheel') or 0,queue=a and a.crafting_queue_size or 0}))"
    )
    crafting_before = decode_json(command(crafting_fixture), 'crafting fixture setup')
    assert_true(crafting_before['inserted'] == 4, f'could not seed crafting ingredients: {crafting_before!r}')

    response = command(lua_json(remote_call('autorio_operations', 'craft_item', repr('iron-gear-wheel'), '2')))
    craft_result = decode_json(response, 'autorio_operations.craft_item')
    assert_true(craft_result[0] is True, f'could not start NPC crafting task: {craft_result!r}')

    crafting_status = wait_for_idle('autorio_operations.status (crafting)', 12.0)
    assert_true(crafting_status['actor']['actor_id'] == first_actor_id, f'crafting switched actors: {crafting_status!r}')

    crafting_inspect = (
        "/silent-command "
        "local a=game.surfaces[1].find_entities_filtered{name='character'}[1]; "
        "rcon.print(helpers.table_to_json({plates=a and a.get_item_count('iron-plate') or 0,"
        "gears=a and a.get_item_count('iron-gear-wheel') or 0,queue=a and a.crafting_queue_size or 0}))"
    )
    crafting_after = decode_json(command(crafting_inspect), 'crafting result inspection')
    assert_true(
        crafting_after['gears'] >= crafting_before['gears'] + 2,
        f'NPC crafting did not produce two iron gears: before={crafting_before!r}, after={crafting_after!r}',
    )
    assert_true(
        crafting_after['plates'] <= crafting_before['plates'] - 4,
        f'NPC crafting did not consume expected iron plates: before={crafting_before!r}, after={crafting_after!r}',
    )
    assert_true(crafting_after['queue'] == 0, f'NPC crafting queue was not drained: {crafting_after!r}')

    final_status = actor_status('autorio_actor.status (final)')
    assert_true(final_status['connected_players'] == 0, f"a player appeared during NPC smoke test: {final_status!r}")
    assert_true(final_status['actor']['actor_id'] == first_actor_id, f"final actor identity changed: {final_status!r}")

    (results / 'runner.json').write_text(json.dumps({
        'status': 'pass',
        'actor_id': first_actor_id,
        'simulation_clock': simulation_clock,
        'initial_position': initial_position,
        'movement_target': target_position,
        'final_position': final_status['actor']['position'],
        'mining_before': mining_before,
        'mining_after': mining_after,
        'crafting_before': crafting_before,
        'crafting_after': crafting_after,
        'transcript': transcript,
    }, indent=2))
    print(
        'PASS: zero-player NPC completed wait + movement + mining + crafting '
        f'with stable actor_id={first_actor_id}, final_position={final_status["actor"]["position"]}'
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()

    client: Rcon | None = None
    try:
        client = connect_with_retry(args.host, args.port, args.password)
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'runner-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
