#!/usr/bin/env node
// Compatibility entrypoint; implementation shared by harness modes.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, STATE_LOCKED_EXIT_CODE } from '../../deploy/pterodactyl/runtime-v8/external-harness-cli.mjs'
export * from '../../deploy/pterodactyl/runtime-v8/external-harness-cli.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'startup_or_transport_failed'
    process.stderr.write(`External harness stopped: ${code}. No automatic gameplay replay was attempted.\n`)
    // A distinct exit status lets the process adapter name a held state lock
    // without reading this process's stderr.
    process.exitCode = code === 'state_locked' ? STATE_LOCKED_EXIT_CODE : 1
  })
}
