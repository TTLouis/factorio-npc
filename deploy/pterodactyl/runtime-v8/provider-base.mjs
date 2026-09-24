import fsp from 'node:fs/promises'
import path from 'node:path'

import { check, DeploymentError } from './common.mjs'
import { parsePlan, providerToolDefinitions as toolDefinitions } from './structured-policy.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const FAILURE_MARKER = '[MOD] Autorio operation error:'
const CHAT_MARKER = '[CHAT]'
const STEERING_MARKER = '[STEERING]'
const COMPLETION_MAX_TOKENS = 1000
const FALLBACK_CONTINUATION_MAX_TOKENS = 4000
const DEFAULT_MAX_TOKENS = 2000
const MAX_PROVIDER_OUTPUT_CAP = 65536
const PROVIDER_PROFILE_IDS = new Set(['auto', 'generic', 'deepseek', 'openai-reasoning'])
const PROVIDER_PROFILES = Object.freeze({
  generic: Object.freeze({
    id: 'generic',
    token_field: 'max_tokens',
    reasoning_effort: false,
    thinking_control: 'none',
    tool_support: true,
    structured_output: 'tools_or_json',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    token_field: 'max_tokens',
    reasoning_effort: true,
    thinking_control: 'deepseek',
    tool_support: true,
    structured_output: 'tools_or_json',
  }),
  'openai-reasoning': Object.freeze({
    id: 'openai-reasoning',
    token_field: 'max_completion_tokens',
    reasoning_effort: true,
    thinking_control: 'none',
    tool_support: true,
    structured_output: 'tools_or_json',
  }),
})
const REQUEST_BODY_PATCH_KEYS = new Set(['max_tokens', 'max_completion_tokens', 'reasoning_effort', 'thinking', 'response_format'])
const PLAN_STATE_MARKER = '[PLAN_STATE]' // legacy persisted/runtime compatibility
const RUNTIME_COMPAT_STATE_MARKER = '[RUNTIME_COMPAT_STATE]'
const PLANNING_STATE_MARKER = '[PLANNING_STATE]'
const MEMORY_MARKER = '[MEMORY]'
const PROMPT_TRACE_MAX_BYTES = 10 * 1024 * 1024
const PROMPT_TRACE_FILES = 5
const PROMPT_RESPONSE_PREVIEW_CHARS = 4000
const SENSITIVE_PROMPT_KEY = /^(?:authorization|api.?key|password|secret|cookie|session|token|access.?token|refresh.?token|factorio.?token|openai.?token|rcon.?token)$/i
const promptTraceWriters = new Map()

const COMPACT_CONTINUATION_PROMPT = `You are AIRI, an autonomous standalone Factorio NPC. This request is a successful Autorio batch-completion continuation for an existing user goal, not a new goal.

Use [PLANNING_STATE] as the sole durable planning authority. [RUNTIME_COMPAT_STATE] may carry older Task Board evidence, runtime metadata and locators, but it cannot override Plan Tracker steps or progress. Older persisted runs may still supply [PLAN_STATE]; treat it as compatibility state, never as a second planning authority. Preserve the verified reducer prefix and continue the active goal; do not restart or silently rewrite the plan. Mutable world state still requires observation when it is actually needed for the next decision.

Token-efficient continuation rules:
- Treat a provider turn as an observation/decision boundary, not as an operation boundary. If 2-4 consecutive operations are already fully parameterized from current observations and a later operation does not depend on a new identity/result created by an earlier one, return them together in execution order.
- If the Task Board/receipt already contains deterministic_verification with verdict verified_complete for the action that just finished, do not spend a tool call re-checking that exact fact.
- Call read-only tools only for unknown mutable facts required to choose or parameterize the next operation.
- Prefer a tightly related deterministic operation batch when every operation can be fully specified now and no later operation needs an identity/result created by an earlier one. Multiple gather_resource operations for known resources may be submitted together. When one exact observed entity needs multiple item types, prefer one supply_entity operation over separate transfer turns.
- Prefer local completion over ping-pong movement: before intentionally moving to another area, finish other already-decided operations on known targets in the current area when their ordering is independent. Do not invent targets or reorder user constraints, prerequisites, or observation-dependent work just to save walking.
- Do not insert wait between finite Autorio operations merely to let them finish. The harness resumes you when the submitted batch completes or fails. Use wait only when actual world time must pass and no Autorio-owned finite operation already represents the work.
- Runtime navigation/reach/obstacle recovery is internal progress, not a new plan step and not a reason to call the model again. Exact transfers, recipe configuration, rotation, exact placement, and mine_entity_exact may auto-approach using the controlled character's real reach.
- Treat absolute world coordinates as durable location references and unit_number as an ephemeral exact-entity binding. Use unit_number for an exact operation only after the current active request has live-observed that entity. Do not execute unit numbers copied only from durable plan/dialogue memory. To return to a known location, prefer walk_to_position using the stored absolute coordinate; then re-observe and bind the current entity before an exact mutation. A replacement at the same coordinate is a new identity. If a live observation supplied unit_number for the selected mineable entity, use mine_entity_exact and do not fall back to same-name mining. If no usable exact identity exists and the target was only observed beyond local mining range, approach it first; after navigation completes, continue the finite goal into mining automatically instead of waiting for another human message.
- Do not walk AIRI onto an exact future build coordinate just to place there. For ordinary unconstrained nearby placement, prefer place_entity {entity_name} with no invented coordinates; the runtime can choose a local non-colliding position. Use planPlacement/getLocalSpatialObservation/getPlacementCandidates when geometry matters or after a meaningful simple-placement blocker such as not_placeable/no_position.
- For resource-bound, shoreline-bound, or fluid-port-sensitive placement, call getPlacementCandidates and execute the chosen result with place_candidate {candidate_set_id,candidate_id}. Do not copy candidate coordinates into place_entity; candidate-id execution preserves runtime semantic revalidation.
- A cancelled batch stops the failing operation and its dependent queued operations. If the receipt says placing:not_placeable, that attempted placement did not create an entity. Never invent a new unit_number or claim that a cancelled placement succeeded; observe the world after a successful placement when a later exact operation needs the new identity.
- For a bounded local construction batch, use validateConstructionPlan on the exact chosen placements, then execute only the returned validation_id and placement_count with execute_construction_plan. Do not edit coordinates or directions after validation; revalidate instead. A clean completed construction batch is deterministic evidence that every validated placement succeeded.
- launch_rocket needs the exact live-observed rocket-silo unit_number and a ready rocket (getEntityStatus on the silo reports rocket_parts, rocket_parts_required and rocket_ready; the silo builds rocket parts itself from supplied ingredients). It completes only after the force's rocket count rises; rocket_not_ready means keep supplying the silo, not retry the launch.
- research_technology submission is not completed research; verify the actual technology before depending on it. wait is never proof that a world condition became true. Item transfers may be partial and need relevant verification before depending on an exact quantity.
- When simply continuing with another operation and the human does not need to act, set chatMessage to an empty string. Use chatMessage for a blocker, a decision that needs the human, or verified final completion. Keep status claims grounded: navigation completion proves arrival only and never means mining/construction/transfer/crafting has started unless that mutation is actually admitted/running or authoritative runtime evidence proves it.
- Never emit Lua, game.*, shell/console commands, or unapproved operations.

Approved operations and bounded arguments:
walk_to_entity {entity_name,search_radius}; walk_to_entity_exact {unit_number,reach_distance}; walk_to_position {x,y,reach_distance}; walk_to_player {player_name}; follow_player {player_name,follow_distance}; stop_follow_player {}; set_auto_defense {enabled}; equip_weapon {item_name,slot}; equip_ammo {item_name,slot}; equip_armor {item_name}; select_weapon_slot {slot}; mine_entity {entity_name,count}; mine_entity_exact {unit_number}; mine_resource_at {resource_name,x,y,count}; gather_resource {resource_name,count,search_radius}; harvest_product {product_name,count,search_radius}; clear_construction_area {x,y,width,height}; supply_entity {unit_number,items:[{item_name,count}]}; execute_construction_plan {validation_id,placement_count}; place_candidate {candidate_set_id,candidate_id}; place_entity {entity_name,x?,y?,direction?}; rotate_entity {unit_number,reverse}; move_items {item_name,entity_name,max_count,to_entity}; move_items_exact {item_name,unit_number,max_count,to_entity}; move_items_with_player {item_name,player_name,max_count,to_player}; set_machine_recipe {unit_number,recipe_name}; launch_rocket {unit_number}; craft_item {item_name,count}; attack_nearest_enemy {search_radius}; clear_enemy_area {search_radius}; research_technology {technology_name}; wait {ticks}.

Return exactly one strict JSON object with exactly these fields:
{"chatMessage":"","plan":["observable step"],"currentStep":0,"operations":[{"name":"approved_operation","args":{}}]}
plan is the visible canonical checklist proposal, currentStep indexes it, and operations contains only approved structured operations. If the whole goal is verified complete, return plan:[], currentStep:0, operations:[] and a short completion chatMessage.`

