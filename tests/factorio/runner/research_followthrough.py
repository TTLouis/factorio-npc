"""Verify research request IDs survive through native completion and rejection."""
import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from run import Rcon, connect_with_retry, decode_json, lua_json, remote_call
from runtime import operation_status_command, wait_until_idle


def require(condition: bool, message: object) -> None:
    if not condition:
        raise AssertionError(message)


def run(client: Rcon, results: Path) -> None:
    results.mkdir(parents=True, exist_ok=True)
    transcript: list[dict[str, Any]] = []
    started = time.monotonic()

    def command(text: str) -> str:
        response = client.command(text)
        transcript.append({'elapsed_seconds': time.monotonic() - started, 'command': text, 'response': response})
        (results / 'research-followthrough-transcript.json').write_text(json.dumps({'transcript': transcript}, indent=2))
        return response

    def json_command(text: str, context: str) -> Any:
        return decode_json(command(text), context)

    def operation_status(context: str) -> dict:
        return json_command(operation_status_command(), context)

    def research_status() -> dict:
        return json_command(lua_json(remote_call('autorio_research', 'status')), 'research follow-through status')

    def request_result(request_id: int) -> dict:
        return json_command(
            lua_json(remote_call('autorio_research', 'request_result', str(request_id))),
            f'research request {request_id}',
        )

    original_id = json.loads((results / 'runner.json').read_text())['actor_id']
    before = research_status()
    recent = before.get('recent_requests') or []
    follow = before.get('follow_through') or []

    completed = [
        item for item in recent
        if item.get('technology') == 'automation'
        and item.get('accepted') is True
        and item.get('completed') is True
        and item.get('code') == 'completed'
    ]
    require(completed, {'message': 'native automation completion was not correlated to a request', 'status': before})
    native = completed[-1]
    require(type(native.get('request_id')) is int and native['request_id'] > 0, native)
    require(native.get('actor_id') == original_id and native.get('actor_kind') == 'standalone_character', native)

    exact = request_result(native['request_id'])
    require(exact.get('found') is True, exact)
    require(exact.get('result', {}).get('completed') is True, exact)
    require(exact.get('result', {}).get('code') == 'completed', exact)
    require(exact.get('follow_through', {}).get('state') == 'completed', exact)
    require(exact.get('follow_through', {}).get('actor_id') == original_id, exact)

    correlated_follow = [item for item in follow if item.get('request_id') == native['request_id']]
    require(correlated_follow and correlated_follow[-1].get('state') == 'completed', {'status': before, 'exact': exact})

    # A fresh request for an already-completed technology still gets its own ID
    # and completes as an idempotent no-op only when it reaches the queue head.
    already = json_command(
        lua_json(remote_call('autorio_operations', 'research_technology', repr('automation'))),
        'already researched submission',
    )
    require(isinstance(already, list) and len(already) >= 3, already)
    require(already[0] is True and type(already[2]) is int and already[2] > native['request_id'], already)
    already_id = already[2]
    wait_until_idle(operation_status, 'already researched correlated request', 5)
    already_exact = request_result(already_id)
    require(already_exact.get('found') is True, already_exact)
    require(already_exact.get('result', {}).get('accepted') is True, already_exact)
    require(already_exact.get('result', {}).get('completed') is True, already_exact)
    require(already_exact.get('result', {}).get('code') == 'already_researched', already_exact)
    require(already_exact.get('result', {}).get('actor_id') == original_id, already_exact)

    # Rejected requests are also correlated and never need task dispatch to get
    # a durable receipt.
    rejected = json_command(
        lua_json(remote_call('autorio_operations', 'research_technology', repr('__sgluna_followthrough_missing__'))),
        'rejected correlated research request',
    )
    require(isinstance(rejected, list) and len(rejected) >= 3, rejected)
    require(rejected[0] is False and rejected[1] == 'unknown_technology', rejected)
    rejected_id = rejected[2]
    require(type(rejected_id) is int and rejected_id > already_id, rejected)
    rejected_exact = request_result(rejected_id)
    require(rejected_exact.get('found') is True, rejected_exact)
    require(rejected_exact.get('result', {}).get('accepted') is False, rejected_exact)
    require(rejected_exact.get('result', {}).get('completed') is False, rejected_exact)
    require(rejected_exact.get('result', {}).get('code') == 'unknown_technology', rejected_exact)

    invalid = request_result(0)
    require(invalid == {'found': False, 'error': 'invalid_request_id'}, invalid)

    after = research_status()
    require(after.get('next_request_id', 0) >= rejected_id, after)
    require(len(after.get('recent_requests') or []) <= 10, after)
    require(len(after.get('follow_through') or []) <= 10, after)

    record = {
        'status': 'pass',
        'actor_id': original_id,
        'native_completed_request': exact,
        'already_researched_request': already_exact,
        'rejected_request': rejected_exact,
        'final_status': after,
    }
    (results / 'research-followthrough.json').write_text(json.dumps(record, indent=2))
    print(
        'PASS: zero-player NPC research request IDs correlate native completion, idempotent completion, and rejection '
        f'with stable actor_id={original_id}',
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--results', type=Path, required=True)
    args = parser.parse_args()

    client = connect_with_retry(args.host, args.port, args.password)
    try:
        run(client, args.results)
    except Exception as exc:
        args.results.mkdir(parents=True, exist_ok=True)
        (args.results / 'research-followthrough-error.txt').write_text(f'{type(exc).__name__}: {exc}\n')
        raise
    finally:
        client.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
