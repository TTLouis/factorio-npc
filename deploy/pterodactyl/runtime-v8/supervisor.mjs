import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

import {
  atomicWrite,
  Child,
  Rcon,
  chatAuthorized,
  check,
  cleanString,
  describeChatPlayers,
  describeRelease,
  DeploymentError,
  directory,
  freeTcpPort,
  hashFile,
  nonce,
  parseChatPlayers,
  readJson,
  redact,
  regularFile,
  reserveBudget,
  safeInteger,
  withTimeout,
} from './common.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { createSave, prepareGameConfig, prepareMods, prepareServerSettings, selectSave } from './game-files.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { decisionProviderConfiguration, decisionProviderRequest, providerEndpoint, providerRequest } from './provider.mjs'
import { configureNpcSession } from './supervisor-adapter.mjs'
import { luaString } from './structured-policy.mjs'

const UI_CONTROL_MARKER = '[AIRI_UI_CONTROL]'
const UI_CONTROL_ACTIONS = new Set(['pause', 'terminate', 'follow', 'stop_follow', 'new_task', 'keep_paused', 'revise', 'cancel'])
const UI_PROMPT_MARKER = '[AIRI_UI_PROMPT]'
const UI_PROMPT_MAX_CHARS = 4000
const UI_INPUT_POLL_MS = 250
const UI_HEARTBEAT_MS = 2000
const UI_SNAPSHOT_MAX_BYTES = 15360
const UI_FAILURE_LOG_INTERVAL_MS = 60000
const SYSTEM_RECOVERY_PAUSE_REASONS = new Set(['npc_identity_or_session_changed', 'actor_replaced'])
const UI_AGENT_PHASES = new Set(['idle', 'thinking', 'observing', 'executing', 'waiting', 'error'])
const UI_LIVE_ACTIVITY_LIMIT = 14
const UI_ACTIVITY_LIMIT = 18
const UI_CONVERSATION_LIMIT = 64
const UI_SYNC_BATCH_MS = 50
const UI_STALE_THINKING_MS = 5000

const RUNTIME_RELIABILITY_GUIDANCE = `
## Runtime reliability additions

For a multi-technology goal, use getResearchPath on the exact target instead of reconstructing the prerequisite graph from remembered Factorio knowledge. Follow its dependency-first pending_path and next_actionable entry. Trigger technologies require the exact returned research_trigger; science technologies use research_technology and still require verification after submission.

getTechnology returns an exact research_trigger object for gameplay-trigger technologies when Factorio exposes one. Use the returned trigger fields such as item/count, entity, or fluid/amount; do not guess a trigger from remembered Factorio knowledge. After performing an exact gameplay trigger, re-read getTechnology. If it is still incomplete, re-observe the trigger/state or report a blocker instead of repeatedly waiting and hoping the trigger registers.

When a task resembles a common gameplay, bootstrap, production, or logistics pattern and the strategy is uncertain, use findSkills with a short description of the actual goal, then getSkillDetails for at most one promising match. Treat skill content as reusable experienced-player guidance, not live-world truth or mutation authority. Validate recipe, prototype, inventory, geometry, placement, and mutable world facts with the appropriate live tools before acting. Once a useful pattern and enough current evidence are available, commit the next executable plan instead of repeatedly searching skills or making unrelated observations.

Natural navigation obstacle clearing is controlled deterministically by the runtime. It is enabled by default for trees and natural rocks only, and is disabled for a request when the human explicitly asks AIRI not to cut trees, mine rocks, or auto-clear obstacles. Never reinterpret this as permission to remove player-built structures.
`.trim()

function hasEnv(env, key) {
  return Object.prototype.hasOwnProperty.call(env, key)
}

function preferredEnv(env, primary, compatibility, fallback) {
  if (hasEnv(env, primary)) return env[primary]
  if (hasEnv(env, compatibility)) return env[compatibility]
  return fallback
}

function chatPlayersValue(env, raw = {}, fallback = '') {
  if (hasEnv(env, 'SGLUNA_CHAT_PLAYERS')) return env.SGLUNA_CHAT_PLAYERS
  if (hasEnv(env, 'AIRI_CHAT_PLAYERS')) return env.AIRI_CHAT_PLAYERS
  if (hasEnv(env, 'AIRI_CHAT_PLAYER')) return env.AIRI_CHAT_PLAYER
  if (hasEnv(env, 'AIRI_PLAYER')) return env.AIRI_PLAYER
  return raw.chatPlayers ?? raw.chatPlayer ?? raw.player ?? fallback
}

function providerProfileValue(env, raw = {}, fallback = 'auto') {
  const value = cleanString(env.PROVIDER_PROFILE ?? raw.providerProfile ?? fallback, 'PROVIDER_PROFILE', 40).toLowerCase()
  check(['auto', 'generic', 'deepseek', 'openai-reasoning'].includes(value), 'PROVIDER_PROFILE must be auto, generic, deepseek, or openai-reasoning')
  return value
}

export function deploymentCompatibilityWarnings(env = process.env) {
  const warnings = []
  for (const [primary, compatibility] of [
    ['SGLUNA_ACTOR_MODE', 'AIRI_ACTOR_MODE'],
    ['SGLUNA_CHAT_PLAYERS', 'AIRI_CHAT_PLAYERS'],
  ]) {
    if (!hasEnv(env, primary) || !hasEnv(env, compatibility)) continue
    const preferred = String(env[primary] ?? '')
    const legacy = String(env[compatibility] ?? '')
    if (preferred && legacy && preferred !== legacy) warnings.push(`${primary} overrides conflicting compatibility value ${compatibility}.`)
  }
  return warnings
}

export function configuration(raw = {}, env = process.env) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'sgluna-config.json must be an object')
  const actorMode = preferredEnv(env, 'SGLUNA_ACTOR_MODE', 'AIRI_ACTOR_MODE', raw.actorMode ?? 'npc')
  check(actorMode === 'npc', 'This v8 egg currently supports SGLUNA_ACTOR_MODE=npc only')

  const chatPlayersSource = chatPlayersValue(env, raw, 'none')

  const factorioUsername = cleanString(env.FACTORIO_USERNAME ?? '', 'FACTORIO_USERNAME', 128)
  const factorioToken = cleanString(env.FACTORIO_TOKEN ?? '', 'FACTORIO_TOKEN', 128)
  check((factorioUsername === '') === (factorioToken === ''), 'FACTORIO_USERNAME and FACTORIO_TOKEN must both be set or both left blank')

  const config = {
    actorMode,
    chatPlayers: parseChatPlayers(cleanString(chatPlayersSource, 'SGLUNA_CHAT_PLAYERS', 512)),
    save: cleanString(env.SAVE_NAME ?? raw.save ?? '', 'SAVE_NAME', 160),
    model: cleanString(env.OPENAI_MODEL ?? raw.model ?? 'replace-me', 'OPENAI_MODEL', 200),
    base: env.OPENAI_API_BASEURL ?? raw.providerUrl ?? 'https://provider.invalid/v1',
    profile: providerProfileValue(env, raw, 'auto'),
    key: env.OPENAI_API_KEY ?? '',
    decisionProvider: decisionProviderConfiguration(env),
    providerTimeoutMs: safeInteger(env.PROVIDER_TIMEOUT_MS ?? raw.providerTimeoutMs ?? 120000, 'PROVIDER_TIMEOUT_MS', 1000, 600000),
    gamePort: safeInteger(env.SERVER_PORT ?? raw.gamePort ?? 34197, 'SERVER_PORT', 1024, 65535),
    budget: safeInteger(env.MAX_PROVIDER_REQUESTS_PER_HOUR ?? raw.maxProviderRequestsPerHour ?? 30, 'MAX_PROVIDER_REQUESTS_PER_HOUR', 1, 1200),
    maxProviderOutputUnits: safeInteger(env.MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN ?? raw.maxProviderOutputTokensPerTurn ?? 20000, 'MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN', 1000, 200000),
    stopMs: safeInteger(env.SHUTDOWN_TIMEOUT_MS ?? raw.shutdownTimeoutMs ?? 60000, 'SHUTDOWN_TIMEOUT_MS', 1000, 300000),
    factorio: {
      username: factorioUsername,
      token: factorioToken,
      public: factorioUsername !== '' && factorioToken !== '',
    },
  }
  check(typeof config.key === 'string' && config.key.trim().length > 0 && !/[\r\n\0]/.test(config.key), 'OPENAI_API_KEY is missing or malformed')
  providerEndpoint(config.base)
  return config
}

// Docker normally keeps the generated RCON listener private inside the
// container.  This opt-in configuration exists for local integration tests;
// callers must still publish the port explicitly in their Compose override.
export function rconConfiguration(env = process.env) {
  const requestedPort = String(env.SGLUNA_RCON_PORT ?? '').trim()
  const port = requestedPort === '' ? null : safeInteger(requestedPort, 'SGLUNA_RCON_PORT', 1024, 65535)
  const bind = cleanString(env.SGLUNA_RCON_BIND ?? '127.0.0.1', 'SGLUNA_RCON_BIND', 15)
  check(bind === '127.0.0.1' || bind === '0.0.0.0', 'SGLUNA_RCON_BIND must be 127.0.0.1 or 0.0.0.0')
  const suppliedPassword = String(env.SGLUNA_RCON_PASSWORD ?? '')
  const password = suppliedPassword === ''
    ? nonce() + nonce()
    : cleanString(suppliedPassword, 'SGLUNA_RCON_PASSWORD', 256)
  return { port, bind, password }
}

export function factorioVisibilityDiagnostics(factorio = { username: '', token: '', public: false }, chatPlayers = { mode: 'disabled', names: [] }) {
  if (factorio?.public === true) {
    const diagnostics = ['Factorio visibility: PUBLIC']
    if (chatPlayers?.mode === 'all') {
      diagnostics.push('SECURITY WARNING: public Factorio listing with chat=all allows every player to issue !luna/!airi commands; configure SGLUNA_CHAT_PLAYERS=none or an explicit allowlist.')
    }
    return diagnostics
  }
  return ['Factorio visibility: PRIVATE/HIDDEN', 'No Factorio listing credentials supplied']
}

export const SGLUNA_CONFIG_DEFAULTS = {
  actorMode: 'npc',
  chatPlayers: 'none',
  providerUrl: 'https://provider.invalid/v1',
  providerProfile: 'auto',
  model: 'replace-me',
  save: '',
  providerTimeoutMs: 120000,
  gamePort: 34197,
  maxProviderRequestsPerHour: 30,
  maxProviderOutputTokensPerTurn: 20000,
  shutdownTimeoutMs: 60000,
}

export const AIRI_CONFIG_DEFAULTS = SGLUNA_CONFIG_DEFAULTS

export function migrateConfig(raw = {}, env = process.env) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'sgluna-config.json must be an object')
  const actorMode = cleanString(
    preferredEnv(env, 'SGLUNA_ACTOR_MODE', 'AIRI_ACTOR_MODE', raw.actorMode ?? SGLUNA_CONFIG_DEFAULTS.actorMode),
    'SGLUNA_ACTOR_MODE',
    32,
  )
  check(actorMode === 'npc', 'This v8 egg currently supports SGLUNA_ACTOR_MODE=npc only')
  const chatPlayers = cleanString(chatPlayersValue(env, raw, SGLUNA_CONFIG_DEFAULTS.chatPlayers), 'SGLUNA_CHAT_PLAYERS', 512)
  const next = {
    actorMode,
    chatPlayers,
    providerUrl: env.OPENAI_API_BASEURL ?? raw.providerUrl ?? SGLUNA_CONFIG_DEFAULTS.providerUrl,
    providerProfile: providerProfileValue(env, raw, SGLUNA_CONFIG_DEFAULTS.providerProfile),
    model: cleanString(env.OPENAI_MODEL ?? raw.model ?? SGLUNA_CONFIG_DEFAULTS.model, 'OPENAI_MODEL', 200),
    save: cleanString(env.SAVE_NAME ?? raw.save ?? SGLUNA_CONFIG_DEFAULTS.save, 'SAVE_NAME', 160),
    providerTimeoutMs: safeInteger(
      env.PROVIDER_TIMEOUT_MS ?? raw.providerTimeoutMs ?? SGLUNA_CONFIG_DEFAULTS.providerTimeoutMs,
      'PROVIDER_TIMEOUT_MS',
      1000,
      600000,
    ),
    gamePort: safeInteger(env.SERVER_PORT ?? raw.gamePort ?? SGLUNA_CONFIG_DEFAULTS.gamePort, 'SERVER_PORT', 1024, 65535),
    maxProviderRequestsPerHour: safeInteger(
      env.MAX_PROVIDER_REQUESTS_PER_HOUR ?? raw.maxProviderRequestsPerHour ?? SGLUNA_CONFIG_DEFAULTS.maxProviderRequestsPerHour,
      'MAX_PROVIDER_REQUESTS_PER_HOUR',
      1,
      1200,
    ),
    maxProviderOutputTokensPerTurn: safeInteger(
      env.MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN ?? raw.maxProviderOutputTokensPerTurn ?? SGLUNA_CONFIG_DEFAULTS.maxProviderOutputTokensPerTurn,
      'MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN',
      1000,
      200000,
    ),
    shutdownTimeoutMs: safeInteger(
      env.SHUTDOWN_TIMEOUT_MS ?? raw.shutdownTimeoutMs ?? SGLUNA_CONFIG_DEFAULTS.shutdownTimeoutMs,
      'SHUTDOWN_TIMEOUT_MS',
      1000,
      300000,
    ),
  }
  providerEndpoint(next.providerUrl)
  return next
}