function sanitizePromptTraceValue(value, key = '') {
  if (SENSITIVE_PROMPT_KEY.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value
      .replace(/Bearer\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
      .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
      .replace(/\b(OPENAI_API_KEY|FACTORIO_TOKEN|API_KEY|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
  }
  if (Array.isArray(value)) return value.map(item => sanitizePromptTraceValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, sanitizePromptTraceValue(childValue, childKey)]))
}

class PromptTraceWriter {
  constructor(filename) {
    this.filename = filename
    this.queue = Promise.resolve()
    this.bytes = null
  }

  async initialize() {
    if (this.bytes !== null) return
    await fsp.mkdir(path.dirname(this.filename), { recursive: true })
    try { this.bytes = (await fsp.stat(this.filename)).size }
    catch (error) {
      if (error?.code !== 'ENOENT') throw error
      this.bytes = 0
    }
  }

  async rotate(incomingBytes) {
    await this.initialize()
    if (this.bytes + incomingBytes <= PROMPT_TRACE_MAX_BYTES) return
    await fsp.rm(`${this.filename}.${PROMPT_TRACE_FILES - 1}`, { force: true })
    for (let index = PROMPT_TRACE_FILES - 2; index >= 1; index--) {
      try { await fsp.rename(`${this.filename}.${index}`, `${this.filename}.${index + 1}`) }
      catch (error) { if (error?.code !== 'ENOENT') throw error }
    }
    try { await fsp.rename(this.filename, `${this.filename}.1`) }
    catch (error) { if (error?.code !== 'ENOENT') throw error }
    this.bytes = 0
  }

  emit(event) {
    const line = `${JSON.stringify(sanitizePromptTraceValue(event))}\n`
    const bytes = Buffer.byteLength(line)
    this.queue = this.queue.then(async () => {
      await this.rotate(bytes)
      await fsp.appendFile(this.filename, line, { encoding: 'utf8', mode: 0o600 })
      this.bytes += bytes
    })
    return this.queue
  }
}

function promptTraceFile(options = {}) {
  if (options.promptTraceFile === null) return null
  if (typeof options.promptTraceFile === 'string' && options.promptTraceFile.trim()) return path.resolve(options.promptTraceFile)
  if (typeof process.env.SGLUNA_PROMPT_TRACE_FILE === 'string' && process.env.SGLUNA_PROMPT_TRACE_FILE.trim()) {
    return path.resolve(process.env.SGLUNA_PROMPT_TRACE_FILE)
  }
  if (typeof process.env.AIRI_PROMPT_TRACE_FILE === 'string' && process.env.AIRI_PROMPT_TRACE_FILE.trim()) {
    return path.resolve(process.env.AIRI_PROMPT_TRACE_FILE)
  }
  if (process.env.NODE_TEST_CONTEXT) return null
  return path.resolve(process.cwd(), 'logs', 'sgluna-prompts.jsonl')
}

function promptTraceWriter(filename) {
  let writer = promptTraceWriters.get(filename)
  if (!writer) {
    writer = new PromptTraceWriter(filename)
    promptTraceWriters.set(filename, writer)
  }
  return writer
}

function promptTraceTrigger(messages, recoveryAttempt) {
  if (Number.isSafeInteger(recoveryAttempt) && recoveryAttempt > 0) return 'recovery'
  if (!Array.isArray(messages)) return 'continuation'
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.startsWith(COMPLETION_MARKER)) return 'completion'
    if (message.content.startsWith(FAILURE_MARKER)) return 'failure'
    if (message.content.startsWith(CHAT_MARKER)) return 'request'
    if (message.content.startsWith('[HARNESS]')) return 'recovery'
  }
  return 'continuation'
}

function promptTraceMessageChars(message) {
  return String(message?.content ?? '').length + JSON.stringify(message?.tool_calls ?? '').length
}

function promptTraceIdentity(options = {}) {
  const providerPolicy = options.providerPolicy && typeof options.providerPolicy === 'object'
    ? options.providerPolicy
    : undefined
  const capabilities = options.providerCapabilities && typeof options.providerCapabilities === 'object'
    ? options.providerCapabilities
    : undefined
  return {
    request_id: typeof options.requestId === 'string' ? options.requestId : undefined,
    round: Number.isSafeInteger(options.round) ? options.round : undefined,
    actor_id: Number.isSafeInteger(options.actorId) ? options.actorId : undefined,
    epoch: Number.isSafeInteger(options.epoch) ? options.epoch : undefined,
    recovery_attempt: Number.isSafeInteger(options.recoveryAttempt) ? options.recoveryAttempt : 0,
    allow_tools: options.allowTools !== false,
    reasoning_effort: typeof providerPolicy?.effort === 'string' ? providerPolicy.effort : undefined,
    reasoning_policy_reason: typeof providerPolicy?.reason === 'string' ? providerPolicy.reason : undefined,
    capability_profile: typeof capabilities?.id === 'string' ? capabilities.id : undefined,
  }
}

