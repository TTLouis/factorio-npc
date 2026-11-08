#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { main, reportStartupError } from '../../deploy/pterodactyl/runtime-v8/harness-cli.mjs'
export * from '../../deploy/pterodactyl/runtime-v8/harness-cli.mjs'

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(reportStartupError)