export async function migrateConfigFile(filename, env = process.env) {
  const raw = await readJson(filename, {})
  const next = migrateConfig(raw, env)
  if (JSON.stringify(next) !== JSON.stringify(raw)) await atomicWrite(filename, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

async function pathExists(filename) {
  try { await fsp.access(filename); return true }
  catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

export async function migrateCanonicalConfig(root, env = process.env) {
  const canonical = path.join(root, 'sgluna-config.json')
  const legacy = path.join(root, 'airi-config.json')
  const canonicalExists = await pathExists(canonical)
  const legacyExists = await pathExists(legacy)
  const raw = canonicalExists ? await readJson(canonical, {}) : legacyExists ? await readJson(legacy, {}) : {}
  const config = migrateConfig(raw, env)
  const expected = `${JSON.stringify(config, null, 2)}\n`
  let current = null
  try { current = await fsp.readFile(canonical, 'utf8') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  if (current !== expected) await atomicWrite(canonical, expected)
  return { config, filename: canonical, migratedFromLegacy: !canonicalExists && legacyExists, legacy }
}

export function installedAppRoot(moduleUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..', '..')
}

export function routeNpcRequest(text, npcName = '') {
  const trimmed = String(text ?? '').trim()
  if (!trimmed || !npcName) return trimmed
  const separator = trimmed.indexOf(' ')
  if (separator < 0) return trimmed
  const candidate = trimmed.slice(0, separator)
  if (candidate.localeCompare(npcName, undefined, { sensitivity: 'accent' }) !== 0) return trimmed
  return trimmed.slice(separator + 1).trim()
}

export function navigationObstaclePolicy(text) {
  const normalized = String(text ?? '').trim().toLocaleLowerCase()
  const denyPhrases = [
    '不要自动清障', '不要清障', '别清障', '不要砍树', '别砍树', '不要自动砍树', '不要挖树',
    '不要挖石头', '别挖石头', '不要挖岩石', '不要破坏树', '不要破坏树木',
    "don't clear obstacles", 'do not clear obstacles', 'no automatic obstacle clearing',
    "don't cut trees", 'do not cut trees', "don't mine rocks", 'do not mine rocks',
    'preserve trees', 'leave the trees alone',
  ]
  const denied = denyPhrases.some(phrase => normalized.includes(phrase))
  if (denied) return { shouldUpdate: true, clearObstacles: false }

  const continuation = ['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做']
    .some(prefix => normalized === prefix || normalized.startsWith(`${prefix} `) || normalized.startsWith(`${prefix}，`) || normalized.startsWith(`${prefix},`))
  if (continuation) return { shouldUpdate: false, clearObstacles: true }
  return { shouldUpdate: true, clearObstacles: true }
}

function uiText(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

const UI_TASK_BLOCKER_SUMMARIES = new Map([
  ['no_autorio_operation_for_remaining_plan', 'AIRI has more work planned, but did not start the next action.'],
  ['operation_admission_failed', 'The game did not accept AIRI’s next action, so it did not start.'],
  ['provider_recovery_exhausted', 'AIRI could not get a usable model response after retrying.'],
  ['unverified_transfer_step', 'AIRI cannot continue until the transfer step is verified.'],
  ['placement_collision', 'AIRI cannot place the planned entity at the current location.'],
])
const UI_TASK_PAUSE_SUMMARIES = new Map([
  ['player_requested', 'AIRI was paused by the player.'],
  ['npc_identity_or_session_changed', 'AIRI paused because the active NPC session changed.'],
  ['actor_replaced', 'AIRI paused because the controlled NPC was replaced.'],
  ['follow_mode', 'AIRI paused the current task while following a player.'],
])

function requestFailurePauseSummary(raw) {
  if (raw.startsWith('provider_output_budget_exhausted:')) {
    return 'AIRI paused because the model exhausted its response budget while no Autorio work was running. Continue to retry from the verified task state.'
  }
  if (raw.startsWith('request_failed:')) {
    return 'AIRI paused because the model request failed while no Autorio work was running. Continue to retry from the verified task state.'
  }
  return ''
}

export function formatTaskCondition(value, kind = 'blocker') {
  const raw = uiText(value, kind === 'pause' ? 300 : 500)
  if (!raw) return { raw: '', summary: '' }

  if (kind === 'pause') {
    if (raw.startsWith('provider_recovery_exhausted:')) {
      return { raw, summary: 'AIRI could not get a usable model response after retrying.' }
    }
    if (raw.startsWith('server_stop_')) {
      return { raw, summary: 'AIRI paused because the server is stopping.' }
    }
    const requestFailure = requestFailurePauseSummary(raw)
    if (requestFailure) return { raw, summary: requestFailure }
    return {
      raw,
      summary: UI_TASK_PAUSE_SUMMARIES.get(raw) ?? 'AIRI is paused by an internal task condition.',
    }
  }

  if (raw === 'operation_preflight_failed:stale_exact_target') {
    return { raw, summary: 'AIRI’s saved entity target is no longer current and must be observed again.' }
  }
  if (raw === 'operation_preflight_failed:bootstrap_dependency_unresolved') {
    return { raw, summary: 'AIRI cannot start the next action until a required bootstrap dependency is available.' }
  }
  if (raw.startsWith('operation_preflight_failed:')) {
    return { raw, summary: 'AIRI’s next action failed a preflight check before it could start.' }
  }
  return {
    raw,
    summary: UI_TASK_BLOCKER_SUMMARIES.get(raw) ?? 'AIRI is blocked by an internal task condition.',
  }
}

function exactUiObjectKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => allowed.includes(key))
}

export function parseUiControlLine(line) {
  const input = String(line ?? '')
  if (!input.includes(UI_CONTROL_MARKER) || input.includes('[CHAT]')) return undefined
  const marker = input.lastIndexOf(UI_CONTROL_MARKER)
  const raw = input.slice(marker + UI_CONTROL_MARKER.length).trim()
  if (!raw || raw.length > 1024) return undefined
  let value
  try { value = JSON.parse(raw) }
  catch { return undefined }
  if (!exactUiObjectKeys(value, ['version', 'action', 'player_index', 'player_name', 'tick'])) return undefined
  if (value.version !== 1 || !UI_CONTROL_ACTIONS.has(value.action)) return undefined
  if (!Number.isSafeInteger(value.player_index) || value.player_index < 1 || value.player_index > 1_000_000) return undefined
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) return undefined
  if (typeof value.player_name !== 'string' || value.player_name.length < 1 || value.player_name.length > 128 || /[\x00-\x1f\x7f]/.test(value.player_name)) return undefined
  return {
    version: 1,
    action: value.action,
    player_index: value.player_index,
    player_name: value.player_name,
    tick: value.tick,
  }
}

export function parseUiPromptLine(line) {
  const input = String(line ?? '')
  if (!input.includes(UI_PROMPT_MARKER) || input.includes('[CHAT]')) return undefined
  const marker = input.lastIndexOf(UI_PROMPT_MARKER)
  const raw = input.slice(marker + UI_PROMPT_MARKER.length).trim()
  if (!raw || raw.length > 16384) return undefined
  let value
  try { value = JSON.parse(raw) }
  catch { return undefined }
  if (!exactUiObjectKeys(value, ['version', 'player_index', 'player_name', 'text', 'tick'])) return undefined
  if (value.version !== 1) return undefined
  if (!Number.isSafeInteger(value.player_index) || value.player_index < 1 || value.player_index > 1_000_000) return undefined
  if (!Number.isSafeInteger(value.tick) || value.tick < 0) return undefined
  if (typeof value.player_name !== 'string' || value.player_name.length < 1 || value.player_name.length > 128 || /[\x00-\x1f\x7f]/.test(value.player_name)) return undefined
  if (typeof value.text !== 'string') return undefined
  const text = value.text.trim()
  if (text.length < 1 || text.length > UI_PROMPT_MAX_CHARS || /[\x00-\x1f\x7f]/.test(text)) return undefined
  return {
    version: 1,
    player_index: value.player_index,
    player_name: value.player_name,
    text,
    tick: value.tick,
  }
}

export function parseUiInputBatch(raw) {
  let values
  try { values = JSON.parse(String(raw ?? '').trim()) }
  catch { return [] }
  if (!Array.isArray(values)) return []
  const parsed = []
  for (const value of values.slice(0, 32)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const { kind, ...payload } = value
    if (kind === 'control') {
      const event = parseUiControlLine(`${UI_CONTROL_MARKER} ${JSON.stringify(payload)}`)
      if (event) parsed.push({ kind: 'control', ...event })
      continue
    }
    if (kind === 'prompt') {
      const event = parseUiPromptLine(`${UI_PROMPT_MARKER} ${JSON.stringify(payload)}`)
      if (event) parsed.push({ kind: 'prompt', ...event })
      continue
    }
    if (kind === 'poll') {
      if (!exactUiObjectKeys(payload, ['version', 'tick'])) continue
      if (payload.version !== 1) continue
      if (!Number.isSafeInteger(payload.tick) || payload.tick < 0) continue
      parsed.push({ kind: 'poll', tick: payload.tick })
    }
  }
  return parsed
}

function parseStoredOperation(value) {
  if (typeof value !== 'string') return undefined
  const separator = value.indexOf(' ')
  if (separator < 1) return undefined
  const name = value.slice(0, separator)
  let args
  try { args = JSON.parse(value.slice(separator + 1)) }
  catch { return undefined }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  return { name, args }
}

function wantedCandidate(operation) {
  const { name, args } = operation
  if (name === 'place_entity' && typeof args.entity_name === 'string') {
    return { name: args.entity_name, count: 1, reason: 'planned placement' }
  }
  if (name === 'craft_item' && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.count) && args.count > 0 ? args.count : 1, reason: 'planned craft' }
  }
  if (['equip_weapon', 'equip_ammo', 'equip_armor'].includes(name) && typeof args.item_name === 'string') {
    return { name: args.item_name, count: 1, reason: 'planned equipment' }
  }
  if ((name === 'move_items' || name === 'move_items_exact') && args.to_entity === false && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.max_count) && args.max_count > 0 ? args.max_count : 1, reason: 'planned pickup' }
  }
  if (name === 'move_items_with_player' && args.to_player === false && typeof args.item_name === 'string') {
    return { name: args.item_name, count: Number.isSafeInteger(args.max_count) && args.max_count > 0 ? args.max_count : 1, reason: 'requested from player' }
  }
  return undefined
}

export function deriveWantedItems(state) {
  const byName = new Map()
  for (const raw of Array.isArray(state?.last_operations) ? state.last_operations.slice(-16) : []) {
    const operation = parseStoredOperation(raw)
    const candidate = operation ? wantedCandidate(operation) : undefined
    if (!candidate) continue
    candidate.name = uiText(candidate.name, 200)
    if (!candidate.name) continue
    const previous = byName.get(candidate.name)
    if (!previous || candidate.count > previous.count) byName.set(candidate.name, candidate)
  }
  return [...byName.values()].slice(0, 16)
}

function activityKindFromEvidence(kind) {
  if (/error|failed|blocked/i.test(kind)) return 'blocker'
  if (/receipt|result|completed|verification/i.test(kind)) return 'result'
  return 'observation'
}

export function evidenceText(item) {
  const summary = uiText(item?.summary, 1000)
  if (!summary.startsWith('{')) return summary
  let parsed
  try { parsed = JSON.parse(item.summary) }
  catch { return summary }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return summary
  const batch = Number.isSafeInteger(parsed.batch_id) ? `batch ${parsed.batch_id}` : 'batch'
  if (item?.kind === 'deterministic_verification') {
    const operations = Array.isArray(parsed.operations) && parsed.operations.length > 0 ? ` (${parsed.operations.join(', ')})` : ''
    return uiText(`Verified ${batch} complete${operations}`, 1000)
  }
  if (/receipt/i.test(String(item?.kind ?? ''))) {
    const count = Number.isSafeInteger(parsed.task_count) ? `${parsed.task_count} task(s)` : 'tasks'
    const types = Array.isArray(parsed.task_types) && parsed.task_types.length > 0 ? ` [${parsed.task_types.join(', ')}]` : ''
    const reason = parsed.reason ? ` — ${parsed.reason}` : ''
    return uiText(`Autorio ${batch} ${parsed.outcome ?? 'finished'}: ${count}${types}${reason}`, 1000)
  }
  return summary
}

function evidenceBatch(item) {
  try {
    const parsed = JSON.parse(String(item?.summary ?? ''))
    return Number.isSafeInteger(parsed?.batch_id) ? { id: parsed.batch_id, outcome: parsed.outcome } : undefined
  }
  catch { return undefined }
}

// A successful deterministic verification restates the completed receipt for the
// same batch. Look for receipts across all retained evidence, not only the
// displayed tail, so a verification cannot resurface once its receipt scrolls
// out of the window.
function completedReceiptBatches(evidence) {
  const batches = new Set()
  for (const item of evidence) {
    if (!/receipt/i.test(String(item?.kind ?? ''))) continue
    const batch = evidenceBatch(item)
    if (batch?.outcome === 'completed') batches.add(batch.id)
  }
  return batches
}