async function traceProviderPayload(body, options = {}) {
  const filename = promptTraceFile(options)
  if (!filename) return false
  try {
    const rawBody = JSON.stringify(body)
    const tools = Array.isArray(body?.tools) ? body.tools : []
    const tokenField = typeof options.providerCapabilities?.token_field === 'string'
      ? options.providerCapabilities.token_field
      : undefined
    await promptTraceWriter(filename).emit({
      schema: 1,
      event: 'provider.request',
      ts: new Date().toISOString(),
      ...promptTraceIdentity(options),
      trigger_source: promptTraceTrigger(body?.messages, options.recoveryAttempt),
      requested_token_field: tokenField,
      requested_output_cap: tokenField ? body?.[tokenField] : undefined,
      requested_reasoning_effort: typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
      requested_thinking_mode: typeof body?.thinking?.type === 'string' ? body.thinking.type : 'not_sent',
      payload: body,
      stats: {
        body_chars: rawBody.length,
        message_count: Array.isArray(body?.messages) ? body.messages.length : 0,
        message_chars: Array.isArray(body?.messages) ? body.messages.reduce((total, message) => total + promptTraceMessageChars(message), 0) : 0,
        tool_count: tools.length,
        tool_schema_chars: tools.length > 0 ? JSON.stringify(tools).length : 0,
      },
    })
    return true
  }
  catch {
    // Observability must never turn a valid provider request into a runtime failure.
    return false
  }
}

async function traceProviderResult(event, data, options = {}) {
  const filename = promptTraceFile(options)
  if (!filename) return false
  try {
    await promptTraceWriter(filename).emit({
      schema: 1,
      event,
      ts: new Date().toISOString(),
      ...promptTraceIdentity(options),
      ...data,
    })
    return true
  }
  catch {
    // Response diagnostics are best-effort and must never change provider behavior.
    return false
  }
}

function providerReasoningChars(message) {
  let total = 0
  for (const key of ['reasoning_content', 'reasoning', 'analysis']) {
    const value = message?.[key]
    if (typeof value === 'string') total += value.length
    else if (value && typeof value === 'object') {
      try { total += JSON.stringify(value).length }
      catch {}
    }
  }
  if (Array.isArray(message?.reasoning_details)) {
    try { total += JSON.stringify(message.reasoning_details).length }
    catch {}
  }
  return total
}

function structuredContentDiagnostics(content) {
  const text = String(content ?? '')
  if (!text) return { json_valid: false, plan_valid: false, error: 'empty content' }
  let parsed
  try { parsed = JSON.parse(text) }
  catch (error) {
    return {
      json_valid: false,
      plan_valid: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
  try {
    parsePlan(parsed)
    return { json_valid: true, plan_valid: true }
  }
  catch (error) {
    return {
      json_valid: true,
      plan_valid: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function contentShape(content) {
  const text = typeof content === 'string' ? content : ''
  let nonAsciiChars = 0
  let replacementChars = 0
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code > 0x7F) nonAsciiChars++
    if (code === 0xFFFD) replacementChars++
  }
  return {
    content_chars: text.length,
    content_utf8_bytes: Buffer.byteLength(text, 'utf8'),
    content_non_ascii_chars: nonAsciiChars,
    content_replacement_chars: replacementChars,
    content_preview: text.slice(0, PROMPT_RESPONSE_PREVIEW_CHARS),
  }
}

function isSuccessfulCompletionContinuation(messages, { allowTools, recoveryAttempt }) {
  if (!allowTools || recoveryAttempt > 0 || !Array.isArray(messages)) return false
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' && lastUser.content.startsWith(COMPLETION_MARKER)
}

function providerHostname(base) {
  try { return new URL(base).hostname.toLowerCase() }
  catch { return '' }
}

export function providerCapabilityProfile(config = {}) {
  const requested = String(config.profile ?? config.providerProfile ?? 'auto').trim().toLowerCase()
  check(PROVIDER_PROFILE_IDS.has(requested), 'Invalid provider capability profile')
  let resolved = requested
  if (resolved === 'auto') {
    // The official endpoint is a trustworthy capability signal even when the
    // configured model uses an alias. Unknown compatible gateways remain
    // generic unless the operator explicitly selects a provider profile.
    resolved = providerHostname(config.base) === 'api.deepseek.com'
      ? 'deepseek'
      : 'generic'
  }
  const profile = PROVIDER_PROFILES[resolved]
  return {
    ...profile,
    requested_profile: requested,
    auto_resolved: requested === 'auto',
  }
}

function validOutputCap(value) {
  check(Number.isSafeInteger(value) && value >= 1 && value <= MAX_PROVIDER_OUTPUT_CAP, `Provider output cap must be an integer from 1 to ${MAX_PROVIDER_OUTPUT_CAP}`)
  return value
}

function validateResponseFormat(value) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid response_format override')
  check(value.type === 'json_object' || value.type === 'json_schema', 'Unsupported response_format override')
  check(JSON.stringify(value).length <= 32768, 'response_format override is too large')
  return value
}

function applyRequestBodyPatch(body, patch, capability) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return
  for (const key of Object.keys(patch)) check(REQUEST_BODY_PATCH_KEYS.has(key), `requestBodyPatch key is not allowed: ${key}`)

  const hasMaxTokens = patch.max_tokens !== undefined
  const hasMaxCompletionTokens = patch.max_completion_tokens !== undefined
  if (hasMaxTokens && hasMaxCompletionTokens) {
    check(patch.max_tokens === patch.max_completion_tokens, 'Conflicting provider output cap overrides')
  }
  const outputCap = hasMaxCompletionTokens ? patch.max_completion_tokens : (hasMaxTokens ? patch.max_tokens : undefined)
  if (outputCap !== undefined) {
    delete body.max_tokens
    delete body.max_completion_tokens
    body[capability.token_field] = validOutputCap(outputCap)
  }

  if (patch.reasoning_effort !== undefined) {
    check(capability.reasoning_effort === true, 'Provider profile does not allow reasoning_effort')
    check(['none', 'minimal', 'low', 'medium', 'high', 'max'].includes(patch.reasoning_effort), 'Invalid reasoning_effort override')
    body.reasoning_effort = patch.reasoning_effort
  }
  if (patch.thinking !== undefined) {
    check(capability.thinking_control === 'deepseek', 'Provider profile does not allow thinking control')
    check(patch.thinking && typeof patch.thinking === 'object' && !Array.isArray(patch.thinking), 'Invalid thinking override')
    check(Object.keys(patch.thinking).length === 1 && ['enabled', 'disabled'].includes(patch.thinking.type), 'Invalid thinking override')
    body.thinking = { type: patch.thinking.type }
  }
  if (patch.response_format !== undefined) body.response_format = validateResponseFormat(patch.response_format)
}

function usageSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

function providerUsageNumbers(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return {}
  const input = usageSafeInteger(usage.prompt_tokens) ?? usageSafeInteger(usage.input_tokens)
  const output = usageSafeInteger(usage.completion_tokens) ?? usageSafeInteger(usage.output_tokens)
  const total = usageSafeInteger(usage.total_tokens)
  const reasoning = usageSafeInteger(usage.completion_tokens_details?.reasoning_tokens)
    ?? usageSafeInteger(usage.output_tokens_details?.reasoning_tokens)
    ?? usageSafeInteger(usage.reasoning_tokens)
  return { input, output, total, reasoning }
}

function safeProviderErrorText(value, max = 800) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

async function boundedProviderErrorBody(response, maxBytes = 64 * 1024) {
  if (!response?.body) return { text: '', bytes: 0, truncated: false }
  const reader = response.body.getReader()
  const chunks = []
  let bytes = 0
  let truncated = false
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    const remaining = maxBytes - bytes
    if (remaining <= 0) {
      truncated = true
      await reader.cancel()
      break
    }
    const chunk = value.length > remaining ? value.slice(0, remaining) : value
    chunks.push(chunk)
    bytes += chunk.length
    if (value.length > remaining) {
      truncated = true
      await reader.cancel()
      break
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes, truncated }
}

function providerHttpErrorDiagnostics(responseText) {
  let parsed
  try { parsed = JSON.parse(String(responseText ?? '')) }
  catch {}
  const rawError = parsed?.error && typeof parsed.error === 'object' && !Array.isArray(parsed.error)
    ? parsed.error
    : parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {}
  const code = safeProviderErrorText(rawError.code, 120)
  const type = safeProviderErrorText(rawError.type, 120)
  const message = safeProviderErrorText(rawError.message || rawError.detail || responseText, 1200)
  const classifier = `${code} ${type} ${message}`.toLowerCase()
  const contextWindowExceeded = /context[_ -]?(?:length|window)[_ -]?exceeded|maximum context length|context window (?:is |was )?(?:too small|exceeded)|prompt (?:is )?too long|input (?:is )?too long|too many (?:input|prompt) tokens|(?:input|prompt) token limit|(?:input|prompt).{0,80}exceeds?.{0,80}(?:context|token limit)/i.test(classifier)
  return {
    diagnostic_code: contextWindowExceeded ? 'provider_context_window_exceeded' : 'provider_http_error',
    provider_error_code: code || undefined,
    provider_error_type: type || undefined,
    provider_error_message: message || undefined,
  }
}

function topLevelJsonObjectSpans(text) {
  const spans = []
  let depth = 0
  let start = -1
  let inString = false
  let escaped = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (escaped) {
        escaped = false
        continue
      }
      if (char === '\\') {
        escaped = true
        continue
      }
      if (char === '"') inString = false
      continue
    }

    if (depth > 0 && char === '"') {
      inString = true
      continue
    }
    if (char === '{') {
      if (depth === 0) start = index
      depth++
      continue
    }
    if (char === '}' && depth > 0) {
      depth--
      if (depth === 0 && start >= 0) {
        spans.push([start, index + 1])
        start = -1
      }
    }
  }

  return depth === 0 && !inString ? spans : []
}

