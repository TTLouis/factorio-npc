#!/usr/bin/env python3
import argparse
import json
import socket
import struct
import sys
import time
from pathlib import Path

from runtime import operation_status_command, wait_until_idle

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


def lua_json(expr: str) -> str:
    return f"/silent-command rcon.print(helpers.table_to_json({expr}))"


def lua_text(expr: str) -> str:
    return f"/silent-command rcon.print(tostring({expr}))"


def remote_call(interface: str, method: str, *args: str) -> str:
    rendered = ', '.join([repr(interface), repr(method), *args])
    return f'remote.call({rendered})'


def decode_json(response: str, context: str):
    if not response:
        raise RuntimeError(f'{context} returned an empty RCON response')
    try:
        return json.loads(response)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f'{context} returned non-JSON RCON output: {response!r}') from exc


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path) -> None:
    transcript: list[dict[str, object]] = []
    results.mkdir(parents=True, exist_ok=True)
    transcript_path = results / 'placement-transfer-transcript.json'
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
        return decode_json(command(operation_status_command()), context)

    def actor_status(context: str) -> dict:
        return decode_json(
            command(lua_json(remote_call('autorio_actor', 'status'))),
            context,
        )

    def wait_for_idle(context: str, timeout: float = 10.0) -> dict:
        return wait_until_idle(operation_status, context, timeout)

    initial_status = actor_status('autorio_actor.status before placement')
    assert_true(initial_status['mode'] == 'npc', f'NPC mode was lost: {initial_status!r}')
    assert_true(initial_status['connected_players'] == 0, f'player appeared before placement: {initial_status!r}')
    actor_id = initial_status['actor']['actor_id']

    seed_fixture = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "for _,e in pairs(s.find_entities_filtered{name='wooden-chest'}) do e.destroy() end; "
        "local a=s.find_entities_filtered{name='character'}[1]; "
        "local inv=a and a.get_main_inventory(); "
        "local chest_added=inv and inv.insert{name='wooden-chest',count=1} or 0; "
        "local plates_added=inv and inv.insert{name='iron-plate',count=5} or 0; "
        "rcon.print(helpers.table_to_json({chest_added=chest_added,plates_added=plates_added,"
        "chests=a and a.get_item_count('wooden-chest') or 0,"
        "plates=a and a.get_item_count('iron-plate') or 0}))"
    )
    before = decode_json(command(seed_fixture), 'placement/transfer fixture setup')
    assert_true(before['chest_added'] == 1, f'could not seed wooden chest: {before!r}')
    assert_true(before['plates_added'] == 5, f'could not seed transfer items: {before!r}')

    response = command(lua_text(remote_call('autorio_operations', 'place_entity', repr('wooden-chest'))))
    assert_true(response == 'true', f'could not start placement task: {response!r}')
    placement_status = wait_for_idle('autorio_operations.status (placement)', 5.0)
    assert_true(placement_status['actor']['actor_id'] == actor_id, f'placement switched actors: {placement_status!r}')

    placement_inspect = (
        "/silent-command "
        "local s=game.surfaces[1]; "
        "local a=s.find_entities_filtered{name='character'}[1]; "
        "local c=s.find_entities_filtered{name='wooden-chest',position=a.position,radius=3,force=a.force}[1]; "
        "rcon.print(helpers.table_to_json({created=c~=nil,"
        "actor_chests=a and a.get_item_count('wooden-chest') or 0,"
        "actor_plates=a and a.get_item_count('iron-plate') or 0,"
        "chest_plates=c and c.get_item_count('iron-plate') or 0}))"
    )
    placed = decode_json(command(placement_inspect), 'placement result inspection')
    assert_true(placed['created'] is True, f'NPC placement did not create a wooden chest: {placed!r}')
    assert_true(
        placed['actor_chests'] == before['chests'] - 1,
        f'NPC placement did not consume exactly one chest item: before={before!r}, after={placed!r}',
    )

    response = command(lua_json(remote_call(
        'autorio_operations',
        'move_items',
        repr('iron-plate'),
        repr('wooden-chest'),
        '3',
        'true',
    )))
    move_to_result = decode_json(response, 'autorio_operations.move_items(to chest)')
    assert_true(move_to_result[0] is True, f'could not start transfer-to-chest task: {move_to_result!r}')
    transfer_to_status = wait_for_idle('autorio_operations.status (transfer to chest)', 5.0)
    assert_true(transfer_to_status['actor']['actor_id'] == actor_id, f'transfer switched actors: {transfer_to_status!r}')

    after_to = decode_json(command(placement_inspect), 'transfer-to-chest result inspection')
    assert_true(
        after_to['actor_plates'] == placed['actor_plates'] - 3,
        f'NPC did not remove three plates from its inventory: before={placed!r}, after={after_to!r}',
    )
    assert_true(
        after_to['chest_plates'] == placed['chest_plates'] + 3,
        f'NPC did not put three plates into the chest: before={placed!r}, after={after_to!r}',
    )

    response = command(lua_json(remote_call(
        'autorio_operations',
        'move_items',
        repr('iron-plate'),
        repr('wooden-chest'),
        '2',
        'false',
    )))
    move_from_result = decode_json(response, 'autorio_operations.move_items(from chest)')
    assert_true(move_from_result[0] is True, f'could not start transfer-from-chest task: {move_from_result!r}')
    transfer_from_status = wait_for_idle('autorio_operations.status (transfer from chest)', 5.0)
    assert_true(transfer_from_status['actor']['actor_id'] == actor_id, f'return transfer switched actors: {transfer_from_status!r}')

    after_from = decode_json(command(placement_inspect), 'transfer-from-chest result inspection')
    assert_true(
        after_from['actor_plates'] == after_to['actor_plates'] + 2,
        f'NPC did not retrieve two plates from the chest: before={after_to!r}, after={after_from!r}',
    )
    assert_true(
        after_from['chest_plates'] == after_to['chest_plates'] - 2,
        f'chest did not lose two retrieved plates: before={after_to!r}, after={after_from!r}',
    )

    # An off-grid request is not an error: Factorio places a 1x1 entity on the
    # tile under the requested point, and so must the NPC. Seed a second chest,
    # pick a free tile centre near the actor, then ask for an off-grid point in it.
    off_grid_fixture = decode_json(command(
        "/silent-command "
        "local s=game.surfaces[1]; "
        "local a=s.find_entities_filtered{name='character'}[1]; "
        "local added=a.get_main_inventory().insert{name='wooden-chest',count=1}; "
        "local p=s.find_non_colliding_position('wooden-chest',{x=a.position.x+3,y=a.position.y},4,1,true); "
        "rcon.print(helpers.table_to_json({added=added,tile=p}))"
    ), 'off-grid chest fixture')
    assert_true(off_grid_fixture['added'] == 1 and isinstance(off_grid_fixture.get('tile'), dict), f'could not seed off-grid chest fixture: {off_grid_fixture!r}')
    tile = off_grid_fixture['tile']
    requested = {'x': tile['x'] + 0.375, 'y': tile['y'] - 0.4375}
    response = command(lua_text(remote_call(
        'autorio_operations', 'place_entity', repr('wooden-chest'), repr(requested['x']), repr(requested['y']),
    )))
    assert_true(response == 'true', f'could not start off-grid placement task: {response!r}')
    off_grid_status = wait_for_idle('autorio_operations.status (off-grid placement)', 5.0)
    off_grid_receipt = (off_grid_status.get('basic_operation') or {}).get('last_result') or {}
    assert_true(
        off_grid_receipt.get('code') == 'completed'
        and off_grid_receipt.get('placed_position') == tile
        and off_grid_receipt.get('requested_position') == requested,
        f'off-grid chest request did not land on the tile under the point: tile={tile!r}, receipt={off_grid_receipt!r}',
    )
    off_grid_entity = decode_json(command(
        "/silent-command "
        f"local c=game.surfaces[1].find_entity('wooden-chest',{{x={tile['x']},y={tile['y']}}}); "
        "rcon.print(helpers.table_to_json({found=c~=nil}))"
    ), 'off-grid chest inspection')
    assert_true(off_grid_entity['found'] is True, f'no wooden chest at the snapped tile {tile!r}')

    final_status = actor_status('autorio_actor.status after placement/transfer')
    assert_true(final_status['connected_players'] == 0, f'player appeared during placement/transfer: {final_status!r}')
    assert_true(final_status['actor']['actor_id'] == actor_id, f'actor identity changed: {final_status!r}')

    (results / 'placement-transfer.json').write_text(json.dumps({
        'status': 'pass',
        'actor_id': actor_id,
        'before': before,
        'placed': placed,
        'after_to': after_to,
        'after_from': after_from,
        'off_grid_receipt': off_grid_receipt,
        'transcript': transcript,
    }, indent=2))
    print(
        'PASS: zero-player NPC completed placement + inventory transfer '
        f'with stable actor_id={actor_id}'
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()

    client = Rcon(args.host, args.port, args.password)
    try:
        client.connect()
        run(client, args.results)
        return 0
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'placement-transfer-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == '__main__':
    raise SystemExit(main())