export function deriveActivity(state) {
  if (!state || typeof state !== 'object') return []
  const entries = []
  const allEvidence = Array.isArray(state.task_board?.evidence) ? state.task_board.evidence : []
  const receipted = completedReceiptBatches(allEvidence)
  for (const item of allEvidence.slice(-4)) {
    if (item?.kind === 'deterministic_verification' && receipted.has(evidenceBatch(item)?.id)) continue
    const summary = evidenceText(item)
    if (summary) entries.push({ kind: activityKindFromEvidence(uiText(item?.kind, 64)), text: summary })
  }
  const chat = uiText(state.last_chat_message, 1000)
  if (chat) entries.push({ kind: 'decision', text: chat })
  for (const operation of Array.isArray(state.last_operations) ? state.last_operations.slice(-6) : []) {
    const text = uiText(operation, 1000)
    if (text) entries.push({ kind: 'action', text })
  }
  const blocker = formatTaskCondition(state.blocker, 'blocker')
  if (blocker.raw) entries.push({ kind: 'blocker', text: blocker.summary })
  const pauseReason = formatTaskCondition(state.pause_reason, 'pause')
  // An exhausted provider recovery already reached the feed as the request's
  // failure, with the same message; the pause adds only its reason code.
  if (pauseReason.raw && !pauseReason.raw.startsWith('provider_recovery_exhausted:')) entries.push({ kind: 'system', text: pauseReason.summary })
  return entries.slice(-UI_ACTIVITY_LIMIT)
}

function debugInteger(value) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

function debugOptionalInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function debugOptionalText(value, max) {
  if (typeof value !== 'string') return undefined
  const text = uiText(value, max)
  return text || undefined
}

function debugStructuredContent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const jsonValid = typeof value.json_valid === 'boolean' ? value.json_valid : undefined
  const planValid = typeof value.plan_valid === 'boolean' ? value.plan_valid : undefined
  const error = debugOptionalText(value.error, 300)
  if (jsonValid === undefined && planValid === undefined && error === undefined) return undefined
  return {
    ...(jsonValid === undefined ? {} : { json_valid: jsonValid }),
    ...(planValid === undefined ? {} : { plan_valid: planValid }),
    ...(error === undefined ? {} : { error }),
  }
}

function emptyAgentDebug(fallback = {}) {
  return {
    request_id: uiText(fallback.request_id, 120),
    turn: debugInteger(fallback.turn),
    provider_model: uiText(fallback.provider_model, 160),
    provider_round: 0,
    provider_latency_ms: 0,
    provider_diagnostic_code: '',
    provider_finish_reason: '',
    provider_capability_profile: '',
    requested_token_field: '',
    requested_output_cap: 0,
    requested_reasoning_effort: '',
    requested_thinking_mode: '',
    reported_reasoning_tokens: 0,
    usage_complete: 0,
    cap_enforcement_anomaly: 0,
    reasoning_effort: '',
    reasoning_policy_reason: '',
    content_chars: 0,
    reasoning_content_chars: 0,
    input_units: 0,
    cached_input_units: 0,
    output_units: 0,
    total_units: 0,
    latest_round_provider_round: 0,
    latest_round_input_units: 0,
    latest_round_cached_input_units: 0,
    latest_round_output_units: 0,
    latest_round_total_units: 0,
    decision_provider: '',
    decision_model: '',
    decision_shadow_intent: '',
    decision_active_intent: '',
    decision_post_step_route: '',
    decision_post_step_applied_route: '',
    decision_post_step_confidence_percent: 0,
    decision_post_step_latency_ms: 0,
    decision_post_step_fallback: '',
    decision_scope_review: '',
    decision_scope_review_confidence_percent: 0,
    decision_scope_review_reason_codes: '',
    decision_scope_review_actionable_prefix: 0,
    decision_development: '',
    decision_development_confidence_percent: 0,
    decision_steering: '',
    decision_steering_confidence_percent: 0,
    decision_reasoning_budget: '',
    decision_reasoning_confidence_percent: 0,
    decision_planning_horizon: '',
    decision_observation_budget: 0,
    decision_confidence_percent: 0,
    decision_queue_conflict_percent: 0,
    decision_latency_ms: 0,
    decision_input_units: 0,
    decision_output_units: 0,
    decision_cost_micro_usd: 0,
    decision_calls_total: 0,
    decision_input_units_total: 0,
    decision_output_units_total: 0,
    decision_cost_micro_usd_total: 0,
    decision_shadow_matches_total: 0,
    decision_shadow_mismatches_total: 0,
    decision_post_step_calls_total: 0,
    decision_planner_skips_total: 0,
    decision_planner_wakes_total: 0,
    decision_planner_continue_low_wakes_total: 0,
    decision_planner_reanchor_low_wakes_total: 0,
    decision_planner_replan_high_wakes_total: 0,
    decision_planner_fallback_wakes_total: 0,
    decision_error: '',
    step_relation: '',
    step_checkpoint_boundary: '',
    step_admission_alignment: '',
    step_completion_contract: '',
    step_completion_status: '',
    step_completion_evidence: '',
    runtime_condition: '',
    runtime_condition_state: '',
    last_tool: '',
    last_event: '',
    recovery_attempt: 0,
    recovery_result: '',
    last_error: '',
    actor_id: debugInteger(fallback.actor_id),
    actor_epoch: debugInteger(fallback.actor_epoch),
  }
}

function decisionDebugFields(value = {}) {
  return {
    decision_provider: uiText(value.decision_provider, 80),
    decision_model: uiText(value.decision_model, 160),
    decision_shadow_intent: uiText(value.decision_shadow_intent, 80),
    decision_active_intent: uiText(value.decision_active_intent, 80),
    decision_post_step_route: uiText(value.decision_post_step_route, 80),
    decision_post_step_applied_route: uiText(value.decision_post_step_applied_route, 80),
    decision_post_step_confidence_percent: debugInteger(value.decision_post_step_confidence_percent),
    decision_post_step_latency_ms: debugInteger(value.decision_post_step_latency_ms),
    decision_post_step_fallback: uiText(value.decision_post_step_fallback, 300),
    decision_scope_review: uiText(value.decision_scope_review, 32),
    decision_scope_review_confidence_percent: debugInteger(value.decision_scope_review_confidence_percent),
    decision_scope_review_reason_codes: uiText(value.decision_scope_review_reason_codes, 300),
    decision_scope_review_actionable_prefix: debugInteger(value.decision_scope_review_actionable_prefix),
    decision_development: uiText(value.decision_development, 32),
    decision_development_confidence_percent: debugInteger(value.decision_development_confidence_percent),
    decision_steering: uiText(value.decision_steering, 32),
    decision_steering_confidence_percent: debugInteger(value.decision_steering_confidence_percent),
    decision_reasoning_budget: uiText(value.decision_reasoning_budget, 32),
    decision_reasoning_confidence_percent: debugInteger(value.decision_reasoning_confidence_percent),
    decision_planning_horizon: uiText(value.decision_planning_horizon, 32),
    decision_observation_budget: debugInteger(value.decision_observation_budget),
    decision_confidence_percent: debugInteger(value.decision_confidence_percent),
    decision_queue_conflict_percent: debugInteger(value.decision_queue_conflict_percent),
    decision_latency_ms: debugInteger(value.decision_latency_ms),
    decision_input_units: debugInteger(value.decision_input_units),
    decision_output_units: debugInteger(value.decision_output_units),
    decision_cost_micro_usd: debugInteger(value.decision_cost_micro_usd),
    decision_calls_total: debugInteger(value.decision_calls_total),
    decision_input_units_total: debugInteger(value.decision_input_units_total),
    decision_output_units_total: debugInteger(value.decision_output_units_total),
    decision_cost_micro_usd_total: debugInteger(value.decision_cost_micro_usd_total),
    decision_shadow_matches_total: debugInteger(value.decision_shadow_matches_total),
    decision_shadow_mismatches_total: debugInteger(value.decision_shadow_mismatches_total),
    decision_post_step_calls_total: debugInteger(value.decision_post_step_calls_total),
    decision_planner_skips_total: debugInteger(value.decision_planner_skips_total),
    decision_planner_wakes_total: debugInteger(value.decision_planner_wakes_total),
    decision_planner_continue_low_wakes_total: debugInteger(value.decision_planner_continue_low_wakes_total),
    decision_planner_reanchor_low_wakes_total: debugInteger(value.decision_planner_reanchor_low_wakes_total),
    decision_planner_replan_high_wakes_total: debugInteger(value.decision_planner_replan_high_wakes_total),
    decision_planner_fallback_wakes_total: debugInteger(value.decision_planner_fallback_wakes_total),
    decision_error: uiText(value.decision_error, 300),
  }
}

function decisionPercent(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1 ? Math.round(value * 100) : 0
}

function decisionMicroUsd(value) {
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 1_000_000) : 0
}

function applyDebugUsage(debug, usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return debug
  return {
    ...debug,
    input_units: debugInteger(usage.input_units),
    cached_input_units: debugInteger(usage.cached_input_units),
    output_units: debugInteger(usage.output_units),
    total_units: debugInteger(usage.total_units),
  }
}

function applyLatestRoundDebugUsage(debug, usage, round) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return debug
  return {
    ...debug,
    latest_round_provider_round: debugInteger(round),
    latest_round_input_units: debugInteger(usage.input_units),
    latest_round_cached_input_units: debugInteger(usage.cached_input_units),
    latest_round_output_units: debugInteger(usage.output_units),
    latest_round_total_units: debugInteger(usage.total_units),
  }
}