function validPlanCandidate(candidate) {
  try {
    parsePlan(JSON.parse(candidate))
    return true
  }
  catch {
    return false
  }
}

// DeepSeek sometimes leaks its native tool-call markup into `content` instead
// of returning `tool_calls` (live: `<｜｜DSML｜｜ invoke name="submitPlan">`).
// Parse it back into ordinary tool calls so they take the same admission path
// as a native call. `string="false"` parameters carry JSON values. Anything
// that does not parse completely is left as content for the format recovery.
// The optional group captures the closing slash with its leading space, so
// it never competes with the following \s* (no super-linear backtracking).
const DSML_TAG = String.raw`<(\s*/)?\s*[｜|]+\s*DSML\s*[｜|]+\s*`
const opening = group => group === undefined
const closing = group => group !== undefined
const DSML_CALLS = new RegExp(`${DSML_TAG}calls\\s*>([\\s\\S]*?)${DSML_TAG}calls\\s*>`)
const DSML_INVOKE = new RegExp(`${DSML_TAG}invoke\\s+name="([^"]+)"\\s*>([\\s\\S]*?)${DSML_TAG}invoke\\s*>`, 'g')
const DSML_PARAMETER = new RegExp(`${DSML_TAG}parameter\\s+name="([^"]+)"(?:\\s+string="(true|false)")?\\s*>([\\s\\S]*?)${DSML_TAG}parameter\\s*>`, 'g')

export function recoverDsmlToolCalls(content) {
  const text = String(content ?? '')
  const block = DSML_CALLS.exec(text)
  if (!block || !opening(block[1]) || !closing(block[3])) return undefined
  const calls = []
  for (const invoke of block[2].matchAll(DSML_INVOKE)) {
    if (!opening(invoke[1]) || !closing(invoke[4])) return undefined
    const args = {}
    for (const parameter of invoke[3].matchAll(DSML_PARAMETER)) {
      if (!opening(parameter[1]) || !closing(parameter[5])) return undefined
      const [, , key, isString, raw] = parameter
      if (isString === 'false') {
        try { args[key] = JSON.parse(raw) }
        catch { return undefined }
      }
      else {
        args[key] = raw
      }
    }
    calls.push({
      id: `call_dsml_${calls.length + 1}`,
      type: 'function',
      function: { name: invoke[2], arguments: JSON.stringify(args) },
    })
  }
  if (calls.length === 0) return undefined
  return { content: text.slice(0, block.index).trim(), tool_calls: calls }
}

export function normalizeProviderPlanContent(content) {
  const text = String(content ?? '').trim()
  if (!text) return text
  if (validPlanCandidate(text)) return text

  if (text.startsWith('```') && text.endsWith('```') && text.length >= 6) {
    let candidate = text.slice(3, -3).trim()
    if (candidate.slice(0, 4).toLowerCase() === 'json') candidate = candidate.slice(4).trim()
    if (validPlanCandidate(candidate)) return candidate
  }

  const spans = topLevelJsonObjectSpans(text)
  for (let index = spans.length - 1; index >= 0; index--) {
    const candidate = text.slice(spans[index][0], spans[index][1]).trim()
    if (validPlanCandidate(candidate)) return candidate
  }
  return text
}

