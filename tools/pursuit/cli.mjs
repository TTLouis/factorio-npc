#!/usr/bin/env node
// Compatibility entrypoint; implementation shared by harness modes.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main } from '../../deploy/pterodactyl/runtime-v8/pursuit-cli.mjs'
export * from '../../deploy/pterodactyl/runtime-v8/pursuit-cli.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'startup_or_transport_failed'
    process.stderr.write(`Pursuit mode stopped: ${code}. No gameplay was replayed or cancelled.\n`)
    process.exitCode = 1
  })
}