export function liveAgentDebugEvent(event, data = {}, previous = {}, fallback = {}) {
  const failure = data?.failure_snapshot && typeof data.failure_snapshot === 'object' ? data.failure_snapshot : undefined
  let debug = event === 'request.received'
    ? { ...emptyAgentDebug(fallback), ...decisionDebugFields(previous) }
    : { ...emptyAgentDebug(fallback), ...(previous && typeof previous === 'object' ? previous : {}) }

  debug.last_event = uiText(event, 120)
  debug.request_id = uiText(failure?.request_id ?? data?.request_id ?? fallback.request_id ?? debug.request_id, 120)
  debug.turn = debugInteger(failure?.turn ?? data?.turn ?? fallback.turn ?? debug.turn)
  debug.actor_id = debugInteger(failure?.actor_id ?? data?.actor_id ?? fallback.actor_id ?? debug.actor_id)
  debug.actor_epoch = debugInteger(failure?.epoch ?? data?.epoch ?? fallback.actor_epoch ?? debug.actor_epoch)

  const providerEvent = failure?.provider ?? (event === 'provider.response' ? data : undefined)
  const provider = providerEvent?.provider
  if (event === 'provider.request') {
    debug.provider_round = debugInteger(data.round)
    debug.recovery_attempt = debugInteger(data.recovery_attempt)
    // Keep diagnostics from the latest completed provider round visible while
    // the next round is in flight. This matches latest-round token semantics
    // and prevents tool/result driven UI refreshes from making policy fields
    // flash briefly and then disappear.
  }
  if (providerEvent && typeof providerEvent === 'object') {
    debug.provider_round = debugInteger(providerEvent.round ?? debug.provider_round)
    debug.provider_latency_ms = debugInteger(providerEvent.latency_ms ?? debug.provider_latency_ms)
    debug.recovery_attempt = debugInteger(providerEvent.recovery_attempt ?? debug.recovery_attempt)
    debug.provider_model = uiText(provider?.model ?? fallback.provider_model ?? debug.provider_model, 160)
    debug.provider_diagnostic_code = uiText(provider?.diagnostic_code ?? debug.provider_diagnostic_code, 160)
    debug.provider_finish_reason = uiText(provider?.finish_reason ?? debug.provider_finish_reason, 80)
    debug.provider_capability_profile = uiText(provider?.capability_profile ?? debug.provider_capability_profile, 40)
    debug.requested_token_field = uiText(provider?.requested_token_field ?? debug.requested_token_field, 40)
    debug.requested_output_cap = debugInteger(provider?.requested_output_cap ?? debug.requested_output_cap)
    debug.requested_reasoning_effort = uiText(provider?.requested_reasoning_effort ?? debug.requested_reasoning_effort, 32)
    debug.requested_thinking_mode = uiText(provider?.requested_thinking_mode ?? debug.requested_thinking_mode, 32)
    debug.reported_reasoning_tokens = debugInteger(provider?.reported_reasoning_tokens ?? debug.reported_reasoning_tokens)
    debug.usage_complete = provider?.usage_complete === true ? 1 : provider?.usage_complete === false ? 0 : debug.usage_complete
    debug.cap_enforcement_anomaly = provider?.cap_enforcement_anomaly === true ? 1 : 0
    debug.reasoning_effort = uiText(provider?.reasoning_effort ?? debug.reasoning_effort, 32)
    debug.reasoning_policy_reason = uiText(provider?.reasoning_policy_reason ?? debug.reasoning_policy_reason, 80)
    debug.response_id = debugOptionalText(provider?.response_id, 160)
    debug.response_bytes = debugOptionalInteger(provider?.response_bytes)
    debug.tool_call_count = debugOptionalInteger(provider?.tool_call_count)
    debug.content_utf8_bytes = debugOptionalInteger(provider?.content_utf8_bytes)
    debug.content_non_ascii_chars = debugOptionalInteger(provider?.content_non_ascii_chars)
    debug.content_replacement_chars = debugOptionalInteger(provider?.content_replacement_chars)
    debug.normalized_content_chars = debugOptionalInteger(provider?.normalized_content_chars)
    debug.structured_content = debugStructuredContent(provider?.structured_content)
    debug.content_chars = debugInteger(provider?.content_chars ?? debug.content_chars)
    debug.reasoning_content_chars = debugInteger(provider?.reasoning_content_chars ?? debug.reasoning_content_chars)
    const diagnostic = uiText(provider?.diagnostic_code, 160)
    if (diagnostic && diagnostic !== 'ok') {
      const finish = uiText(provider?.finish_reason, 80)
      debug.last_error = finish ? `${diagnostic} · finish=${finish}` : diagnostic
    }
  }
  else if (!debug.provider_model) {
    debug.provider_model = uiText(fallback.provider_model ?? debug.provider_model, 160)
  }

  if (event === 'provider.output_budget_recovery_started') debug.recovery_result = 'started'
  if (event === 'provider.output_budget_recovery_succeeded') debug.recovery_result = 'succeeded'
  if (event === 'provider.output_budget_recovery_exhausted') debug.recovery_result = 'exhausted_again'
  if (event === 'provider.output_budget_recovery_failed' && debug.recovery_result !== 'budget_rejected') debug.recovery_result = 'failed'
  if (event === 'budget.rejected' && data?.recovery_kind === 'output_budget_exhaustion') debug.recovery_result = 'budget_rejected'
  if (event === 'provider.response' && data?.recovery_kind === 'output_budget_exhaustion') {
    const recoveryDiagnostic = uiText(provider?.diagnostic_code, 160)
    debug.recovery_result = recoveryDiagnostic === 'provider_output_budget_exhausted' ? 'exhausted_again' : 'response_received'
  }

  // Request-cumulative usage comes from traceRequest/failure snapshots. A
  // provider.response carries usage for only that provider call, so keep it in
  // separate latest-round fields instead of letting the cumulative fallback
  // shadow (or overwrite) it.
  const cumulativeUsage = failure?.usage ?? fallback.usage
  debug = applyDebugUsage(debug, cumulativeUsage)
  if (event === 'provider.response') {
    debug = applyLatestRoundDebugUsage(debug, data?.usage ?? providerEvent?.usage, providerEvent?.round ?? data?.round)
  }

  if (event === 'interaction.routed') {
    const shadow = data?.decision_shadow && typeof data.decision_shadow === 'object' ? data.decision_shadow : undefined
    if (shadow) {
      debug.decision_provider = uiText(shadow.provider, 80)
      debug.decision_model = uiText(shadow.model, 160)
      debug.decision_shadow_intent = uiText(shadow.intent, 80)
      debug.decision_active_intent = uiText(data.intent, 80)
      debug.decision_confidence_percent = decisionPercent(shadow.intent_confidence)
      if (shadow.development) {
        debug.decision_development = uiText(shadow.development, 32)
        debug.decision_development_confidence_percent = decisionPercent(shadow.development_confidence)
      }
      debug.decision_queue_conflict_percent = decisionPercent(shadow.queue_conflict_probability)
      debug.decision_latency_ms = debugInteger(data.decision_shadow_latency_ms)
      const decisionInput = debugInteger(shadow.usage?.input_tokens)
      const decisionOutput = debugInteger(shadow.usage?.output_tokens)
      const decisionCost = decisionMicroUsd(shadow.usage?.cost)
      debug.decision_input_units = decisionInput
      debug.decision_output_units = decisionOutput
      debug.decision_cost_micro_usd = decisionCost
      debug.decision_calls_total = debugInteger(debug.decision_calls_total) + 1
      debug.decision_input_units_total = debugInteger(debug.decision_input_units_total) + decisionInput
      debug.decision_output_units_total = debugInteger(debug.decision_output_units_total) + decisionOutput
      debug.decision_cost_micro_usd_total = debugInteger(debug.decision_cost_micro_usd_total) + decisionCost
      if (shadow.intent === data.intent) debug.decision_shadow_matches_total = debugInteger(debug.decision_shadow_matches_total) + 1
      else debug.decision_shadow_mismatches_total = debugInteger(debug.decision_shadow_mismatches_total) + 1
      debug.decision_error = ''
    }
    const decisionError = uiText(data.decision_shadow_error, 300)
    if (decisionError) debug.decision_error = decisionError
  }

  if (event === 'post_step.routed') {
    debug.decision_post_step_calls_total = debugInteger(debug.decision_post_step_calls_total) + 1
    const decision = data?.decision && typeof data.decision === 'object' ? data.decision : undefined
    debug.decision_post_step_route = uiText(data.route, 80)
    debug.decision_post_step_applied_route = uiText(data.applied_route, 80)
    debug.decision_post_step_fallback = uiText(data.fallback_reason, 300)
    debug.decision_post_step_latency_ms = debugInteger(data.decision_latency_ms)
    if (decision) {
      debug.decision_provider = uiText(decision.provider, 80)
      debug.decision_model = uiText(decision.model, 160)
      debug.decision_post_step_confidence_percent = decisionPercent(decision.confidence)
      // Jev families after the planning refactor: a pre-commit scope review
      // (parseScopeReview) and advisory boundary steering
      // (parseSteeringRecommendation / parseBoundarySteeringTelemetry).
      const scopeReview = decision.scope_review && typeof decision.scope_review === 'object'
        ? decision.scope_review
        : undefined
      if (scopeReview) {
        debug.decision_scope_review = uiText(scopeReview.verdict, 32)
        debug.decision_scope_review_confidence_percent = decisionPercent(scopeReview.confidence)
        debug.decision_scope_review_reason_codes = uiText(
          (Array.isArray(scopeReview.reason_codes) ? scopeReview.reason_codes : []).join(','),
          300,
        )
        debug.decision_scope_review_actionable_prefix = debugInteger(scopeReview.actionable_prefix)
      }
      const steeringRecommendation = decision.steering && typeof decision.steering === 'object'
        ? decision.steering
        : undefined
      if (steeringRecommendation) {
        debug.decision_steering = uiText(steeringRecommendation.recommended_mode, 32)
        debug.decision_steering_confidence_percent = decisionPercent(steeringRecommendation.confidence)
      }
      const steering = decision.boundary_steering && typeof decision.boundary_steering === 'object'
        ? decision.boundary_steering
        : undefined
      if (steering) {
        debug.decision_development = uiText(steering.development, 32)
        debug.decision_development_confidence_percent = decisionPercent(steering.development_confidence)
        debug.decision_reasoning_budget = uiText(steering.reasoning_budget, 32)
        debug.decision_reasoning_confidence_percent = decisionPercent(steering.reasoning_confidence)
        debug.decision_planning_horizon = uiText(steering.planning_horizon, 32)
        debug.decision_observation_budget = debugInteger(steering.observation_budget)
      }
      const decisionInput = debugInteger(decision.usage?.input_tokens)
      const decisionOutput = debugInteger(decision.usage?.output_tokens)
      const decisionCost = decisionMicroUsd(decision.usage?.cost)
      debug.decision_input_units = decisionInput
      debug.decision_output_units = decisionOutput
      debug.decision_cost_micro_usd = decisionCost
      debug.decision_calls_total = debugInteger(debug.decision_calls_total) + 1
      debug.decision_input_units_total = debugInteger(debug.decision_input_units_total) + decisionInput
      debug.decision_output_units_total = debugInteger(debug.decision_output_units_total) + decisionOutput
      debug.decision_cost_micro_usd_total = debugInteger(debug.decision_cost_micro_usd_total) + decisionCost
      debug.decision_error = ''
    }
    if (debug.decision_post_step_fallback) debug.decision_error = debug.decision_post_step_fallback
  }

  if (event === 'planner.skipped' && data?.source === 'decision_provider') {
    debug.decision_planner_skips_total = debugInteger(debug.decision_planner_skips_total) + 1
  }
  if (event === 'planner.wake' && data?.source === 'decision_provider') {
    debug.decision_planner_wakes_total = debugInteger(debug.decision_planner_wakes_total) + 1
    if (data?.route === 'continue_current') {
      debug.decision_planner_continue_low_wakes_total = debugInteger(debug.decision_planner_continue_low_wakes_total) + 1
    }
    else if (data?.route === 'reanchor_plan') {
      debug.decision_planner_reanchor_low_wakes_total = debugInteger(debug.decision_planner_reanchor_low_wakes_total) + 1
    }
    else if (data?.route === 'replan') {
      debug.decision_planner_replan_high_wakes_total = debugInteger(debug.decision_planner_replan_high_wakes_total) + 1
    }
    else if (data?.route === 'fallback_planner') {
      debug.decision_planner_fallback_wakes_total = debugInteger(debug.decision_planner_fallback_wakes_total) + 1
    }
  }

  if (event === 'step.contract_created' || event === 'step.checkpoint_created') {
    const contract = data?.contract && typeof data.contract === 'object' ? data.contract : {}
    const kinds = Array.isArray(contract.requirements)
      ? contract.requirements.map(requirement => uiText(requirement?.kind, 60)).filter(Boolean).join('+')
      : ''
    debug.step_completion_contract = uiText(kinds || contract.mode || 'semantic_unknown', 200)
    debug.step_completion_status = contract.mode === 'semantic_unknown' ? 'unknown' : 'waiting'
    if (event === 'step.checkpoint_created') {
      debug.step_relation = uiText(data.relation, 80)
      debug.step_checkpoint_boundary = uiText(data.boundary, 80)
      debug.step_admission_alignment = ['advances_current', 'prerequisite_for_current'].includes(data.relation)
        ? 'aligned'
        : 'reanchor_required'
    }
  }
  if (event === 'operations.semantic_alignment_rejected') {
    debug.step_relation = uiText(data.relation, 80) || debug.step_relation
    debug.step_checkpoint_boundary = uiText(data.checkpoint_boundary, 80) || debug.step_checkpoint_boundary
    debug.step_admission_alignment = 'reanchor_required'
  }
  if (event === 'operations.admit' && debug.step_admission_alignment === 'aligned') {
    debug.step_admission_alignment = 'admitted'
  }
  if (event === 'step.completion_checked') {
    debug.step_completion_status = uiText(data.status, 80) || debug.step_completion_status
    debug.step_completion_evidence = uiText(JSON.stringify(data.evidence ?? []), 300)
  }
  if (event === 'step.completion_rejected') {
    debug.step_completion_status = uiText(data.reason, 120) || 'rejected'
  }
  if (event === 'step.verified') {
    debug.step_completion_status = 'verified'
    debug.step_completion_evidence = uiText(JSON.stringify(data.task_board ?? data.evidence ?? {}), 300)
  }
  if (event === 'runtime.condition_registered') {
    debug.runtime_condition = uiText(JSON.stringify(data.condition ?? {}), 300)
    debug.runtime_condition_state = 'active'
  }
  if (event === 'runtime.condition_waiting') debug.runtime_condition_state = 'active'
  if (event === 'runtime.condition_satisfied') debug.runtime_condition_state = 'satisfied'
  if (event === 'runtime.condition_timeout') debug.runtime_condition_state = 'timeout'
  if (event === 'runtime.condition_failed') debug.runtime_condition_state = 'failed'
  if (event === 'runtime.condition_progress_stopped') debug.runtime_condition_state = 'stopped'
  if (event === 'runtime.condition_stale') debug.runtime_condition_state = 'stale'

  if (event === 'tool.call' || event === 'tool.result') debug.last_tool = uiText(data.name, 120)
  if (event === 'actor.bound') {
    debug.actor_id = debugInteger(data.actor_id)
    debug.actor_epoch = debugInteger(data.epoch)
  }
  if (event === 'replan.started') {
    debug.recovery_attempt = debugInteger(data.attempt ?? debug.recovery_attempt)
    const reason = uiText(data.reason, 500)
    if (reason) debug.last_error = reason
  }
  if (event === 'provider.error') {
    const message = uiText(data.message, 500)
    if (message) debug.last_error = message
  }
  if (event === 'request.failed') {
    const message = uiText(failure?.message ?? data.message, 500)
    if (message) debug.last_error = message
    debug.recovery_attempt = debugInteger(failure?.recovery?.attempt ?? debug.recovery_attempt)
    const lastTool = failure?.last_tool
    if (lastTool?.name) debug.last_tool = uiText(lastTool.name, 120)
  }

  return debug
}

