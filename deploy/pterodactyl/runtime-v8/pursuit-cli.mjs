import { requireHarnessMode } from './harness-modes.mjs'
// Pursuit-mode startup: one goal, one operator, native acceptance. Reuses the
// external harness runtime (journal, receipts, NativeBridge) in-process. The
// host owns native cancellation, idle proof, save and close-out after this
// process reports that it stopped; this process never cancels game work.
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Rcon } from './common.mjs'
import { AgentNotebookStore } from './agent-notebook.mjs'
import { storeNotebook } from './operator-loop.mjs'
import { createOperatorCompletion } from './operator-provider.mjs'
import { createInProcessOperatorTools } from './operator-tool-surface.mjs'
import { createPursuitState, runPursuitGoal } from './pursuit-supervisor.mjs'
import { configuration as harnessConfiguration } from './external-harness-cli.mjs'
import { NativeBridge } from './operator-native-bridge.mjs'
import { failure, openRuntime } from './operator-runtime.mjs'

const HELP = `Factorio pursuit mode (experimental): node tools/pursuit/cli.mjs --profile <profile.json>

Profile (non-secret JSON): runId, goalId, model, brief, wallCapMs, goal, options.
Environment: SGLUNA_RCON_{HOST,PORT,PASSWORD}, EXTERNAL_HARNESS_{SESSION,STATE_DIR},
OPERATOR_PROVIDER_BASE, CLI_PROXY_GATEWAY_KEY (inject; never written to evidence).
State and evidence: <STATE_DIR>/pursuit/<goalId>/{state,notebook}.json, evidence.jsonl.
Stop: SIGINT/SIGTERM, the wall cap, or <STATE_DIR>/pursuit/<goalId>/STOP containing
{"goalId","session"} for this goal. On exit prints one JSON controller-stop line.
`

const ID = /^[A-Za-z0-9_.-]{1,80}$/
const MAX_BRIEF = 32 * 1024
const MAX_PROFILE = 64 * 1024

export function parseProfile(raw) {
  const profile = typeof raw === 'string' ? JSON.parse(raw) : raw
  const allowed = ['runId', 'goalId', 'model', 'brief', 'wallCapMs', 'goal', 'options', 'cacheSystemPrompt', 'maxTokens']
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) || Object.keys(profile).some(key => !allowed.includes(key))) throw failure('invalid_profile')
  if (!ID.test(profile.runId ?? '') || !ID.test(profile.goalId ?? '')) throw failure('invalid_profile_ids')
  if (typeof profile.model !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(profile.model)) throw failure('invalid_profile_model')
  if (typeof profile.brief !== 'string' || !profile.brief.trim() || profile.brief.length > MAX_BRIEF) throw failure('invalid_profile_brief')
  if (!Number.isSafeInteger(profile.wallCapMs) || profile.wallCapMs < 60000 || profile.wallCapMs > 12 * 3600000) throw failure('invalid_profile_wall_cap')
  if (!profile.goal || typeof profile.goal !== 'object') throw failure('explicit_goal_required')
  if (profile.options !== undefined && (typeof profile.options !== 'object' || Array.isArray(profile.options))) throw failure('invalid_profile_options')
  return profile
}

export function configuration(env) {
  const harness = harnessConfiguration(env)
  if (typeof env.OPERATOR_PROVIDER_BASE !== 'string' || !env.OPERATOR_PROVIDER_BASE) throw failure('operator_provider_base_required')
  if (typeof env.CLI_PROXY_GATEWAY_KEY !== 'string' || !env.CLI_PROXY_GATEWAY_KEY) throw failure('operator_provider_key_required')
  return { ...harness, providerBase: env.OPERATOR_PROVIDER_BASE, providerKey: env.CLI_PROXY_GATEWAY_KEY }
}

// The notebook store keys worlds by UUID; derive one stably from the session.
export function worldIdForSession(session) {
  const hex = createHash('sha256').update(`sgluna-pursuit-world:${session}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[parseInt(hex[16], 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function readJson(file) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw failure('invalid_pursuit_state') }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temp, 'w', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() }
  finally { await handle.close() }
  await fs.rename(temp, file)
}

// Evidence: every event with time and correlation. Provider requests log only
// messages not yet logged in this conversation, so the full history is
// reconstructable without repeating it; a shorter history marks a new seed.
// Content is what the model saw or returned; the key and endpoint never appear.
export function evidenceWriter({ file, runId, goalId, session, write = line => fs.appendFile(file, line, { mode: 0o600 }) }) {
  let logged = 0
  let conversation = 0
  let chain = Promise.resolve()
  const record = event => {
    let entry = event
    if (event.type === 'provider_request') {
      if (event.messages.length < logged) { conversation++; logged = 0 }
      entry = { type: event.type, requests: event.requests, rotations: event.rotations, conversation, message_count: event.messages.length,
        tool_names: event.tools.map(tool => tool.function.name), new_messages: event.messages.slice(logged) }
      logged = event.messages.length
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), run_id: runId, goal_id: goalId, session, ...entry })}\n`
    chain = chain.then(() => write(line))
    return chain
  }
  return { record, flush: () => chain }
}

