#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_MODES, resolveHarnessMode } from './harness-modes.mjs'

const HELP = `Factorio NPC shared harness
Usage: node tools/harness/cli.mjs [--mode external|plan|pursuit] [mode arguments]
Mode may also be set with SGLUNA_HARNESS_MODE; conflicting selections are refused.
Default: external. Use --mode <name> --help for that lifecycle's setup.
external: local stdio MCP; --bind, --crash-site or no arguments.
plan: installed Factorio server supervisor; no arguments.
pursuit: in-process operator; --profile <non-secret profile.json>.
Select before startup; stop and reconcile native work before changing modes.
`

const invalidArguments = () => Object.assign(new Error('invalid_cli_arguments'), { code: 'invalid_cli_arguments' })

export function parseArguments(args = [], env = process.env) {
  let mode
  const forwarded = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') {
      if (mode !== undefined || i + 1 === args.length) throw invalidArguments()
      mode = args[++i]
    }
    else forwarded.push(args[i])
  }
  return { mode: resolveHarnessMode({ mode, env }), args: forwarded,
    help: mode === undefined && env.SGLUNA_HARNESS_MODE === undefined && forwarded.length === 1 && forwarded[0] === '--help' }
}

const defaultLoaders = Object.freeze({
  external: () => import('./external-harness-cli.mjs'),
  plan: () => import('./supervisor.mjs'),
  pursuit: () => import('./pursuit-cli.mjs'),
})

export async function main(args = process.argv.slice(2), env = process.env, { loaders = defaultLoaders, stdout = process.stdout } = {}) {
  const selected = parseArguments(args, env)
  if (selected.help) { stdout.write(HELP); return }
  if (selected.mode === 'plan') {
    if (selected.args.length === 1 && selected.args[0] === '--help') {
      stdout.write('Plan mode: installed server supervisor. Requires the installed manifest, Factorio binary, mod and sgluna-config.json. See docs/HARNESS_MODES.md. No CLI arguments.\n')
      return
    }
    if (selected.args.length) throw invalidArguments()
  }
  // Only the selected lifecycle can open a controller, journal or provider.
  return (await loaders[selected.mode]()).main(selected.args, env)
}

export function reportStartupError(error) {
  const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'startup_or_transport_failed'
  process.stderr.write(`Harness stopped: ${code}.\n`)
  process.exitCode = code === 'state_locked' ? 75 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(reportStartupError)

export { HARNESS_MODES }