export function liveAgentEvent(event, data = {}) {
  const count = value => Array.isArray(value) ? value.length : 0
  switch (event) {
    case 'post_step.routed': {
      const requested = uiText(data.route, 80) || 'fallback_planner'
      const applied = uiText(data.applied_route, 80) || requested
      const decision = data?.decision && typeof data.decision === 'object' ? data.decision : undefined
      const confidence = decisionPercent(decision?.confidence)
      const fallback = uiText(data.fallback_reason, 160)
      return {
        activity: {
          kind: 'system',
          text: `Jev ACTIVE post-step: ${requested}${applied !== requested ? ` → ${applied}` : ''}${confidence > 0 ? ` · ${confidence}%` : ''}${fallback ? ` · fallback ${fallback}` : ''}`,
        },
      }
    }
    case 'interaction.routed': {
      const shadow = data?.decision_shadow && typeof data.decision_shadow === 'object' ? data.decision_shadow : undefined
      if (shadow) {
        const confidence = decisionPercent(shadow.intent_confidence)
        const match = shadow.intent === data.intent ? 'match' : `active ${uiText(data.intent, 80) || 'unknown'}`
        const input = debugInteger(shadow.usage?.input_tokens)
        const cost = decisionMicroUsd(shadow.usage?.cost)
        return {
          activity: {
            kind: 'system',
            text: `Jev shadow: ${uiText(shadow.intent, 80) || 'unknown'} · ${confidence}% · ${match} · ${debugInteger(data.decision_shadow_latency_ms)} ms${input > 0 ? ` · ${input} in` : ''}${cost > 0 ? ` · ${cost} µUSD` : ''}`,
          },
        }
      }
      const decisionError = uiText(data.decision_shadow_error, 200)
      return decisionError
        ? { activity: { kind: 'system', text: `Jev shadow unavailable: ${decisionError}` } }
        : undefined
    }
    case 'request.received':
      return {
        phase: 'thinking',
        detail: `Reading request from ${uiText(data.sender, 64) || 'player'}`,
        objective: uiText(data.text, 500),
        activity: { kind: 'observation', text: `${uiText(data.sender, 64) || 'Player'}: ${uiText(data.text, 300)}` },
      }
    case 'provider.request':
      return {
        phase: 'thinking',
        detail: data.recovery_attempt > 0
          ? `Recovering plan (attempt ${data.recovery_attempt})`
          : `Thinking (model round ${(Number.isSafeInteger(data.round) ? data.round : 0) + 1})`,
      }
    case 'tool.call':
      return {
        phase: 'observing',
        detail: `Checking ${uiText(data.name, 64)}`,
        activity: { kind: 'observation', text: `Tool ${uiText(data.name, 64)}${data.cached ? ' (cached)' : ''}` },
      }
    case 'plan.accepted': {
      const message = uiText(data.chat_message, 1000)
      return {
        phase: 'executing',
        detail: uiText(data.chat_message, 200) || 'Plan accepted',
        // chat_message is the public player-facing reply. Keep every non-empty
        // reply in the live activity stream regardless of whether this turn was
        // triggered by a new request, a failure, or an automatic continuation.
        // Current Task Conversation is projected from that retained stream.
        ...(message ? { activity: { kind: 'decision', text: message } } : {}),
      }
    }
    case 'operations.admit':
      return { phase: 'executing', detail: `Submitting ${count(data.operations)} operation(s) to Autorio` }
    case 'request.waiting':
      return { phase: 'waiting', detail: `Autorio is running ${data.operation_count ?? 0} operation(s)` }
    case 'request.completed':
      return { phase: 'idle', detail: 'Finished the last request' }
    case 'factorio.completed_signal':
      // With a durable plan the batch receipt says the same thing with detail, so
      // the snapshot drops this line; without one it is the only record.
      return { phase: 'thinking', detail: 'Batch finished; checking the result', activity: { kind: 'result', text: 'Autorio batch completed', covered_by_receipt: true } }
    case 'factorio.error_continuation':
      return { phase: 'thinking', detail: 'Autorio reported an error; replanning' }
    case 'replan.started':
      return { phase: 'thinking', detail: 'Recovering from an invalid model response', activity: { kind: 'system', text: `Replanning: ${uiText(data.reason, 200)}` } }
    case 'provider.error':
      if (data.cancelled) return { phase: 'idle', detail: 'Model request cancelled' }
      return { phase: 'error', detail: `Model request failed: ${uiText(data.message, 200)}`, activity: { kind: 'blocker', text: `Model request failed: ${uiText(data.message, 300)}` } }
    case 'request.failed':
      if (expectedCancellation(data.message)) return { phase: 'idle', detail: 'Request cancelled' }
      return { phase: 'error', detail: uiText(data.message, 200) || 'Request failed', activity: { kind: 'blocker', text: uiText(data.message, 300) || 'Request failed' } }
    case 'request.cancelled':
      return { phase: 'idle', detail: `Cancelled (${uiText(data.reason, 64) || 'cancelled'})` }
    case 'factorio.status':
      return { refresh: true }
    default:
      return undefined
  }
}

function uiActivityEntry(entry) {
  const { covered_by_receipt: _covered, ...rest } = entry
  return rest
}

export function taskBoardUiSnapshot(state, live) {
  const board = state?.task_board
  const agent = {
    phase: UI_AGENT_PHASES.has(live?.phase) ? live.phase : 'idle',
    detail: uiText(live?.detail, 300),
  }
  const debug = live?.debug && typeof live.debug === 'object' ? live.debug : emptyAgentDebug()
  const liveActivity = Array.isArray(live?.activity) ? live.activity : []
  const liveConversation = Array.isArray(live?.conversation) ? live.conversation.slice(-UI_CONVERSATION_LIMIT) : []
  const conversationId = uiText(live?.conversation_id, 120)
  if (!board || board.kind !== 'task_board_lite' || !Array.isArray(board.steps)) {
    if (!live || (agent.phase === 'idle' && liveActivity.length === 0 && liveConversation.length === 0)) return undefined
    return {
      goal_id: '',
      objective: uiText(live.objective, 500),
      project: undefined,
      status: 'idle',
      blocker: '',
      blocker_summary: '',
      pause_reason: '',
      pause_summary: '',
      completed_count: 0,
      total_steps: 0,
      active_index: 0,
      steps: [],
      activity: liveActivity.slice(-UI_ACTIVITY_LIMIT).map(uiActivityEntry),
      wanted_items: [],
      conversation_id: conversationId,
      conversation: liveConversation,
      agent,
      debug,
    }
  }
  const blocker = formatTaskCondition(board.blocker, 'blocker')
  const pauseReason = formatTaskCondition(board.pause_reason, 'pause')
  return {
    goal_id: String(board.goal_id ?? state.goal_id ?? '').slice(0, 100),
    objective: String(state.objective ?? '').slice(0, 500),
    plan: state?.planning?.plan,
    blocked: state?.planning?.blocked,
    status: board.status,
    blocker: blocker.raw,
    blocker_summary: blocker.summary,
    pause_reason: pauseReason.raw,
    pause_summary: pauseReason.summary,
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    steps: board.steps.slice(0, 30).map(step => ({
      id: String(step?.id ?? '').slice(0, 80),
      description: String(step?.description ?? '').slice(0, 500),
      status: step?.status,
    })),
    activity: [...deriveActivity(state), ...liveActivity.filter(entry => !entry.covered_by_receipt)].slice(-UI_ACTIVITY_LIMIT).map(uiActivityEntry),
    wanted_items: deriveWantedItems(state),
    conversation_id: conversationId,
    conversation: liveConversation,
    agent,
    debug,
  }
}

export function taskBoardUiJson(snapshot) {
  let candidate = snapshot
  let json = JSON.stringify(candidate)
  while (Buffer.byteLength(json) > UI_SNAPSHOT_MAX_BYTES && candidate.activity.length > 0) {
    candidate = { ...candidate, activity: candidate.activity.slice(1) }
    json = JSON.stringify(candidate)
  }
  for (const limit of [240, 120, 60]) {
    if (Buffer.byteLength(json) <= UI_SNAPSHOT_MAX_BYTES) break
    candidate = { ...candidate, steps: candidate.steps.map(step => ({ ...step, description: uiText(step.description, limit) })) }
    json = JSON.stringify(candidate)
  }
  // Conversation is a separate UI concern from model dialogue memory. Preserve
  // every retained turn before considering payload trimming; if a very long task
  // would exceed the RCON command ceiling, shorten message text rather than
  // dropping whole user/assistant turns from the visible task transcript.
  for (const limit of [1200, 800, 500, 300]) {
    if (Buffer.byteLength(json) <= UI_SNAPSHOT_MAX_BYTES) break
    candidate = { ...candidate, conversation: (candidate.conversation ?? []).map(message => ({ ...message, text: uiText(message.text, limit) })) }
    json = JSON.stringify(candidate)
  }
  return Buffer.byteLength(json) <= UI_SNAPSHOT_MAX_BYTES ? json : undefined
}

async function stopWorldWork(session) {
  await session.ensureAuthorization()
  await session.rcon.command('/silent-command remote.call("autorio_operations","stop_follow_player")')
  await session.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
}

async function pausePlanIfPresent(session, reason) {
  const state = session.currentPlanState?.()
  if (!state || state.status === 'completed' || state.status === 'paused') return state
  if (typeof session.agent?.pausePersistentPlan !== 'function') {
    session.agent?.cancel?.(reason)
    return state
  }
  return session.agent.pausePersistentPlan(reason)
}

function resetLiveTaskContext(session) {
  if (!session.agentLive || typeof session.agentLive !== 'object') return
  Object.assign(session.agentLive, {
    phase: 'idle',
    detail: '',
    objective: '',
    at: Date.now(),
    activity: [],
  })
  // Terminate and New Task are both boundaries for the *current* task
  // conversation. Terminate may retain bounded model dialogue memory internally,
  // but that retained memory belongs to history/continuity rather than the
  // Current Task Conversation panel.
  session.startNewUiConversation?.()
}

async function discardTaskContext(session, reason, { clearDialogue = false } = {}) {
  const agent = session.agent
  if (!agent) return undefined
  await agent.loadPersistentState?.()
  const key = typeof agent.activePlanKey === 'function' ? agent.activePlanKey() : `npc:${session.npcId ?? 'airi'}`

  // Cancellation is deliberately first: an in-flight provider response must not
  // race the destructive context update, and no new Autorio work may be admitted
  // while the server is clearing the durable slot.
  agent.cancel?.(reason)
  await stopWorldWork(session)

  const cleared = clearDialogue
    ? agent.memory?.clearTaskContext?.(key)
    : agent.memory?.terminatePlan?.(key)
  await agent.persistState?.()
  resetLiveTaskContext(session)
  // Both destructive lifecycle boundaries clear the current UI snapshot. Old
  // task/history data is retained by the history subsystem, and Terminate still
  // preserves bounded dialogue memory internally when clearDialogue is false.
  await session.clearTaskBoardUi()
  return cleared
}

function completedTaskResult(result) {
  return result?.goalStatus === 'completed' || result?.taskBoard?.status === 'completed'
}

export async function finalizeCompletedTaskBoundary(session, result) {
  if (!session?.agent || !completedTaskResult(result)) return false

  // Publish exactly one final completed snapshot before clearing the live slot.
  // This lets Old Tasks and learning consume the completed stages, evidence and
  // player-facing conversation instead of seeing the task simply disappear.
  const taskBoard = result?.taskBoard
  if (taskBoard?.status === 'completed') {
    const completedState = {
      goal_id: result?.goalId ?? taskBoard.goal_id ?? '',
      owner: session.agent?.requestInfo?.sender ?? '',
      objective: session.agentLive?.objective ?? '',
      status: 'completed',
      blocker: '',
      pause_reason: '',
      plan: [],
      current_step: 0,
      last_chat_message: result?.chatMessage ?? '',
      last_operations: [],
      task_board: taskBoard,
    }
    await session.syncTaskBoardUi(completedState)
  }

  await session.agent.finalizeCompletedTaskContext?.()
  resetLiveTaskContext(session)
  await session.clearTaskBoardUi()
  return true
}

export async function executeUiControl(session, event) {
  if (!session?.rcon || !session?.agent) return false

  const recordBlockedChoice = async (choice) => {
    const agent = session.agent
    const key = typeof agent.activePlanKey === 'function' ? agent.activePlanKey() : `npc:${session.npcId ?? 'airi'}`
    const state = agent.memory?.recordBlockedChoice?.(key, choice, event.player_name, { now: Date.now() })
    if (!state) return undefined
    await agent.persistState?.()
    return session.currentPlanState?.() ?? state
  }

  if (event.action === 'keep_paused') {
    // BLOCKED is already a durable freeze. Do not relabel it PAUSED or ask the
    // model to recover it; this is an explicit acknowledgement only.
    let state = session.currentPlanState?.()
    if (state?.status !== 'blocked') return false
    await stopWorldWork(session)
    state = await recordBlockedChoice('keep_paused') ?? state
    await session.syncTaskBoardUi(state)
    await session.printChat('Kept the blocked AIRI plan frozen. No replanning or world work will start until you explicitly revise it or cancel it.')
    return true
  }

  if (event.action === 'revise') {
    // A click opens the user-controlled revision path, but contains no goals
    // or constraints from which the runtime may fabricate a successor plan.
    let state = session.currentPlanState?.()
    if (state?.status !== 'blocked') return false
    await stopWorldWork(session)
    state = await recordBlockedChoice('revise') ?? state
    await session.syncTaskBoardUi(state)
    await session.printChat('The blocked plan remains frozen. Enter the revised goal or constraints in the Task Board prompt; AIRI will not replace this plan until you explicitly provide that revision.')
    return true
  }

  if (event.action === 'cancel') {
    // The control acknowledges the cancellation choice and makes the world
    // safe, but preserves the existing two-click TERMINATE confirmation for
    // irreversible durable-plan deletion.
    let state = session.currentPlanState?.()
    if (state?.status !== 'blocked') return false
    await stopWorldWork(session)
    state = await recordBlockedChoice('cancel') ?? state
    await session.syncTaskBoardUi(state)
    await session.printChat('Cancellation selected. The blocked plan remains frozen until you confirm TERMINATE in the Task Board.')
    return true
  }

  if (event.action === 'pause') {
    const state = await pausePlanIfPresent(session, 'ui_pause')
    await stopWorldWork(session)
    if (state) await session.syncTaskBoardUi(state)
    await session.printChat('Paused the current AIRI plan and stopped active work. Use continue/resume when you want it to continue.')
    return true
  }

  if (event.action === 'terminate') {
    await discardTaskContext(session, 'ui_terminate')
    await session.printChat('Terminated the current AIRI goal. Its durable plan was discarded and will not resume.')
    return true
  }

  if (event.action === 'new_task') {
    await discardTaskContext(session, 'ui_new_task', { clearDialogue: true })
    await session.printChat('Started a new task context for this NPC. Previous conversation and durable plan were cleared; learned skills and Factorio world state were kept.')
    return true
  }

  if (event.action === 'follow') {
    const state = await pausePlanIfPresent(session, 'ui_follow')
    await stopWorldWork(session)
    await session.ensureAuthorization()
    const response = await session.rcon.command(`/silent-command local ok,msg=remote.call("autorio_operations","follow_player",${luaString(event.player_name)},4); rcon.print(tostring(ok).."|"..tostring(msg))`)
    if (state) await session.syncTaskBoardUi(state)
    await session.printChat(`Follow mode requested for ${event.player_name} at about 4 tiles.${response ? ` ${String(response).slice(0, 240)}` : ''}`)
    return true
  }

  if (event.action === 'stop_follow') {
    await session.ensureAuthorization()
    await session.rcon.command('/silent-command remote.call("autorio_operations","stop_follow_player")')
    await session.printChat('Stopped following. Any previously paused plan remains paused until you explicitly continue/resume it.')
    return true
  }

  return false
}