export async function main(args = process.argv.slice(2), env = process.env, deps = {}) {
  requireHarnessMode('pursuit', env)
  if (args.length === 1 && args[0] === '--help') { process.stdout.write(HELP); return undefined }
  if (args.length !== 2 || args[0] !== '--profile') throw failure('invalid_cli_arguments')
  const stat = await fs.stat(args[1]).catch(() => null)
  if (!stat?.isFile() || stat.size > MAX_PROFILE) throw failure('invalid_profile')
  const profile = parseProfile(await fs.readFile(args[1], 'utf8'))
  const config = configuration(env)
  const directory = path.join(config.directory, 'pursuit', profile.goalId)
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  const statePath = path.join(directory, 'state.json')
  const notebookPath = path.join(directory, 'notebook.json')
  const stopPath = path.join(directory, 'STOP')
  const evidence = evidenceWriter({ file: path.join(directory, 'evidence.jsonl'), runId: profile.runId, goalId: profile.goalId, session: config.session, ...(deps.writeEvidence ? { write: deps.writeEvidence } : {}) })

  const rcon = deps.rcon ?? new Rcon(config.port, config.password, 5000, { host: config.host })
  const bridge = deps.bridge ?? new NativeBridge({ rcon, session: config.session })
  const runtime = deps.runtime ?? await openRuntime({ bridge, directory: config.directory, session: config.session })
  const controller = new AbortController()
  let stopCause
  const stop = cause => { stopCause ??= typeof cause === 'string' ? cause : 'signal'; controller.abort() }
  const wall = setTimeout(() => stop('wall_cap'), profile.wallCapMs)
  const stopPoll = setInterval(async () => {
    const request = await readJson(stopPath).catch(() => undefined)
    if (request?.goalId === profile.goalId && request?.session === config.session) stop('stop_request')
  }, deps.stopPollMs ?? 2000)
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  let result
  try {
    if (!deps.rcon) await rcon.connect()
    await runtime.context() // Refuse a wrong world/session before any model call.
    const state = await readJson(statePath) ?? createPursuitState()
    const store = new AgentNotebookStore()
    store.restore(await readJson(notebookPath))
    const notebook = storeNotebook({ store, world: worldIdForSession(config.session), npc: 'sgluna', goal: profile.goalId, persist: snapshot => writeJsonAtomic(notebookPath, snapshot) })
    const complete = deps.complete ?? createOperatorCompletion({ base: config.providerBase, key: config.providerKey, model: profile.model,
      cacheSystemPrompt: profile.cacheSystemPrompt === true, ...(profile.maxTokens ? { maxTokens: profile.maxTokens } : {}) })
    await evidence.record({ type: 'pursuit_started', model: profile.model, wall_cap_ms: profile.wallCapMs, goal: profile.goal, resumed: state.requests > 0 })
    result = await runPursuitGoal({ goal: profile.goal, command: text => rcon.command(text), complete, tools: createInProcessOperatorTools({ runtime }), notebook,
      brief: profile.brief, state, options: profile.options ?? {}, signal: controller.signal, onEvent: event => { evidence.record(event) },
      saveState: value => writeJsonAtomic(statePath, value), ...(deps.evaluate ? { evaluate: deps.evaluate } : {}) })
  }
  finally {
    clearTimeout(wall)
    clearInterval(stopPoll)
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await evidence.flush().catch(() => {})
    await runtime.close?.()
    if (!deps.rcon) rcon.close()
  }
  const report = { stopped: true, goalId: profile.goalId, session: config.session, outcome: result.outcome, stop_cause: stopCause ?? null }
  await evidence.record({ type: 'controller_stop', ...report })
  await evidence.flush()
  ;(deps.stdout ?? process.stdout).write(`${JSON.stringify(report)}\n`)
  return report
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = typeof error?.code === 'string' && /^[a-z_]{1,80}$/.test(error.code) ? error.code : 'startup_or_transport_failed'
    process.stderr.write(`Pursuit mode stopped: ${code}. No gameplay was replayed or cancelled.\n`)
    process.exitCode = 1
  })
}
