#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { confirmLuaConsoleReady, Rcon } from '../../deploy/pterodactyl/runtime-v8/common.mjs'
import { startMcpServer } from './mcp-server.mjs'
import { NativeBridge } from './native-bridge.mjs'
import { failure, openRuntime } from './runtime.mjs'

const HELP = `Factorio external harness (experimental, local stdio MCP)

Usage: node tools/external-harness/cli.mjs [--bind | --help]

Required environment:
  SGLUNA_RCON_PASSWORD          Inject through your local secret environment
  EXTERNAL_HARNESS_SESSION      Persisted world-unique random ID (32-120 chars)
  EXTERNAL_HARNESS_STATE_DIR    Private, durable journal directory for this world
Optional:
  SGLUNA_RCON_HOST              127.0.0.1 (only loopback is permitted)
  SGLUNA_RCON_PORT              27015

--bind is an explicit operator-only action for a fresh idle save. It refuses an
existing deployment session and never takes over a running controller.
Normal mode never configures a game, starts a model, or cancels work on exit.
See docs/EXTERNAL_HARNESS.md for guarded mod setup, receipts and recovery.
`

export function configuration(env) {
  const host = env.SGLUNA_RCON_HOST ?? '127.0.0.1'
  const port = Number(env.SGLUNA_RCON_PORT ?? 27015)
  if (!['127.0.0.1', '::1'].includes(host)) throw failure('loopback_required')
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw failure('invalid_port')
  if (typeof env.SGLUNA_RCON_PASSWORD !== 'string' || env.SGLUNA_RCON_PASSWORD.length === 0) throw failure('rcon_password_required')
  if (!/^[a-z0-9_-]{32,120}$/i.test(env.EXTERNAL_HARNESS_SESSION ?? '')) throw failure('world_unique_session_required')
  if (!env.EXTERNAL_HARNESS_STATE_DIR) throw failure('state_directory_required')
  return { host, port, password: env.SGLUNA_RCON_PASSWORD,
    session: env.EXTERNAL_HARNESS_SESSION, directory: path.resolve(env.EXTERNAL_HARNESS_STATE_DIR) }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return }
  if (args.length > 1 || args.length === 1 && args[0] !== '--bind') throw failure('invalid_cli_arguments')
  const config = configuration(env)
  const rcon = new Rcon(config.port, config.password, 5000, { host: config.host })
  const bridge = new NativeBridge({ rcon, session: config.session })
  const runtime = await openRuntime({ bridge, directory: config.directory, session: config.session })
  let server
  const stop = () => server?.stop()
  try {
    await rcon.connect()
    if (args[0] === '--bind') {
      await confirmLuaConsoleReady(rcon) // Only the fixed readiness read may repeat.
      await bridge.bind()
      process.stderr.write('Fresh save bound to external session. Preserve its journal and game save together.\n')
      return
    }
    await runtime.context() // Refuse wrong world/session before exposing tools.
    server = startMcpServer({ runtime })
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    await server.done
  }
  finally {
    server?.stop()
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await runtime.close()
    rcon.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'startup_or_transport_failed'
    process.stderr.write(`External harness stopped: ${code}. No automatic gameplay replay was attempted.\n`)
    process.exitCode = 1
  })
}