function parseStatus(text) {
  let value
  try { value = JSON.parse(String(text).trim()) }
  catch { throw new DeploymentError('Invalid airi_deployment status JSON') }
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid airi_deployment status')
  return value
}

function expectedCancellation(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message === 'Provider request cancelled'
    || message === 'Model turn was cancelled or superseded'
    || message === 'NPC actor epoch changed; stale model turn cancelled'
}

function providerRecoveryExhausted(message) {
  return /^Provider response recovery exhausted after \d+ attempts:/.test(String(message))
}

export function shouldRecoverInterruptedPlan(state) {
  if (!state || state.status === 'completed' || state.status === 'blocked') return false
  if (state.status === 'active') return true
  if (state.status !== 'paused') return false
  const pauseReason = String(state.pause_reason ?? '')
  return SYSTEM_RECOVERY_PAUSE_REASONS.has(pauseReason) || pauseReason.startsWith('server_stop_')
}

function idleAutorioRuntime(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status) || status.status_error) return false
  if (!Number.isSafeInteger(status.queue_length) || typeof status.task_state !== 'string') return false
  return status.queue_length === 0 && status.task_state.trim().toLowerCase() === 'idle'
}

export async function pauseStrandedPlanAfterRequestError(session, message) {
  const agent = session?.agent
  const state = session?.currentPlanState?.()
  if (!agent || state?.status !== 'active') return undefined
  if (state.condition_wait?.state === 'active') return undefined

  let runtime
  try {
    runtime = typeof agent.readInteractionTaskStatus === 'function'
      ? await agent.readInteractionTaskStatus()
      : undefined
  }
  catch {
    return undefined
  }
  // Never let a provider/runtime exception cancel or relabel real world work
  // that Autorio still owns. Only close the false ACTIVE+IDLE split-brain state.
  if (!idleAutorioRuntime(runtime)) return undefined

  const clean = uiText(message, 240)
  const outputBudget = /provider_output_budget_exhausted|finish=length|output budget/i.test(clean)
  const reason = `${outputBudget ? 'provider_output_budget_exhausted' : 'request_failed'}: ${clean || 'unexpected request failure'}`
  const paused = await agent.pausePersistentPlan?.(reason)
  if (paused) await session.syncTaskBoardUi?.(paused)
  return paused
}

export async function recoverInterruptedAgentPlan(agent, reason, details = {}) {
  if (!agent) return { recovered: false, reason: 'agent_unavailable' }
  await agent.loadPersistentState?.()
  const key = `npc:${agent.npcId ?? 'airi'}`
  const state = agent.memory?.currentPlan?.(key)
  if (!shouldRecoverInterruptedPlan(state)) return { recovered: false, reason: 'plan_not_recoverable', state }

  if (state?.provider_recovery?.kind === 'output_budget_exhaustion' && state.provider_recovery.phase === 'in_flight') {
    const runtime = await agent.readInteractionTaskStatus?.()
    const reduced = agent.memory?.applyOutcomeAuthority?.(key, {
      kind: 'recoverable_provider_failure',
      source: 'runtime_restart',
      reason_code: 'provider_budget',
    }, {
      world: runtime ?? {},
    })
    agent.memory?.setProviderRecovery?.(key, undefined)
    await agent.persistState?.()
    if (reduced?.state?.status === 'paused') agent.cancel?.('runtime_recovery_interrupted_output_budget')
    return {
      recovered: true,
      reason: 'interrupted_output_budget_recovery_fail_closed',
      state: reduced?.state ?? state,
    }
  }

  agent.cancel?.(`runtime_recovery_prepare:${reason}`)
  const epoch = await agent.captureEpoch()
  const memoryContext = agent.memory?.context?.(key) ?? ''
  const recoveryDetails = JSON.stringify(details ?? {}).slice(0, 2000)
  const recoveryMessage = `[HARNESS] Runtime recovery after ${uiText(reason, 120)}. The previous finite Autorio task queue was discarded and its last operation MUST NOT be assumed complete. Re-observe the mutable Factorio state required for the canonical current Task Board step before choosing any world mutation. Preserve the existing goal and completed Task Board prefix. If the current step is already satisfied, verify it and advance; if work remains, submit only the minimum deterministic operations needed to continue. Never blindly replay last_operations. Recovery details: ${recoveryDetails}`

  agent.epoch = epoch
  agent.lastMemoryKey = key
  // Ordinary runtime recovery only. This path has never had replan authority:
  // it re-observes the world and continues the committed plan.
  agent.planUpdateReason = 'recovery'
  agent.reasoningTriggerSource = null
  agent.baseMessages = [
    { role: 'system', content: agent.systemPrompt },
    ...(memoryContext ? [{ role: 'user', content: memoryContext }] : []),
    { role: 'user', content: recoveryMessage },
  ]
  agent.messages = agent.baseMessages.map(message => ({ ...message }))
  agent.requestInfo = {
    memoryKey: key,
    turnId: ++agent.turnSequence,
    sender: uiText(state.owner || 'runtime-recovery', 128),
    text: uiText(state.objective || 'Resume interrupted AIRI goal', 4000),
  }
  agent.active = true
  agent.continuations = 1
  const previousReasoningBudget = agent.reasoningBudgetOverride
  const previousObservationBudget = agent.observationBudgetOverride
  const previousObservationBudgetRemaining = agent.observationBudgetRemaining
  const previousPlanningHorizon = agent.planningHorizonOverride
  if (typeof agent.traceEvent === 'function') {
    agent.traceRequest = { id: `recovery_${Date.now().toString(36)}`, seq: 0 }
    await agent.traceEvent('runtime.recovery_started', { reason, details })
  }
  try {
    const result = await agent.runGuarded()
    return { recovered: true, result, state: agent.memory?.currentPlan?.(key) }
  }
  finally {
    agent.reasoningBudgetOverride = previousReasoningBudget
    agent.observationBudgetOverride = previousObservationBudget
    agent.observationBudgetRemaining = previousObservationBudgetRemaining
    agent.planningHorizonOverride = previousPlanningHorizon
  }
}


export class Session {
  constructor({ root, app, game, config, save, settingsFile, modDir, ini, rcon = rconConfiguration(), log = console.log, provider = providerRequest, startupMs = 120000 }) {
    Object.assign(this, { root, app, game, config, save, settingsFile, modDir, ini, log, provider, startupMs })
    this.session = nonce() + nonce()
    this.rconPassword = rcon.password
    this.rconPort = rcon.port
    this.rconBind = rcon.bind
    this.rcon = null
    this.gameChild = null
    this.agent = null
    this.stopping = false
    this.stopPromise = null
    this.ready = false
    this.expectedStop = false
    this.eventQueue = Promise.resolve()
    this.lastCompletionAt = 0
    this.lastErrorAt = 0
    this.lastStatus = null
    this.authorizationPromise = null
    this.npcName = 'AIRI'
    this.npcId = 'airi'
    this.activityEpoch = Date.now().toString(36)
    this.conversationGeneration = 0
    this.conversationSequence = 0
    this.agentLive = {
      phase: 'idle',
      detail: '',
      objective: '',
      at: 0,
      activity: [],
      conversation_id: `task_${this.activityEpoch}_0`,
      conversation: [],
      debug: emptyAgentDebug({ provider_model: this.config?.model }),
    }
    this.activitySequence = 0
    // Live ids must not repeat across supervisor restarts: the mod keeps a
    // history keyed by id, and a reused live_1 would be taken for an old event
    // and silently dropped.
    this.uiSyncDirty = false
    this.uiSyncRunning = null
    this.uiInputPoll = null
    this.uiHeartbeat = null
    this.uiInputPollRunning = false
    this.conditionPollRunning = false
    this.lastUiFailure = ''
    this.lastUiFailureAt = 0
  }

  startNewUiConversation() {
    this.conversationGeneration += 1
    this.conversationSequence = 0
    if (!this.agentLive || typeof this.agentLive !== 'object') return
    this.agentLive.conversation_id = `task_${this.activityEpoch}_${this.conversationGeneration}`
    this.agentLive.conversation = []
  }

  appendUiConversation(role, sender, rawText) {
    const text = uiText(rawText, 2000)
    if (!text || (role !== 'user' && role !== 'assistant')) return
    if (!Array.isArray(this.agentLive.conversation)) this.agentLive.conversation = []
    const previous = this.agentLive.conversation.at(-1)
    if (previous?.role === role && previous?.text === text) return
    const message = {
      id: `message_${this.activityEpoch}_${this.conversationGeneration}_${++this.conversationSequence}`,
      role,
      sender: uiText(sender || (role === 'assistant' ? 'AIRI' : 'Player'), 128),
      text,
    }
    this.agentLive.conversation = [...this.agentLive.conversation, message].slice(-UI_CONVERSATION_LIMIT)
  }