function leanTaskBoard(board) {
  if (!board || typeof board !== 'object' || Array.isArray(board)) return undefined
  return {
    kind: board.kind,
    goal_id: board.goal_id,
    status: board.status,
    blocker: board.blocker,
    pause_reason: board.pause_reason,
    revision: board.revision,
    completed_count: board.completed_count,
    total_steps: board.total_steps,
    active_index: board.active_index,
    active_step_id: board.active_step_id,
    steps: Array.isArray(board.steps)
      ? board.steps.slice(0, 30).map(step => ({
          id: step?.id,
          description: step?.description,
          status: step?.status,
        }))
      : undefined,
    evidence: Array.isArray(board.evidence) ? board.evidence.slice(-4) : undefined,
  }
}

function parseStateBlock(content, marker, stopMarkers = []) {
  const text = String(content ?? '')
  const markerAt = text.lastIndexOf(marker)
  if (markerAt < 0) return undefined
  const block = text.slice(markerAt)
  const newlineAt = block.indexOf('\n')
  if (newlineAt < 0) return undefined
  let body = block.slice(newlineAt + 1)
  for (const stopMarker of stopMarkers) {
    const stop = body.indexOf(`\n${stopMarker}`)
    if (stop >= 0) body = body.slice(0, stop)
  }
  try {
    const state = JSON.parse(body.trim())
    return state && typeof state === 'object' && !Array.isArray(state) ? state : undefined
  }
  catch {
    return undefined
  }
}

function parsePlanStateFromContent(content) {
  return parseStateBlock(content, RUNTIME_COMPAT_STATE_MARKER, [PLANNING_STATE_MARKER])
    ?? parseStateBlock(content, PLAN_STATE_MARKER, [PLANNING_STATE_MARKER])
}

function parsePlanningStateFromContent(content) {
  return parseStateBlock(content, PLANNING_STATE_MARKER)
}

function currentPlanState(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (!message.content.includes(RUNTIME_COMPAT_STATE_MARKER) && !message.content.includes(PLAN_STATE_MARKER)) continue
    const state = parsePlanStateFromContent(message.content)
    if (state) return state
  }
  return undefined
}

function latestDirectChat(messages) {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const text = message.content.trim()
    if (!text.startsWith(CHAT_MARKER)) continue
    const body = text.slice(CHAT_MARKER.length).trim()
    const separator = body.indexOf(':')
    const sender = separator >= 0 ? body.slice(0, separator).trim() : 'unknown'
    const request = (separator >= 0 ? body.slice(separator + 1) : body).trim()
    return { sender: sender.slice(0, 128), text: request.slice(0, 1200) }
  }
  return undefined
}

function isResumeText(value) {
  const text = String(value ?? '').trim().toLocaleLowerCase()
  if (!text) return false
  const prefixes = ['continue', 'resume', '继续', '继续吧', '继续做', '接着', '接着做']
  return prefixes.some(prefix => text === prefix || text.startsWith(`${prefix} `) || text.startsWith(`${prefix}，`) || text.startsWith(`${prefix},`))
}

export function classifyUserSteering(messages) {
  const chat = latestDirectChat(messages)
  if (!chat) return undefined
  const state = currentPlanState(messages)
  const hasPendingGoal = state && state.status !== 'completed'
  const sameAsDurableObjective = hasPendingGoal
    && typeof state?.objective === 'string'
    && state.objective.trim() === chat.text.trim()
  const mode = isResumeText(chat.text)
    ? (hasPendingGoal ? 'resume_existing_goal' : 'new_goal')
    : sameAsDurableObjective
      ? 'current_goal'
      : (hasPendingGoal ? 'steer_existing_goal' : 'new_goal')
  return {
    mode,
    sender: chat.sender,
    text: chat.text,
    goal_id: state?.goal_id,
    goal_status: state?.status,
    active_step: state?.current_step_text,
  }
}

function latestFailure(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    if (message.content.startsWith(FAILURE_MARKER)) return message.content.slice(0, 5000)
  }
  return ''
}

function failureRecoveryHint(failure) {
  if (!failure) return ''
  if (/PLANNED_COLLISION|WORLD_COLLISION|placing:not_placeable|not_placeable/i.test(failure)) {
    return 'placement_failure: do not retry the same coordinate blindly; use returned footprint/blocker geometry or validate a revised local construction batch before execution'
  }
  if (/too_far/i.test(failure)) {
    return 'range_failure: do not create a walk/action/model loop; use exact target identity when available and let runtime reach recovery handle deterministic approach, re-observing only if the target itself is stale'
  }
  if (/target[^\n]{0,80}(?:missing|not found)|entity[^\n]{0,80}not found/i.test(failure)) {
    return 'stale_target: re-observe the exact entity identity instead of substituting an arbitrary same-name target'
  }
  if (/ITEMS_MISSING|missing items|insufficient inventory/i.test(failure)) {
    return 'inventory_failure: satisfy the deterministic inventory deficit before retrying the blocked construction/action'
  }
  return 'operation_failure: the failed operation and dependent queued operations are not successful; use the receipt to choose the smallest necessary recovery'
}

function steeringDomain(state, failure, userText = '') {
  const haystack = JSON.stringify({
    objective: state?.objective,
    step: state?.current_step_text,
    operations: state?.last_operations,
    blocker: state?.blocker,
    failure,
    userText,
  })
  if (/place_entity|placing|construction|PLANNED_COLLISION|WORLD_COLLISION|execute_construction_plan|validateConstructionPlan/i.test(haystack)) return 'construction'
  if (/gather_resource|mine_entity|mine_resource|mining/i.test(haystack)) return 'mining'
  if (/move_items|supply_entity|moving_items|transfer/i.test(haystack)) return 'logistics'
  if (/water|shore|coast|river|lake|terrain|tile|水边|岸边|海岸|[河湖水]|地形|地图/i.test(haystack)) return 'terrain'
  return 'general'
}

function receiptDelta(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'user' || typeof message.content !== 'string') continue
    const text = message.content
    if (!text.startsWith(COMPLETION_MARKER)) continue
    const receiptAt = text.indexOf('Detailed task receipt:')
    if (receiptAt < 0) return 'last_receipt=completed; treat the completion receipt as authoritative evidence for the submitted batch'
    try {
      const status = JSON.parse(text.slice(receiptAt + 'Detailed task receipt:'.length).trim())
      const batch = status?.last_completed_batch
      const types = Array.isArray(batch?.task_types) ? batch.task_types.slice(0, 6).join(',') : ''
      const resultCode = status?.basic_operation?.last_result?.code
      return `last_receipt=completed${Number.isSafeInteger(batch?.batch_id) ? ` batch=${batch.batch_id}` : ''}${types ? ` tasks=${types}` : ''}${resultCode ? ` result=${resultCode}` : ''}; do not re-check deterministic facts already proven by this receipt`
    }
    catch {
      return 'last_receipt=completed; treat the completion receipt as authoritative evidence for the submitted batch'
    }
  }
  return ''
}

