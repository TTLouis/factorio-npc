#!/usr/bin/env node
// Compatibility entrypoint; implementation shared by harness modes.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, reportCliFailure } from '../../deploy/pterodactyl/runtime-v8/external-harness-cli.mjs'
export * from '../../deploy/pterodactyl/runtime-v8/external-harness-cli.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.exitCode = reportCliFailure(error) })
}