  async restoreTaskBoardUiConversation(state = this.currentPlanState()) {
    if (!this.rcon || !state?.goal_id || !this.agentLive || typeof this.agentLive !== 'object') return false
    if (Array.isArray(this.agentLive.conversation) && this.agentLive.conversation.length > 0) return false

    try {
      const raw = String(await this.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_task_board","status")))') ?? '').trim()
      if (!raw || raw === 'nil' || raw === 'null') return false
      let saved
      try { saved = JSON.parse(raw) }
      catch { return false }
      if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false
      if (uiText(saved.goal_id, 100) !== uiText(state.goal_id, 100)) return false

      const sourceConversation = Array.isArray(saved.conversation) ? saved.conversation.slice(-UI_CONVERSATION_LIMIT) : []
      const restored = []
      for (let index = 0; index < sourceConversation.length; index++) {
        const entry = sourceConversation[index]
        const role = entry?.role === 'assistant' ? 'assistant' : entry?.role === 'user' ? 'user' : undefined
        const text = uiText(entry?.text, 2000)
        if (!role || !text) continue
        restored.push({
          id: uiText(entry?.id, 120) || `restored_${index + 1}`,
          role,
          sender: uiText(entry?.sender, 128) || (role === 'assistant' ? (this.npcName || 'AIRI') : 'Player'),
          text,
        })
      }
      if (restored.length === 0) return false

      const savedConversationId = uiText(saved.conversation_id, 120)
      if (savedConversationId) this.agentLive.conversation_id = savedConversationId
      this.agentLive.conversation = restored
      return true
    }
    catch (error) {
      this.log(`Task Board UI conversation restore skipped: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  ensureUiConversationForState(state) {
    if (!state?.goal_id || !this.agentLive || typeof this.agentLive !== 'object') return false
    if (Array.isArray(this.agentLive.conversation) && this.agentLive.conversation.length > 0) return false
    const before = Array.isArray(this.agentLive.conversation) ? this.agentLive.conversation.length : 0
    this.appendUiConversation('user', state.owner || 'Player', state.objective)
    this.appendUiConversation('assistant', this.npcName || 'AIRI', state.last_chat_message)
    return this.agentLive.conversation.length > before
  }

  onAgentActivity(event, data) {
    if (event === 'interaction.routed') {
      if (data?.intent === 'new_goal') this.startNewUiConversation()
      this.appendUiConversation('user', data?.sender, data?.text)
    }
    if (event === 'request.received') this.appendUiConversation('user', data?.sender, data?.text)
    if ((event === 'plan.accepted' || event === 'request.completed') && data?.chat_message) {
      this.appendUiConversation('assistant', this.npcName || 'AIRI', data.chat_message)
    }
    const fallback = {
      request_id: this.agent?.traceRequest?.id,
      turn: this.agent?.traceRequest ? this.agent.continuations + 1 : 0,
      provider_model: this.config?.model,
      actor_id: this.agent?.epoch?.actor_id ?? this.lastStatus?.actor_id,
      actor_epoch: this.agent?.epoch?.epoch ?? this.lastStatus?.epoch,
      usage: this.agent?.traceRequest?.usage,
    }
    this.agentLive.debug = liveAgentDebugEvent(event, data, this.agentLive.debug, fallback)
    const update = liveAgentEvent(event, data)
    if (update?.phase) Object.assign(this.agentLive, { phase: update.phase, detail: update.detail ?? '', at: Date.now() })
    if (update?.objective) this.agentLive.objective = update.objective
    if (update?.activity) {
      const activity = { ...update.activity, id: `live_${this.activityEpoch}_${++this.activitySequence}` }
      this.agentLive.activity = [...this.agentLive.activity, activity].slice(-UI_LIVE_ACTIVITY_LIMIT)
    }
    if (update || event === 'provider.response' || event === 'tool.result' || event === 'actor.bound') this.requestTaskBoardUiSync()
  }

  liveAgentStatus() {
    const live = this.agentLive
    let { phase, detail } = live
    const inactive = !this.agent?.active
    if (inactive && (phase === 'executing' || phase === 'waiting' || (phase === 'thinking' && Date.now() - live.at > UI_STALE_THINKING_MS))) {
      phase = 'idle'
      detail = ''
    }
    return { phase, detail, objective: live.objective, activity: live.activity, conversation_id: live.conversation_id, conversation: live.conversation, debug: live.debug }
  }

  requestTaskBoardUiSync() {
    this.uiSyncDirty = true
    if (this.uiSyncRunning) return this.uiSyncRunning
    this.uiSyncRunning = (async () => {
      try {
        while (this.uiSyncDirty && this.rcon && !this.stopping) {
          await delay(UI_SYNC_BATCH_MS)
          this.uiSyncDirty = false
          await this.syncTaskBoardUi()
        }
      }
      finally {
        const reschedule = this.uiSyncDirty && this.rcon && !this.stopping
        this.uiSyncRunning = null
        if (reschedule) this.requestTaskBoardUiSync()
      }
    })()
    return this.uiSyncRunning
  }

  taskBoardUiHeartbeat() {
    if (!this.rcon || !this.ready || this.stopping) return false
    this.requestTaskBoardUiSync()
    return true
  }

  updateNpcIdentity(status) {
    if (typeof status?.actor_name === 'string' && status.actor_name.length > 0 && status.actor_name.length <= 200) {
      this.npcName = status.actor_name
    }
    if (typeof status?.npc_id === 'string' && status.npc_id.length > 0 && status.npc_id.length <= 200) {
      this.npcId = status.npc_id
    }
  }

  cleanEnv() {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/OPENAI|API_KEY|TOKEN|PASSWORD|RCON/i.test(key)) delete env[key]
    env.HOME = this.root
    env.TMPDIR = path.join(this.root, '.airi', 'tmp')
    return env
  }

  gameArgs(rconPort) {
    return [
      '--config', this.ini,
      '--mod-directory', this.modDir,
      '--start-server', this.save,
      '--server-settings', this.settingsFile,
      '--bind', `0.0.0.0:${this.config.gamePort}`,
      '--rcon-bind', `${this.rconBind}:${rconPort}`,
      '--rcon-password', this.rconPassword,
    ]
  }

  async rawStatus() {
    check(this.rcon, 'RCON is not connected')
    return parseStatus(await this.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("airi_deployment","status")))'))
  }

  async reconcileNpcAfterLoad() {
    if (!this.rcon) return false
    try {
      await this.rcon.command('/silent-command remote.call("autorio_actor","reconcile_after_load")')
      return true
    }
    catch (error) {
      this.log(`NPC post-load reconciliation failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  async bindNpc() {
    const status = await configureNpcSession(this.rcon, this.session)
    this.updateNpcIdentity(status)
    this.lastStatus = status
    await this.reconcileNpcAfterLoad()
    return status
  }

  async ensureAuthorization() {
    if (this.authorizationPromise) return this.authorizationPromise
    this.authorizationPromise = (async () => {
      const current = await this.rawStatus()
      const stable = current.revision === 'airi-deploy-v8-npc-staging'
        && current.session === this.session
        && current.mode === 'npc'
        && current.allowed === true
        && current.actor_kind === 'standalone_character'
        && Number.isSafeInteger(current.actor_id)
        && current.actor_id > 0
        && Number.isSafeInteger(current.epoch)
        && current.epoch > 0
      if (stable) {
        this.updateNpcIdentity(current)
        this.lastStatus = current
        return current
      }

      if (this.agent?.active) {
        if (typeof this.agent.pausePersistentPlan === 'function') {
          const state = await this.agent.pausePersistentPlan('npc_identity_or_session_changed')
          await this.syncTaskBoardUi(state)
        }
        else this.agent.cancel()
        this.log('NPC identity/session changed; active model turn paused before rebind')
      }
      return this.bindNpc()
    })()

    try {
      return await this.authorizationPromise
    }
    finally {
      this.authorizationPromise = null
    }
  }

  currentPlanState() {
    if (!this.agent?.memory?.currentPlan) return undefined
    const key = typeof this.agent.activePlanKey === 'function' ? this.agent.activePlanKey() : `npc:${this.npcId}`
    return this.agent.memory.currentPlan(key)
  }

  async recoverInterruptedPlan(reason, details = {}) {
    if (!this.agent || !shouldRecoverInterruptedPlan(this.currentPlanState())) return null
    this.log(`Recovering interrupted AIRI plan after ${reason}; mutable world state will be re-observed before resuming`)
    try {
      const recovery = await recoverInterruptedAgentPlan(this.agent, reason, details)
      if (!recovery.recovered) return null
      await this.syncTaskBoardUi(recovery.state)
      if (recovery.result?.chatMessage) await this.printChat(recovery.result.chatMessage)
      return recovery.result
    }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.log(`Interrupted plan recovery failed after ${reason}: ${message}`)
      const paused = typeof this.agent.pausePersistentPlan === 'function'
        ? await this.agent.pausePersistentPlan(`runtime_recovery_failed:${uiText(reason, 80)}:${uiText(message, 180)}`)
        : undefined
      if (paused) await this.syncTaskBoardUi(paused)
      await this.printChat(`I could not safely recover the interrupted plan after ${reason}; it has been paused instead of guessing. ${message}`)
      return null
    }
  }

  async writeTaskBoardUi(command, label) {
    if (!this.rcon) return false
    try {
      const response = String(await this.rcon.command(command) ?? '').trim()
      if (response === 'true') {
        this.lastUiFailure = ''
        return true
      }
      this.logTaskBoardUiFailure(`Task Board UI ${label} was not accepted by Autorio: ${response || 'empty RCON response'}`)
      return false
    }
    catch (error) {
      this.logTaskBoardUiFailure(`Task Board UI ${label} failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  logTaskBoardUiFailure(message) {
    const now = Date.now()
    if (this.lastUiFailure === message && now - this.lastUiFailureAt < UI_FAILURE_LOG_INTERVAL_MS) return
    this.lastUiFailure = message
    this.lastUiFailureAt = now
    this.log(message)
  }

  async clearTaskBoardUi() {
    return this.writeTaskBoardUi('/silent-command rcon.print(tostring(remote.call("autorio_task_board","clear")))', 'clear')
  }

  async ackTaskBoardUiLifecycle(playerIndex, action) {
    if (!Number.isSafeInteger(playerIndex) || playerIndex < 1) return false
    return this.writeTaskBoardUi(
      `/silent-command rcon.print(tostring(remote.call("autorio_task_board","ack_lifecycle",${playerIndex},${luaString(action)})))`,
      `ack ${action}`,
    )
  }

  async syncTaskBoardUi(state = this.currentPlanState()) {
    if (!this.rcon) return false
    if (state?.goal_id && (!Array.isArray(this.agentLive?.conversation) || this.agentLive.conversation.length === 0)) {
      await this.restoreTaskBoardUiConversation(state)
    }
    this.ensureUiConversationForState(state)
    const snapshot = taskBoardUiSnapshot(state, this.liveAgentStatus())
    if (!snapshot) return this.clearTaskBoardUi()
    const json = taskBoardUiJson(snapshot)
    if (json === undefined) {
      this.logTaskBoardUiFailure(`Task Board UI sync skipped: snapshot exceeds ${UI_SNAPSHOT_MAX_BYTES} bytes even after trimming`)
      return false
    }
    return this.writeTaskBoardUi(
      `/silent-command rcon.print(tostring(remote.call("autorio_task_board","set_snapshot",helpers.json_to_table(${luaString(json)}))))`,
      'sync',
    )
  }

  async drainTaskBoardUiInputs() {
    if (!this.rcon || !this.ready || this.stopping || this.uiInputPollRunning) return false
    this.uiInputPollRunning = true
    try {
      const raw = await this.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_task_board","drain_inputs")))')
      const inputs = parseUiInputBatch(raw)
      for (const input of inputs) {
        if (input.kind === 'poll') {
          this.requestTaskBoardUiSync()
          continue
        }
        if (!chatAuthorized(this.config.chatPlayers, input.player_name)) {
          this.log(`[SGLuna UI] Ignored unauthorized ${input.kind} player=${input.player_name}${input.action ? ` action=${input.action}` : ''}`)
          continue
        }
        if (input.kind === 'control') this.queueUiControl(input)
        else this.queueUiPrompt(input)
      }
      return inputs.length > 0
    }
    catch (error) {
      this.log(`Task Board UI input drain failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
    finally {
      this.uiInputPollRunning = false
    }
  }

  pollRuntimeCondition() {
    if (!this.agent || !this.rcon || !this.ready || this.stopping || this.conditionPollRunning) return false
    const state = this.currentPlanState()
    if (state?.condition_wait?.state !== 'active' || typeof this.agent.pollConditionWait !== 'function') return false
    this.conditionPollRunning = true
    this.queueEvent(async () => {
      try {
        await this.ensureAuthorization()
        const result = await this.agent.pollConditionWait()
        if (!result || result.action === 'stale') return
        if (result.state) await this.syncTaskBoardUi(result.state)

        if (result.action === 'waiting') {
          this.log(`Runtime condition still active; planner remains asleep wait=${result.wait_id}`)
          return
        }

        if (result.action === 'verified') {
          if (result.state?.status === 'completed') {
            const completed = {
              goalStatus: 'completed',
              goalId: result.state.goal_id,
              taskBoard: result.state.task_board,
              chatMessage: 'The requested goal is verified complete.',
            }
            const finalized = await finalizeCompletedTaskBoundary(this, completed)
            if (completed.chatMessage) await this.printChat(completed.chatMessage)
            if (!finalized) await this.syncTaskBoardUi(result.state)
            return
          }
          const resumed = await this.recoverInterruptedPlan('condition_satisfied', {
            condition_wait_id: result.wait_id,
            source: 'runtime_condition',
          })
          if (!resumed) await this.syncTaskBoardUi(result.state)
          return
        }

        if (result.action === 'wake' || result.action === 'timeout' || result.action === 'failed') {
          const resumed = await this.recoverInterruptedPlan(`condition_${result.action}`, {
            condition_wait_id: result.wait_id,
            reason: result.reason,
            source: 'runtime_condition',
          })
          if (!resumed) await this.syncTaskBoardUi(result.state)
        }
      }
      finally {
        this.conditionPollRunning = false
      }
    }, { reportError: true })
    return true
  }

  async applyNavigationObstaclePolicy(text) {
    if (!this.rcon) return
    const policy = navigationObstaclePolicy(text)
    if (!policy.shouldUpdate) return
    try {
      await this.rcon.command(`/silent-command remote.call("autorio_navigation","set_clear_obstacles",${policy.clearObstacles ? 'true' : 'false'})`)
      if (!policy.clearObstacles) this.log('Natural navigation obstacle clearing disabled by explicit user request')
    }
    catch (error) {
      this.log(`Navigation obstacle policy update failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  async start() {
    const rconPort = this.rconPort ?? await freeTcpPort([this.config.gamePort])
    const secrets = [this.config.key, this.rconPassword, this.session, this.config.factorio.token]
    const gameLog = line => {
      this.log(redact(secrets, line))
      this.onGameLine(line)
    }
    this.gameChild = new Child(path.join(this.game, 'bin', 'x64', 'factorio'), this.gameArgs(rconPort), {
      cwd: this.root,
      env: this.cleanEnv(),
      label: 'Factorio',
      log: gameLog,
    }).attachInput(process.stdin)

    const deadline = Date.now() + this.startupMs
    while (Date.now() < deadline) {
      check(this.gameChild.alive(), 'Factorio exited before RCON became ready')
      const rcon = new Rcon(rconPort, this.rconPassword, 2500)
      try {
        await rcon.connect()
        rcon.timeout = 10000
        this.rcon = rcon
        break
      }
      catch {
        rcon.close()
        await delay(200)
      }
    }
    check(this.rcon, 'Timed out waiting for authenticated Factorio RCON')
    const version = await this.rcon.command('/version')
    check(/2\.0\.\d+/.test(version), 'Authenticated Factorio RCON version probe failed')
    await this.bindNpc()

    const prompt = await fsp.readFile(path.join(this.app, 'src', 'prompt.md'), 'utf8')
    const jevDecisionProvider = this.config.decisionProvider
      ? (state, questions, context = {}) => decisionProviderRequest(
          this.config.decisionProvider,
          state,
          questions,
          {
            signal: context.signal,
            reserve: () => reserveBudget(
              path.join(this.root, '.airi', 'decision-provider-budget.json'),
              this.config.decisionProvider.maxRequestsPerHour,
            ),
          },
        )
      : undefined
    this.agent = new NpcAgentLoop({
      rcon: this.rcon,
      systemPrompt: `${prompt}\n\n${RUNTIME_RELIABILITY_GUIDANCE}`,
      npcId: this.npcId,
      memory: new CanonicalTaskBoardMemory(),
      stateFile: path.join(this.root, '.airi', 'npc-state.json'),
      provider: (messages, context) => this.provider({
        base: this.config.base,
        key: this.config.key,
        model: this.config.model,
        profile: this.config.profile,
        timeoutMs: this.config.providerTimeoutMs,
      }, messages, context),
      interactionProvider: (messages, context) => this.provider({
        base: this.config.base,
        key: this.config.key,
        model: this.config.model,
        profile: this.config.profile,
        timeoutMs: this.config.providerTimeoutMs,
      }, messages, context),
      interactionDecisionProvider: jevDecisionProvider,
      scopeReviewDecisionProvider: jevDecisionProvider,
      steeringDecisionProvider: jevDecisionProvider,
      reserve: async context => reserveBudget(
        path.join(this.root, '.airi', 'provider-budget.json'),
        this.config.budget,
        Date.now(),
        { reservedSlots: 1, emergency: context?.recoveryKind === 'output_budget_exhaustion' },
      ),
      maxProviderOutputUnits: this.config.maxProviderOutputUnits,
      log: message => this.log(`[SGLuna agent] ${redact(secrets, message)}`),
      onActivity: (event, data) => this.onAgentActivity(event, data),
    })
    await this.agent.loadPersistentState()
    await this.syncTaskBoardUi()

    this.ready = true
    this.uiInputPoll = setInterval(() => {
      if (!this.stopping) this.drainTaskBoardUiInputs()
    }, UI_INPUT_POLL_MS)
    this.uiHeartbeat = setInterval(() => this.taskBoardUiHeartbeat(), UI_HEARTBEAT_MS)
    this.uiHeartbeat.unref?.()
    this.drainTaskBoardUiInputs()
    this.poll = setInterval(() => {
      if (this.stopping) return
      if (this.pollRuntimeCondition()) return
      this.ensureAuthorization().catch(error => this.log(`NPC authorization health check failed: ${error.message}`))
    }, 2000)
    const startupState = this.currentPlanState()
    if (startupState?.condition_wait?.state !== 'active' && shouldRecoverInterruptedPlan(startupState)) {
      this.queueEvent(async () => {
        await this.recoverInterruptedPlan('runtime_restart', { actor_id: this.lastStatus?.actor_id, epoch: this.lastStatus?.epoch })
      })
    }
    this.log(`SGLuna Factorio ready; npc=${this.npcName} (${this.npcId}), actor_id=${this.lastStatus.actor_id}, chat=${describeChatPlayers(this.config.chatPlayers)}`)
    return this.lastStatus
  }

  queueEvent(fn, { reportError = false } = {}) {
    this.eventQueue = this.eventQueue.then(fn).catch(async error => {
      const message = error instanceof Error ? error.message : String(error)
      this.log(message)
      if (reportError && !expectedCancellation(error) && this.agent) {
        try {
          const state = await pauseStrandedPlanAfterRequestError(this, message)
          if (state) this.log('Canonical Task Board paused after a failed request left Autorio idle')
          else if (providerRecoveryExhausted(message)) {
            // Preserve the old diagnostic signal without blindly pausing if
            // Autorio status is unknown or still owns live world work.
            this.log('Provider recovery exhausted; durable task was not auto-paused because Autorio was not authoritatively idle')
          }
        }
        catch (pauseError) {
          this.log(`Unable to reconcile Task Board after request failure: ${pauseError instanceof Error ? pauseError.message : pauseError}`)
        }
      }
      if (reportError && !expectedCancellation(error)) {
        try { await this.printChat(`Request failed: ${message}`) }
        catch (printError) { this.log(`Unable to report AIRI error in chat: ${printError instanceof Error ? printError.message : printError}`) }
      }
    })
    return this.eventQueue
  }

  async printChat(message) {
    if (!message || !this.rcon || this.stopping) return
    const clean = String(message).replace(/[\r\n]+/g, ' ').slice(0, 2000)
    const label = this.npcName && this.npcName !== 'AIRI' ? `[AIRI/${this.npcName}]` : '[AIRI]'
    await this.rcon.command(`/silent-command game.print(${luaString(`${label} ${clean}`)})`)
  }

  queueUiControl(input) {
    // Terminate is an emergency stop, not ordinary queued work. Abort the
    // current provider turn before entering eventQueue so a long model response
    // cannot delay termination. The queued handler still owns durable-state
    // deletion, Autorio cancellation, UI clearing, and the final lifecycle ACK.
    if (input.action === 'terminate') this.agent?.cancel?.('ui_terminate_immediate')
    this.queueEvent(async () => {
      try {
        await executeUiControl(this, input)
      }
      finally {
        if (input.action === 'pause' || input.action === 'terminate') {
          await this.ackTaskBoardUiLifecycle(input.player_index, input.action)
        }
      }
    }, { reportError: true })
    return true
  }

  queueUiPrompt(input) {
    const resume = input.text.trim().toLowerCase() === 'continue'
    return this.queuePlayerRequest(input.player_name, input.text, resume ? {
      onSettled: async () => { await this.ackTaskBoardUiLifecycle(input.player_index, 'resume') },
    } : undefined)
  }

  queuePlayerRequest(sender, rawText, { onSettled } = {}) {
    const text = routeNpcRequest(rawText, this.npcName)
    if (!text || !this.agent) return false
    const stop = text.toLowerCase() === 'stop'
    if (stop) this.agent.cancel('user_stop_immediate')
    this.queueEvent(async () => {
      try {
        if (stop) {
          const state = typeof this.agent.pausePersistentPlan === 'function'
            ? await this.agent.pausePersistentPlan('user_stop')
            : undefined
          if (state) await this.syncTaskBoardUi(state)
          await this.ensureAuthorization()
          await this.rcon.command('/silent-command remote.call("airi_deployment","cancel")')
          await this.printChat('Paused the current AIRI plan and cancelled active Autorio work. Say continue/resume when you want me to pick it back up.')
          return
        }
        await this.ensureAuthorization()
        await this.applyNavigationObstaclePolicy(text)
        // Bind the visible user turn immediately. interaction.routed/request.received
        // deduplicate this same entry; a true new_goal can still rotate the
        // conversation before re-appending the message.
        this.appendUiConversation('user', sender, text)
        const result = await this.agent.request(text, { sender })
        if (result?.chatMessage) this.appendUiConversation('assistant', this.npcName || 'AIRI', result.chatMessage)
        const finalized = await finalizeCompletedTaskBoundary(this, result)
        if (!finalized) await this.syncTaskBoardUi()
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }
      finally {
        if (typeof onSettled === 'function') await onSettled()
      }
    }, { reportError: true })
    return true
  }

  onGameLine(line) {
    if (!this.ready || this.stopping || !this.agent) return

    const uiControl = parseUiControlLine(line)
    if (uiControl) {
      if (!chatAuthorized(this.config.chatPlayers, uiControl.player_name)) {
        this.log(`[SGLuna UI] Ignored unauthorized control action=${uiControl.action} player=${uiControl.player_name}`)
        return
      }
      this.queueUiControl(uiControl)
      return
    }

    const uiPrompt = parseUiPromptLine(line)
    if (uiPrompt) {
      if (!chatAuthorized(this.config.chatPlayers, uiPrompt.player_name)) {
        this.log(`[SGLuna UI] Ignored unauthorized prompt player=${uiPrompt.player_name}`)
        return
      }
      this.queueUiPrompt(uiPrompt)
      return
    }

    const chat = line.match(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \[CHAT\] ([^:\r\n]+): !(?:luna|airi) (.{1,4000})$/)
    if (chat && chatAuthorized(this.config.chatPlayers, chat[1])) {
      this.queuePlayerRequest(chat[1], chat[2])
      return
    }

    const recovery = line.match(/\[AUTORIO\] Recovered standalone NPC actor_id=(\d+) -> (\d+) without inventory transfer/)
    if (recovery) {
      this.queueEvent(async () => {
        const planBeforeRecovery = this.currentPlanState()
        this.agent.cancel?.('actor_replaced_stale_turn')
        await this.ensureAuthorization()
        if (shouldRecoverInterruptedPlan(planBeforeRecovery)) {
          const result = await this.recoverInterruptedPlan('actor_replaced', {
            previous_actor_id: Number(recovery[1]),
            replacement_actor_id: Number(recovery[2]),
            inventory_policy: 'no_transfer',
          })
          if (result) return
        }
        await this.printChat(`I was killed or lost my body and respawned. Previous actor ${recovery[1]}, replacement actor ${recovery[2]}. There is no active recoverable plan, so I will wait for a new instruction.`)
      })
      return
    }

    if (line.includes('[AUTORIO] All operations completed') && Date.now() - this.lastCompletionAt > 250) {
      this.lastCompletionAt = Date.now()
      this.queueEvent(async () => {
        if (!this.agent.active) return
        await this.ensureAuthorization()
        if (!this.agent.active) return
        const result = await this.agent.completed()
        const finalized = await finalizeCompletedTaskBoundary(this, result)
        if (!finalized) await this.syncTaskBoardUi()
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }, { reportError: true })
      return
    }

    const autorioError = line.match(/\[AUTORIO\] \[ERROR\] (.+)$/)
    if (autorioError && Date.now() - this.lastErrorAt > 250) {
      this.lastErrorAt = Date.now()
      this.queueEvent(async () => {
        if (!this.agent.active) {
          this.log(`[SGLuna agent] Autorio error with no active model goal: ${autorioError[1]}`)
          return
        }
        await this.ensureAuthorization()
        if (!this.agent.active) return
        const result = typeof this.agent.failed === 'function' ? await this.agent.failed(autorioError[1]) : null
        await this.syncTaskBoardUi()
        if (result?.chatMessage) await this.printChat(result.chatMessage)
      }, { reportError: true })
    }
  }

  stop(reason = 'requested') {
    if (this.stopPromise) return this.stopPromise
    this.expectedStop = ['requested', 'signal', 'console'].includes(reason)
    this.stopping = true
    this.ready = false
    if (this.uiInputPoll) clearInterval(this.uiInputPoll)
    if (this.uiHeartbeat) clearInterval(this.uiHeartbeat)
    if (this.poll) clearInterval(this.poll)
    this.stopPromise = (async () => {
      let clean = true
      let gracefulResult
      if (this.agent?.active) {
        try {
          if (typeof this.agent.pausePersistentPlan === 'function') {
            const state = await this.agent.pausePersistentPlan(`server_stop_${reason}`)
            await this.syncTaskBoardUi(state)
          }
          else this.agent.cancel()
        }
        catch (error) {
          clean = false
          this.log(`Unable to persist active AIRI plan before shutdown: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (this.rcon && this.gameChild?.alive()) {
        this.rcon.timeout = Math.min(this.config.stopMs, 30000)
        try { await this.rcon.command('/silent-command remote.call("autorio_operations","cancel")') }
        catch (error) { clean = false; this.log(`Shutdown cancel command failed: ${error instanceof Error ? error.message : error}`) }

        this.log('Requesting Factorio graceful /quit shutdown')
        this.rcon.command('/quit').catch(error => {
          if (this.gameChild?.alive()) {
            this.log(`Shutdown /quit acknowledgement failed: ${error instanceof Error ? error.message : error}`)
          }
        })
        try {
          gracefulResult = await withTimeout(this.gameChild.closed, this.config.stopMs, 'Factorio graceful /quit timed out')
        }
        catch (error) {
          clean = false
          this.log(`Factorio did not exit cleanly after /quit: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (this.gameChild?.alive()) {
        this.log('Falling back to SIGINT for Factorio shutdown')
        const stopped = await this.gameChild.stop(Math.min(this.config.stopMs, 15000), 'SIGINT')
        if (stopped.forced || stopped.result?.code !== 0) clean = false
      }
      else if (gracefulResult && gracefulResult.code !== 0) {
        clean = false
      }
      this.rcon?.close()
      this.log(clean ? 'SGLuna Factorio stopped cleanly' : 'SGLuna Factorio shutdown required fallback handling')
      return clean
    })()
    return this.stopPromise
  }
}

export async function verifyManifest(app) {
  const manifest = await readJson(path.join(app, 'manifest.json'))
  check(manifest?.revision === 'airi-pterodactyl-v8' && manifest.files && typeof manifest.files === 'object', 'Missing v8 release manifest')
  for (const [name, expected] of Object.entries(manifest.files)) {
    check(typeof expected === 'string' && /^[a-f0-9]{64}$/.test(expected), `Invalid manifest digest: ${name}`)
    const filename = path.join(app, name)
    await regularFile(filename)
    check(await hashFile(filename) === expected, `Release file integrity failed: ${name}`)
  }
  return manifest
}

async function main() {
  check(os.arch() === 'x64', 'SGLuna Pterodactyl v8 requires amd64')
  const root = path.resolve(process.env.CONTAINER_ROOT || '/home/container')
  const app = installedAppRoot()
  const manifest = await verifyManifest(app)
  await directory(path.join(root, '.airi'))
  await directory(path.join(root, '.airi', 'tmp'))
  const migratedConfig = await migrateCanonicalConfig(root)
  const config = configuration(migratedConfig.config)
  const game = path.join(app, 'factorio')
  await regularFile(path.join(game, 'bin', 'x64', 'factorio'))
  const work = await fsp.mkdtemp(path.join(root, '.airi', 'run-'))
  let session
  let requestedStop = false
  const log = message => console.log(`[${new Date().toISOString()}] [SGLuna] ${message}`)
  log(describeRelease(manifest))
  if (migratedConfig.migratedFromLegacy) log('Migrated legacy airi-config.json into canonical sgluna-config.json; the legacy file is no longer authoritative.')
  for (const message of deploymentCompatibilityWarnings(process.env)) log(`Compatibility warning: ${message}`)
  for (const message of factorioVisibilityDiagnostics(config.factorio, config.chatPlayers)) log(message)
  log(`Client mod download: ${path.join(root, 'client-mods', 'autorio_0.1.0.zip')}`)
  log(`User Factorio mod directory: ${path.join(root, 'mods')}`)
  log(`Managed runtime mod directory: ${path.join(root, '.airi', 'run-*', 'mods')} (internal; do not edit)`)
  log(`Operator help: ${path.join(root, 'README-SGLUNA.txt')}`)

  const handleSignal = () => {
    requestedStop = true
    session?.stop('signal')
  }
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, handleSignal)

  try {
    const modDir = await prepareMods(root, app, work)
    const settingsFile = await prepareServerSettings(root, game, config.factorio)
    const ini = await prepareGameConfig(work, game, root)
    const selected = await selectSave(root, config.save)
    if (selected.create) {
      log(`Creating initial save ${path.basename(selected.filename)}`)
      await createSave(selected.filename, game, modDir, ini, root, log)
    }
    session = new Session({ root, app, game, config, save: selected.filename, settingsFile, modDir, ini, rcon: rconConfiguration(), log })
    try {
      await session.start()
    }
    catch (error) {
      log(`Startup failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
      throw error
    }
    const result = await session.gameChild.closed
    if (!requestedStop) {
      log(`Factorio exited unexpectedly: ${JSON.stringify(result)}`)
      process.exitCode = 1
    }
  }
  finally {
    if (session && !session.stopping) await session.stop(requestedStop ? 'requested' : 'unexpected child exit')
    else if (session?.stopPromise) await session.stopPromise
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(signal, handleSignal)
    await fsp.rm(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`[SGLuna] ${error instanceof Error ? error.message : 'Startup failed'}`)
    process.exitCode = 1
  })
}