export function buildSteeringContext(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return ''
  const state = currentPlanState(messages)
  const user = classifyUserSteering(messages)
  const failure = latestFailure(messages)
  const failureHint = failureRecoveryHint(failure)
  const domain = steeringDomain(state, failure, user?.text)
  const lines = [
    `${STEERING_MARKER} Harness-generated decision guidance; this is not Factorio world state.`,
    `domain=${domain}`,
    'decision_order=exact observed identity > nearest-name lookup; deterministic validator > trial-and-error action; small fully-parameterized batch > one-operation-per-turn; runtime fact > prototype fact > remembered game knowledge',
    'batch_boundary=stop before an operation that needs a new unit_number, mutable result, or other observation that does not exist yet',
    'locality=before intentionally crossing to another area, finish other already-decided operations on known current-area targets when their order is independent; do not invent targets or reorder user constraints, prerequisites, or observation-dependent work just to save walking',
    'success_evidence=never claim a world-changing action succeeded from intent alone; require an operation receipt or subsequent observation',
  ]

  if (user) {
    lines.push(`user_mode=${user.mode}${user.goal_id ? ` goal=${user.goal_id}` : ''}${user.goal_status ? ` status=${user.goal_status}` : ''}`)
    lines.push(`latest_human=${JSON.stringify(user.text)}`)
    if (user.mode === 'steer_existing_goal') {
      lines.push('user_steering=the latest human instruction is authoritative for pending intent; preserve verified completed evidence, revise/reorder/drop remaining steps as needed, and do not treat the older durable objective as overriding this steering')
    }
    else if (user.mode === 'resume_existing_goal') {
      lines.push('user_steering=resume the existing durable goal; do not reinterpret a bare continue/resume as a new independent goal')
    }
    else if (user.mode === 'current_goal') {
      lines.push('user_steering=this is the original current durable goal, not a new mid-plan steering event; preserve completed evidence and continue the canonical active plan unless live evidence requires a replan')
    }
    else {
      lines.push('user_steering=treat this as the current human goal; prior completed history is context, not an instruction to continue an older goal')
    }
  }

  if (domain === 'construction') {
    lines.push('construction=physical collision footprint != mining/working area != selection box != pickup/drop position; validate multiple exact placements together before executing them')
  }
  if (domain === 'terrain') {
    lines.push('terrain=use getLocalSpatialObservation for live bounded terrain before terrain-dependent movement or construction; terrain_tiles.runs are compact exact tile runs, and water is a tile, not an entity')
  }
  if (failureHint) lines.push(`recovery=${failureHint}`)
  const delta = receiptDelta(messages)
  if (delta) lines.push(delta)
  return lines.join('\n').slice(0, 3600)
}

export function applySteeringMessages(messages, sourceMessages = messages) {
  const output = Array.isArray(messages) ? messages.map(message => ({ ...message })) : []
  const steering = buildSteeringContext(sourceMessages)
  if (!steering) return output
  const steeringMessage = { role: 'user', content: steering }
  const last = output.at(-1)
  const terminalInstruction = last?.role === 'user'
    && typeof last.content === 'string'
    && (last.content.startsWith('[MOD]') || last.content.startsWith('[HARNESS]'))
  if (terminalInstruction) {
    output.splice(Math.max(0, output.length - 1), 0, steeringMessage)
  }
  else {
    output.push(steeringMessage)
  }
  return output
}

function compactRuntimeCompatState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined
  return {
    goal_id: state.goal_id,
    owner: state.owner,
    objective: state.objective,
    status: state.status,
    admission_status: state.admission_status,
    blocker: state.blocker,
    pause_reason: state.pause_reason,
    persistent_runtime: state.persistent_runtime,
    task_board: leanTaskBoard(state.task_board),
    entity_references: Array.isArray(state.entity_references) ? state.entity_references.slice(-8) : undefined,
    revision: state.revision,
    last_operations: Array.isArray(state.last_operations) ? state.last_operations.slice(-16) : undefined,
  }
}

function compactPlanningState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return undefined
  const roadmap = state.roadmap && typeof state.roadmap === 'object'
    ? {
        roadmap_revision_id: state.roadmap.roadmap_revision_id,
        revision_index: state.roadmap.revision_index,
        nodes: Array.isArray(state.roadmap.nodes)
          ? state.roadmap.nodes.slice(0, 20).map(node => ({
              id: node?.id,
              intent: node?.intent,
              status: node?.status,
              depends_on: Array.isArray(node?.depends_on) ? node.depends_on.slice(0, 12) : undefined,
              development_hint: node?.development_hint,
            }))
          : [],
      }
    : null
  const tracker = state.plan_tracker && typeof state.plan_tracker === 'object'
    ? {
        plan_id: state.plan_tracker.plan_id,
        plan_version: state.plan_tracker.plan_version,
        status: state.plan_tracker.status,
        development_mode: state.plan_tracker.development_mode,
        active_step_id: state.plan_tracker.active_step_id,
        active_step_index: state.plan_tracker.active_step_index,
        roadmap_node_ids: Array.isArray(state.plan_tracker.roadmap_node_ids) ? state.plan_tracker.roadmap_node_ids.slice(0, 16) : [],
        derived_from_plan_id: state.plan_tracker.derived_from_plan_id,
        steps: Array.isArray(state.plan_tracker.steps)
          ? state.plan_tracker.steps.slice(0, 30).map(step => ({
              step_id: step?.step_id,
              description: step?.description,
              status: step?.status,
              completion_contract: step?.completion_contract,
              reduced_confidence: step?.reduced_confidence,
              evidence_refs: Array.isArray(step?.evidence_refs) ? step.evidence_refs.slice(-8) : [],
            }))
          : [],
      }
    : state.plan_tracker
  return {
    goal: state.goal,
    roadmap,
    steering: state.steering,
    plan_tracker: tracker,
  }
}

export function compactPlanStateContent(content) {
  const text = String(content ?? '')
  const runtimeState = parsePlanStateFromContent(text)
  const planningState = parsePlanningStateFromContent(text)
  const runtimeMarkerAt = text.lastIndexOf(RUNTIME_COMPAT_STATE_MARKER)

  if (!runtimeState && !planningState) {
    if (text.startsWith(MEMORY_MARKER)) {
      return '[MEMORY COMPACTED] Prior dialogue is omitted for this successful deterministic continuation; use the original current chat request, previous assistant plan, and live tools when needed.'
    }
    return text
  }

  const blocks = []
  if (runtimeState) {
    const marker = runtimeMarkerAt >= 0 ? RUNTIME_COMPAT_STATE_MARKER : PLAN_STATE_MARKER
    const label = marker === PLAN_STATE_MARKER
      ? 'Compact legacy compatibility state for this successful continuation.'
      : 'Compact runtime compatibility state; not planning authority.'
    blocks.push(`${marker} ${label}\n${JSON.stringify(compactRuntimeCompatState(runtimeState))}`)
  }
  if (planningState) {
    blocks.push(`${PLANNING_STATE_MARKER} Compact reducer-owned planning authority for this successful continuation.\n${JSON.stringify(compactPlanningState(planningState))}`)
  }
  return blocks.join('\n')
}

