#!/usr/bin/env python3
"""One-shot Factorio RCON transport for the Node coordinator integration test."""

import argparse
import sys

from run import connect_with_retry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('--host', required=True)
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--password', required=True)
    parser.add_argument('--command', required=True)
    args = parser.parse_args()

    client = None
    try:
        client = connect_with_retry(args.host, args.port, args.password, timeout=10.0)
        sys.stdout.write(client.command(args.command))
        return 0
    finally:
        if client:
            client.close()


if __name__ == '__main__':
    raise SystemExit(main())