export function compactCompletionReceipt(content) {
  const text = String(content ?? '')
  if (!text.startsWith(COMPLETION_MARKER)) return text
  const receiptAt = text.indexOf('Detailed task receipt:')
  if (receiptAt < 0) return text
  const raw = text.slice(receiptAt + 'Detailed task receipt:'.length).trim()
  try {
    const status = JSON.parse(raw)
    if (!status || typeof status !== 'object' || Array.isArray(status)) return text
    const lean = {
      task_state: status.task_state,
      queue_empty: status.queue_empty,
      queue_length: status.queue_length,
      last_completed_batch: status.last_completed_batch,
      last_cancelled_batch: status.last_cancelled_batch,
      basic_operation: status.basic_operation?.last_result
        ? { last_result: status.basic_operation.last_result }
        : undefined,
    }
    return `${COMPLETION_MARKER} Compact task receipt: ${JSON.stringify(lean)}`
  }
  catch {
    return text
  }
}

export function compactCompletionMessages(messages) {
  let replacedSystem = false
  return messages.map((message) => {
    if (!replacedSystem && message?.role === 'system') {
      replacedSystem = true
      return { ...message, content: COMPACT_CONTINUATION_PROMPT }
    }
    if (message?.role === 'user' && typeof message.content === 'string') {
      if (message.content.startsWith(COMPLETION_MARKER)) {
        return { ...message, content: compactCompletionReceipt(message.content) }
      }
      if (message.content.startsWith(MEMORY_MARKER)
        || message.content.includes(RUNTIME_COMPAT_STATE_MARKER)
        || message.content.includes(PLANNING_STATE_MARKER)
        || message.content.includes(PLAN_STATE_MARKER)) {
        return { ...message, content: compactPlanStateContent(message.content) }
      }
    }
    return { ...message }
  })
}

export function compactCompletionTools(definitions = toolDefinitions) {
  return definitions.map((tool) => {
    if (tool?.type !== 'function' || !tool.function) return tool
    const description = typeof tool.function.description === 'string'
      ? tool.function.description.replace(/\s+/g, ' ').trim().slice(0, 120)
      : undefined
    return {
      ...tool,
      function: {
        ...tool.function,
        ...(description ? { description } : {}),
      },
    }
  })
}

export function providerEndpoint(base) {
  let url
  try { url = new URL(base) }
  catch { throw new DeploymentError('Invalid provider URL') }
  check(!url.username && !url.password && !url.search && !url.hash, 'Provider URL cannot contain credentials, query, or fragment')
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Remote provider URL requires HTTPS')
  url.pathname = `${url.pathname.replace(/\/?$/, '/')}chat/completions`
  return url.toString()
}

export async function providerRequest(config, messages, {
  fetchImpl = fetch,
  signal,
  allowTools = true,
  recoveryAttempt = 0,
  recoveryKind,
  round,
  epoch,
  actorId,
  requestId,
  promptTraceFile: traceFile,
  requestBodyPatch,
  providerPolicy,
  forceFullPlanner = false,
} = {}) {
  check(typeof config.key === 'string' && config.key.trim().length > 0, 'OPENAI_API_KEY is missing')
  check(typeof config.model === 'string' && /^[a-zA-Z0-9._:/-]{1,200}$/.test(config.model), 'Invalid model identifier')
  check(Array.isArray(messages) && messages.length > 0 && messages.length <= 50, 'Invalid provider message history')
  check(typeof allowTools === 'boolean', 'Invalid tool availability flag')
  check(typeof forceFullPlanner === 'boolean', 'Invalid full-planner override')
  check(Number.isSafeInteger(recoveryAttempt) && recoveryAttempt >= 0 && recoveryAttempt <= 100, 'Invalid provider recovery attempt')
  check(recoveryKind === undefined || recoveryKind === 'output_budget_exhaustion', 'Invalid provider recovery kind')
  const timeoutMs = config.timeoutMs ?? 120000
  check(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= 600000, 'Provider timeout must be an integer from 1000 to 600000 ms')

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  const outputBudgetRecovery = recoveryKind === 'output_budget_exhaustion'
  const compactContinuation = outputBudgetRecovery
    || (!forceFullPlanner && isSuccessfulCompletionContinuation(messages, { allowTools, recoveryAttempt }))
  const compactedMessages = compactContinuation ? compactCompletionMessages(messages) : messages
  const capability = providerCapabilityProfile(config)
  check(!allowTools || capability.tool_support === true, 'Provider profile does not allow tool calls')
  const disableThinking = compactContinuation && capability.thinking_control === 'deepseek'
  const compactReasoningDisabled = outputBudgetRecovery && capability.reasoning_effort === true
  const body = {
    model: config.model,
    messages: applySteeringMessages(compactedMessages, messages),
  }
  body[capability.token_field] = compactContinuation
    ? ((disableThinking || compactReasoningDisabled) ? COMPLETION_MAX_TOKENS : FALLBACK_CONTINUATION_MAX_TOKENS)
    : DEFAULT_MAX_TOKENS
  if (disableThinking) body.thinking = { type: 'disabled' }
  if (allowTools) {
    body.tools = compactContinuation ? compactCompletionTools(toolDefinitions) : toolDefinitions
    body.tool_choice = 'auto'
  }
  applyRequestBodyPatch(body, requestBodyPatch, capability)
  const requestedOutputCap = body[capability.token_field]

  const traceOptions = {
    round,
    epoch,
    actorId,
    requestId,
    recoveryAttempt,
    allowTools,
    promptTraceFile: traceFile,
    providerPolicy,
    providerCapabilities: capability,
  }
  await traceProviderPayload(body, traceOptions)

  try {
    const response = await fetchImpl(providerEndpoint(config.base), {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.key}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorBody = await boundedProviderErrorBody(response)
      const diagnostics = providerHttpErrorDiagnostics(errorBody.text)
      await traceProviderResult('provider.response_error', {
        ...diagnostics,
        http_status: response.status,
        response_bytes: errorBody.bytes,
        response_truncated: errorBody.truncated,
      }, traceOptions)
      const failure = diagnostics.diagnostic_code === 'provider_context_window_exceeded'
        ? new DeploymentError(`provider_context_window_exceeded: Provider HTTP ${response.status} reported context/input token limit exhaustion`)
        : new DeploymentError(`Provider HTTP ${response.status}; request will not be retried automatically`)
      failure.code = diagnostics.diagnostic_code
      if (diagnostics.diagnostic_code === 'provider_context_window_exceeded') failure.failureClass = 'provider_budget'
      throw failure
    }
    if (!response.body) {
      await traceProviderResult('provider.response_error', {
        diagnostic_code: 'provider_missing_response_body',
        http_status: response.status,
      }, traceOptions)
      throw new DeploymentError('Provider returned no response body')
    }
    const reader = response.body.getReader()
    const chunks = []
    let bytes = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      bytes += value.length
      if (bytes > 256 * 1024) {
        await reader.cancel()
        await traceProviderResult('provider.response_error', {
          diagnostic_code: 'provider_response_too_large',
          response_bytes: bytes,
        }, traceOptions)
        throw new DeploymentError('Provider response too large')
      }
      chunks.push(value)
    }

    const responseText = Buffer.concat(chunks).toString('utf8')
    let data
    try { data = JSON.parse(responseText) }
    catch (error) {
      await traceProviderResult('provider.response_error', {
        diagnostic_code: 'provider_body_invalid_json',
        response_bytes: bytes,
        response_chars: responseText.length,
        parse_error: error instanceof Error ? error.message : String(error),
        response_first_nonspace: responseText.trimStart().slice(0, 1),
      }, traceOptions)
      throw new DeploymentError('Provider returned invalid JSON')
    }
    const choice = data?.choices?.[0]
    const message = choice?.message
    if (!message || typeof message !== 'object') {
      await traceProviderResult('provider.response_error', {
        diagnostic_code: 'provider_missing_assistant_message',
        response_bytes: bytes,
        response_id: typeof data?.id === 'string' ? data.id : undefined,
        model: typeof data?.model === 'string' ? data.model : config.model,
        choice_keys: choice && typeof choice === 'object' ? Object.keys(choice) : [],
      }, traceOptions)
    }
    check(message && typeof message === 'object', 'Provider response has no assistant message')

    const rawContent = typeof message.content === 'string' ? message.content : ''
    const rawShape = contentShape(rawContent)
    const reasoningContentChars = providerReasoningChars(message)
    const dsml = message.tool_calls === undefined && typeof message.content === 'string'
      ? recoverDsmlToolCalls(message.content)
      : undefined
    let dsmlRecovered
    if (dsml && !allowTools) {
      // No tools were offered, so only a leaked submitPlan is usable: its
      // arguments are the plan object the content was supposed to hold.
      const sole = dsml.tool_calls.length === 1 && dsml.tool_calls[0].function.name === 'submitPlan'
      if (sole) {
        message.content = dsml.tool_calls[0].function.arguments
        dsmlRecovered = 'submit_plan_content'
      }
    }
    else if (dsml) {
      message.content = dsml.content
      message.tool_calls = dsml.tool_calls
      dsmlRecovered = 'tool_calls'
    }
    const toolCallCount = Array.isArray(message.tool_calls) ? message.tool_calls.length : 0
    if (message.tool_calls === undefined && typeof message.content === 'string') {
      message.content = normalizeProviderPlanContent(message.content)
    }
    const normalizedContent = typeof message.content === 'string' ? message.content : ''
    const structured = message.tool_calls === undefined
      ? structuredContentDiagnostics(normalizedContent)
      : undefined
    const finishReason = choice?.finish_reason
    const usageNumbers = providerUsageNumbers(data?.usage)
    const usageComplete = usageNumbers.input !== undefined
      && usageNumbers.output !== undefined
      && usageNumbers.total !== undefined
      && usageNumbers.total >= usageNumbers.input
      && usageNumbers.total >= usageNumbers.output
      && (usageNumbers.reasoning === undefined || usageNumbers.reasoning <= usageNumbers.output)
    const capEnforcementAnomaly = Number.isSafeInteger(requestedOutputCap)
      && usageNumbers.output !== undefined
      && usageNumbers.output > requestedOutputCap
    const safetyFinish = ['content_filter', 'safety', 'blocked'].includes(String(finishReason ?? '').toLowerCase())
    let diagnosticCode = finishReason === 'length'
      ? (rawShape.content_chars === 0 && toolCallCount === 0 ? 'provider_output_budget_exhausted' : 'provider_output_truncated')
      : safetyFinish
        ? 'provider_safety_blocked'
        : (rawShape.content_chars === 0 && toolCallCount === 0 ? 'provider_empty_content' : 'ok')
    if (diagnosticCode === 'ok' && structured?.json_valid === false) diagnosticCode = 'provider_content_invalid_json'
    else if (diagnosticCode === 'ok' && structured?.json_valid === true && structured?.plan_valid === false) diagnosticCode = 'provider_content_schema_invalid'
    if (capEnforcementAnomaly && diagnosticCode === 'ok') diagnosticCode = 'provider_output_cap_ignored'
    const providerDiagnostics = {
      response_id: typeof data?.id === 'string' ? data.id : undefined,
      model: typeof data?.model === 'string' ? data.model : config.model,
      finish_reason: finishReason,
      usage: data?.usage && typeof data.usage === 'object' ? data.usage : undefined,
      diagnostic_code: diagnosticCode,
      output_budget_exhausted: diagnosticCode === 'provider_output_budget_exhausted',
      response_bytes: bytes,
      choice_keys: choice && typeof choice === 'object' ? Object.keys(choice) : [],
      message_keys: Object.keys(message),
      tool_call_count: toolCallCount,
      dsml_recovery: dsmlRecovered,
      reasoning_content_chars: reasoningContentChars,
      ...rawShape,
      normalized_content_chars: normalizedContent.length,
      structured_content: structured,
      reasoning_effort: typeof providerPolicy?.effort === 'string' ? providerPolicy.effort : undefined,
      reasoning_policy_reason: typeof providerPolicy?.reason === 'string' ? providerPolicy.reason : undefined,
      capability_profile: capability.id,
      requested_profile: capability.requested_profile,
      requested_token_field: capability.token_field,
      requested_output_cap: requestedOutputCap,
      requested_reasoning_effort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
      requested_thinking_mode: typeof body.thinking?.type === 'string' ? body.thinking.type : 'not_sent',
      reported_reasoning_tokens: usageNumbers.reasoning,
      reported_output_tokens: usageNumbers.output,
      usage_complete: usageComplete,
      cap_enforcement_anomaly: capEnforcementAnomaly,
    }

    await traceProviderResult('provider.response', providerDiagnostics, traceOptions)
    Object.defineProperty(message, '_airiProvider', {
      configurable: true,
      enumerable: false,
      value: providerDiagnostics,
    })
    return message
  }
  catch (error) {
    if (signal?.aborted) {
      await traceProviderResult('provider.response_error', {
        diagnostic_code: 'provider_cancelled',
        message: 'Provider request cancelled',
      }, traceOptions)
      throw new DeploymentError('Provider request cancelled')
    }
    if (timeoutSignal.aborted) {
      await traceProviderResult('provider.response_error', {
        diagnostic_code: 'provider_timeout',
        timeout_ms: timeoutMs,
      }, traceOptions)
      throw new DeploymentError(`Provider timed out after ${timeoutMs} ms`)
    }
    throw error
  }
}