import { check, DeploymentError } from './common.mjs'
import { providerCapabilityProfile, providerRequest as baseProviderRequest } from './provider-base.mjs'

export * from './provider-base.mjs'

const COMPLETION_MARKER = '[MOD] Autorio operation batch completed.'
const FAILURE_MARKER = '[MOD] Autorio operation error:'
const CHAT_MARKER = '[CHAT]'
const FULL_PLANNER_FALLBACK_OUTPUT_BUDGET = 4000

function deepSeekModel(config) {
  return /^deepseek(?:[-_./:]|$)/i.test(String(config?.model ?? ''))
}

function lastUserContent(messages) {
  if (!Array.isArray(messages)) return ''
  const lastUser = [...messages].reverse().find(message => message?.role === 'user')
  return typeof lastUser?.content === 'string' ? lastUser.content : ''
}

function completionContinuation(messages, options = {}) {
  if (options.allowTools === false || (options.recoveryAttempt ?? 0) > 0) return false
  return lastUserContent(messages).startsWith(COMPLETION_MARKER)
}

function currentDifficultySignals(messages) {
  if (!Array.isArray(messages)) return 0
  let start = 0
  for (let index = 0; index < messages.length; index++) {
    const content = messages[index]?.role === 'user' && typeof messages[index].content === 'string'
      ? messages[index].content
      : ''
    if (content.startsWith(CHAT_MARKER) || content.startsWith(COMPLETION_MARKER)) start = index
  }

  let failures = 0
  for (let index = start + 1; index < messages.length; index++) {
    const content = messages[index]?.role === 'user' && typeof messages[index].content === 'string'
      ? messages[index].content
      : ''
    if (!content) continue
    if (content.startsWith(FAILURE_MARKER)) {
      failures++
      continue
    }
    if (!content.startsWith('[HARNESS]')) continue
    if (/Tool-validation failure|Repeated tool observation loop|Recovery attempt \d+ was invalid|Invalid provider content|invalid tool call|admission|preflight/i.test(content)) {
      failures++
    }
  }
  return failures
}

function semanticBudgetPolicy(value) {
  if (value === 'micro') return { effort: 'low', reason: 'jev_budget_micro' }
  if (value === 'normal') return { effort: 'high', reason: 'jev_budget_normal' }
  if (value === 'deep') return { effort: 'max', reason: 'jev_budget_deep' }
  if (value === 'strategic') return { effort: 'max', reason: 'jev_budget_strategic' }
  return undefined
}

export function selectReasoningPolicy(config, messages, options = {}) {
  const capabilities = providerCapabilityProfile(config)
  if (!capabilities.reasoning_effort) return undefined
  // Auto may infer wire capabilities from the official endpoint, but dynamic
  // reasoning policy still requires a DeepSeek model identity. This preserves
  // conservative behavior for endpoint aliases while explicit profiles remain
  // authoritative for compatible gateways.
  if (capabilities.requested_profile === 'auto' && capabilities.id === 'deepseek' && !deepSeekModel(config)) return undefined
  if (options.interactionRouter === true) {
    return { effort: 'none', reason: 'interaction_router' }
  }
  if (options.recoveryKind === 'output_budget_exhaustion') {
    return { effort: 'none', reason: 'output_budget_recovery' }
  }
  if (options.actionOmissionRepair === true) {
    return { effort: 'low', reason: 'action_omission_repair' }
  }
  if (Number.isSafeInteger(options.recoveryAttempt) && options.recoveryAttempt > 0) {
    return { effort: 'none', reason: 'strict_recovery' }
  }
  const semanticBudget = semanticBudgetPolicy(options.reasoningBudget)
  if (semanticBudget) return semanticBudget
  if (options.triggerSource === 'amend_current') {
    return { effort: 'high', reason: 'same_goal_amendment' }
  }
  if (options.triggerSource === 'new_goal') {
    return { effort: 'high', reason: 'new_goal' }
  }
  if (options.triggerSource === 'post_step_continue') {
    return { effort: 'low', reason: 'jev_post_step_continue' }
  }
  if (options.triggerSource === 'post_step_observe') {
    return { effort: 'low', reason: 'jev_post_step_observe' }
  }
  if (options.triggerSource === 'post_step_reanchor') {
    return { effort: 'low', reason: 'jev_post_step_reanchor' }
  }
  if (options.triggerSource === 'post_step_replan') {
    return { effort: 'high', reason: 'jev_post_step_replan' }
  }
  if (options.triggerSource === 'recovery_continue_low') {
    return { effort: 'low', reason: 'jev_recovery_continue' }
  }
  if (options.triggerSource === 'recovery_replan_high') {
    return { effort: 'high', reason: 'jev_recovery_replan' }
  }
  if (completionContinuation(messages, options)) {
    return { effort: 'low', reason: 'deterministic_completion' }
  }

  const failures = currentDifficultySignals(messages)
  if (failures >= 2) return { effort: 'low', reason: 'repeated_failure_compact_finalize' }
  if (failures === 1 || options.triggerSource === 'failure') {
    return { effort: 'high', reason: 'ordinary_replan' }
  }

  if (options.triggerSource === 'continue_current') {
    return { effort: 'low', reason: 'same_goal_continue' }
  }
  return { effort: 'high', reason: 'ordinary_planning' }
}

function reasoningOutputBudget(policy) {
  switch (policy?.reason) {
    case 'jev_budget_strategic': return 8000
    case 'jev_budget_deep': return 7000
    case 'jev_budget_normal': return 5000
    case 'ordinary_replan':
    case 'jev_post_step_replan':
    case 'jev_recovery_replan':
      return 6000
    case 'same_goal_continue':
    case 'jev_post_step_observe':
    case 'jev_recovery_continue':
      return 3000
    case 'repeated_failure_compact_finalize':
      return 2000
    default:
      if (policy?.effort === 'max') return 6000
      if (policy?.effort === 'high') return 4000
      return undefined
  }
}

function reasoningBodyPatch(policy, capabilities) {
  const patch = {}
  if (capabilities.reasoning_effort) {
    patch.reasoning_effort = capabilities.id === 'openai-reasoning'
      ? (policy.effort === 'none' ? 'minimal' : policy.effort === 'max' ? 'high' : policy.effort)
      : policy.effort
  }
  if (capabilities.thinking_control === 'deepseek') {
    patch.thinking = { type: policy.effort === 'none' ? 'disabled' : 'enabled' }
  }
  return patch
}

/**
 * Provider policy shim.
 *
 * The runtime selects a deterministic reasoning policy from observable request
 * state. Wire-level capability encoding is explicit through the configured
 * provider profile. Auto mode recognizes only the official DeepSeek endpoint;
 * unknown OpenAI-compatible gateways fail closed to generic fields.
 */
export async function providerRequest(config, messages, options = {}) {
  const capabilities = providerCapabilityProfile(config)
  const policy = selectReasoningPolicy(config, messages, options)
  if (!policy) return baseProviderRequest(config, messages, options)

  const semanticBudgetNeedsFullPlanner = ['normal', 'deep', 'strategic'].includes(options.reasoningBudget)
  const isCompletionContinuation = completionContinuation(messages, options)
  const compactPath = options.recoveryKind === 'output_budget_exhaustion'
    || (
      isCompletionContinuation
      && options.triggerSource !== 'post_step_replan'
      && !semanticBudgetNeedsFullPlanner
    )
  const forceFullPlanner = isCompletionContinuation && !compactPath
  const callerPatch = options.requestBodyPatch && typeof options.requestBodyPatch === 'object' && !Array.isArray(options.requestBodyPatch)
    ? options.requestBodyPatch
    : {}
  const policyBudget = !compactPath && callerPatch.max_tokens === undefined && callerPatch.max_completion_tokens === undefined
    ? (reasoningOutputBudget(policy) ?? (forceFullPlanner ? FULL_PLANNER_FALLBACK_OUTPUT_BUDGET : undefined))
    : undefined
  const requestOptions = {
    ...options,
    forceFullPlanner,
    requestBodyPatch: {
      ...(policyBudget !== undefined ? { max_tokens: policyBudget } : {}),
      ...callerPatch,
      ...reasoningBodyPatch(policy, capabilities),
    },
    providerPolicy: {
      ...policy,
      capability_profile: capabilities.id,
    },
  }

  return baseProviderRequest(config, messages, requestOptions)
}


export const DECISION_PROVIDER_DEFAULTS = Object.freeze({
  provider: 'typesafe',
  url: 'https://api.typesafe.ai/v1/systemone',
  model: 'jev-latest',
  timeoutMs: 5000,
  maxRequestsPerHour: 600,
  // A local cost guard, not a TypeSafe API limit. The post-step boundary's 19
  // questions alone serialize to ~15k characters, so the old 16k default made
  // every live post-step call fall back before reaching Jev.
  maxInputChars: 48000,
  maxQuestions: 24,
})

function decisionProviderInteger(value, fallback, name, min, max) {
  const parsed = value === undefined ? fallback : Number(value)
  check(Number.isSafeInteger(parsed) && parsed >= min && parsed <= max, `${name} must be an integer from ${min} to ${max}`)
  return parsed
}

export function decisionProviderEndpoint(value) {
  let url
  try { url = new URL(String(value ?? '')) }
  catch { throw new DeploymentError('Invalid decision provider URL') }
  check(!url.username && !url.password && !url.search && !url.hash, 'Decision provider URL cannot contain credentials, query, or fragment')
  check(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)), 'Remote decision provider URL requires HTTPS')
  check(url.pathname && url.pathname !== '/', 'Decision provider URL must include an API endpoint path')
  return url.toString()
}

export function decisionProviderConfiguration(env = process.env) {
  const key = env.DECISION_PROVIDER_API_KEY ?? env.TYPESAFE_API_KEY ?? ''
  if (typeof key !== 'string' || key.trim().length === 0) return undefined

  check(!/[\r\n\0]/.test(key), 'Decision provider API key is malformed')

  const url = decisionProviderEndpoint(env.DECISION_PROVIDER_API_URL ?? DECISION_PROVIDER_DEFAULTS.url)
  const model = String(env.DECISION_PROVIDER_MODEL ?? DECISION_PROVIDER_DEFAULTS.model).trim()
  check(/^[a-zA-Z0-9._:/-]{1,200}$/.test(model), 'Invalid decision provider model identifier')

  return {
    provider: DECISION_PROVIDER_DEFAULTS.provider,
    key,
    url,
    model,
    timeoutMs: decisionProviderInteger(
      env.DECISION_PROVIDER_TIMEOUT_MS,
      DECISION_PROVIDER_DEFAULTS.timeoutMs,
      'DECISION_PROVIDER_TIMEOUT_MS',
      100,
      30000,
    ),
    maxRequestsPerHour: decisionProviderInteger(
      env.MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR,
      DECISION_PROVIDER_DEFAULTS.maxRequestsPerHour,
      'MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR',
      1,
      1200,
    ),
    maxInputChars: decisionProviderInteger(
      env.DECISION_PROVIDER_MAX_INPUT_CHARS,
      DECISION_PROVIDER_DEFAULTS.maxInputChars,
      'DECISION_PROVIDER_MAX_INPUT_CHARS',
      1024,
      150000,
    ),
    maxQuestions: decisionProviderInteger(
      env.DECISION_PROVIDER_MAX_QUESTIONS,
      DECISION_PROVIDER_DEFAULTS.maxQuestions,
      'DECISION_PROVIDER_MAX_QUESTIONS',
      1,
      512,
    ),
  }
}

// Largest per-value error of a probability reported with two decimals.
const DECISION_PROBABILITY_ROUNDING = 0.005

const DECISION_ENTRY_LIMITS = Object.freeze({
  maxDepth: 12,
  maxCollectionItems: 128,
  maxStringChars: 8000,
  maxNodes: 1024,
  maxObjectKeyChars: 200,
})

function plainDecisionObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function validateDecisionEntryValue(value, label, depth, budget) {
  check(depth <= DECISION_ENTRY_LIMITS.maxDepth, `${label} exceeds maximum structured depth ${DECISION_ENTRY_LIMITS.maxDepth}`)
  budget.nodes++
  check(budget.nodes <= DECISION_ENTRY_LIMITS.maxNodes, `${label} exceeds maximum structured node count ${DECISION_ENTRY_LIMITS.maxNodes}`)

  if (value === null) return
  if (typeof value === 'string') {
    check(value.length <= DECISION_ENTRY_LIMITS.maxStringChars, `${label} contains a string longer than ${DECISION_ENTRY_LIMITS.maxStringChars} characters`)
    return
  }
  if (typeof value === 'number') {
    check(Number.isFinite(value), `${label} contains a non-finite number`)
    return
  }
  if (typeof value === 'boolean') return

  if (Array.isArray(value)) {
    check(value.length <= DECISION_ENTRY_LIMITS.maxCollectionItems, `${label} contains an array larger than ${DECISION_ENTRY_LIMITS.maxCollectionItems} items`)
    // JSON serializes an undefined array slot as null.
    for (const entry of value) validateDecisionEntryValue(entry === undefined ? null : entry, label, depth + 1, budget)
    return
  }

  check(plainDecisionObject(value), `${label} contains an unsupported value`)
  // An undefined member is omitted on the wire, exactly like JSON.stringify.
  // Rejecting it failed every live Jev call: runtime state objects routinely
  // carry optional fields that are undefined.
  const entries = Object.entries(value).filter(([, entry]) => entry !== undefined)
  check(entries.length <= DECISION_ENTRY_LIMITS.maxCollectionItems, `${label} contains an object larger than ${DECISION_ENTRY_LIMITS.maxCollectionItems} entries`)
  for (const [key, entry] of entries) {
    check(key.length > 0 && key.length <= DECISION_ENTRY_LIMITS.maxObjectKeyChars, `${label} contains an invalid object key`)
    validateDecisionEntryValue(entry, label, depth + 1, budget)
  }
}

function validateDecisionEntry(value, label) {
  check(
    value === null || typeof value === 'string' || Array.isArray(value) || plainDecisionObject(value),
    `${label} must be a string, object, array, or null`,
  )
  validateDecisionEntryValue(value, label, 0, { nodes: 0 })
}

function validateDecisionQuestion(id, question) {
  check(/^[A-Za-z0-9_.-]{1,80}$/.test(id), 'Invalid decision question identifier')
  check(plainDecisionObject(question), `Decision question ${id} must be an object`)
  check(['choice', 'score', 'noul'].includes(question.type), `Decision question ${id} has an unsupported type`)
  const allowedKeys = new Set(['type', 'instructions', 'criteria'])
  for (const key of Object.keys(question)) check(allowedKeys.has(key), `Decision question ${id} has unsupported field ${key}`)
  if (question.instructions !== undefined) {
    validateDecisionEntry(question.instructions, `Decision question ${id} instructions`)
  }

  if (question.type === 'choice') {
    check(plainDecisionObject(question.criteria), `Choice question ${id} requires criteria`)
    const entries = Object.entries(question.criteria)
    check(entries.length >= 1 && entries.length <= 255, `Choice question ${id} must have 1 to 255 criteria`)
    for (const [key, description] of entries) {
      check(/^[A-Za-z0-9_.-]{1,80}$/.test(key), `Choice question ${id} has an invalid criterion key`)
      validateDecisionEntry(description, `Choice question ${id} criterion ${key}`)
    }
  }

  if (question.type === 'score') {
    check(Array.isArray(question.criteria) && question.criteria.length >= 2 && question.criteria.length <= 10, `Score question ${id} must have 2 to 10 criteria`)
    for (let index = 0; index < question.criteria.length; index++) {
      validateDecisionEntry(question.criteria[index], `Score question ${id} criterion ${index}`)
    }
  }

  if (question.type === 'noul' && question.criteria !== undefined && question.criteria !== null) {
    check(plainDecisionObject(question.criteria), `Noul question ${id} criteria must be an object or null when provided`)
    const entries = Object.entries(question.criteria)
    check(entries.length <= 2, `Noul question ${id} criteria may describe only true and/or false`)
    for (const [key, description] of entries) {
      check(key === 'true' || key === 'false', `Noul question ${id} has unsupported criterion ${key}`)
      validateDecisionEntry(description, `Noul question ${id} criterion ${key}`)
    }
  }
}

export function normalizeDecisionProviderRequest(config, state, questions) {
  check(config && typeof config === 'object', 'Decision provider is not configured')
  check(questions && typeof questions === 'object' && !Array.isArray(questions), 'Decision questions must be an object')

  const entries = Object.entries(questions)
  check(entries.length >= 1 && entries.length <= config.maxQuestions, `Decision request must contain 1 to ${config.maxQuestions} questions`)
  for (const [id, question] of entries) validateDecisionQuestion(id, question)
  validateDecisionEntry(state, 'Decision provider state')

  const body = {
    state,
    model: config.model,
    questions,
  }

  let serialized
  try { serialized = JSON.stringify(body) }
  catch { throw new DeploymentError('Decision provider request is not JSON serializable') }

  check(serialized.length <= config.maxInputChars, `Decision provider request exceeds ${config.maxInputChars} characters`)
  return { body, serialized }
}

function validProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function exactDecisionKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function probabilityDistribution(value, expectedKeys, label) {
  check(value && typeof value === 'object' && !Array.isArray(value), `${label} has invalid probabilities`)
  check(exactDecisionKeys(value, expectedKeys), `${label} probabilities do not match the declared rubric`)
  let total = 0
  for (const key of expectedKeys) {
    check(validProbability(value[key]), `${label} has an invalid probability`)
    total += value[key]
  }
  // Jev reports probabilities with two decimals, so each value can be off by
  // up to half a unit and a valid distribution can total 0.99 or 1.01.
  const tolerance = Math.max(0.0001, expectedKeys.length * DECISION_PROBABILITY_ROUNDING)
  check(Math.abs(total - 1) <= tolerance, `${label} probabilities must sum to 1`)
}

function decisionEntriesEqual(left, right) {
  if (left === right) return true
  if (typeof left !== typeof right || left === null || right === null) return false
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => decisionEntriesEqual(entry, right[index]))
  }
  if (!plainDecisionObject(left) || !plainDecisionObject(right)) return false
  const leftKeys = Object.keys(left).sort()
  const rightKeys = Object.keys(right).sort()
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && decisionEntriesEqual(left[key], right[key]))
}

function validateDecisionAnswer(id, question, answer) {
  check(answer && typeof answer === 'object' && !Array.isArray(answer), `Decision provider answer ${id} is missing`)
  check(answer.type === question.type, `Decision provider answer ${id} has the wrong type`)

  if (question.type === 'choice') {
    const criteriaKeys = Object.keys(question.criteria)
    check(typeof answer.choice === 'string' && Object.prototype.hasOwnProperty.call(question.criteria, answer.choice), `Decision provider answer ${id} returned an unknown choice`)
    probabilityDistribution(answer.probabilities, criteriaKeys, `Decision provider answer ${id}`)
    check(validProbability(answer.confidence), `Decision provider answer ${id} has invalid confidence`)
    const selectedProbability = answer.probabilities[answer.choice]
    check(criteriaKeys.every(key => selectedProbability >= answer.probabilities[key] - 0.0000001), `Decision provider answer ${id} choice is not the highest-probability option`)
  }
  else if (question.type === 'score') {
    check(typeof answer.score === 'number' && Number.isFinite(answer.score), `Decision provider answer ${id} has an invalid score`)
    check(answer.score >= 0 && answer.score <= question.criteria.length - 1, `Decision provider answer ${id} score is outside the declared rubric`)
    check(answer.legend && typeof answer.legend === 'object' && !Array.isArray(answer.legend), `Decision provider answer ${id} has an invalid legend`)
    const expectedKeys = question.criteria.map((_, index) => String(index))
    check(exactDecisionKeys(answer.legend, expectedKeys), `Decision provider answer ${id} legend does not match the declared rubric`)
    probabilityDistribution(answer.probabilities, expectedKeys, `Decision provider answer ${id}`)
    for (let index = 0; index < question.criteria.length; index++) {
      const key = String(index)
      check(decisionEntriesEqual(answer.legend[key], question.criteria[index]), `Decision provider answer ${id} legend does not match the declared rubric`)
    }
    check(validProbability(answer.confidence), `Decision provider answer ${id} has invalid confidence`)
  }
  else {
    check(validProbability(answer.noul), `Decision provider answer ${id} has an invalid noul value`)
  }
}

export async function decisionProviderRequest(config, state, questions, {
  fetchImpl = fetch,
  signal,
  reserve,
} = {}) {
  check(config && typeof config === 'object' && typeof config.key === 'string' && config.key.trim().length > 0, 'Decision provider is not configured')
  const { serialized } = normalizeDecisionProviderRequest(config, state, questions)
  check(typeof reserve === 'function', 'Decision provider request requires a budget reservation callback')
  await reserve()

  const timeoutSignal = AbortSignal.timeout(config.timeoutMs)
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal

  try {
    const response = await fetchImpl(config.url, {
      method: 'POST',
      redirect: 'error',
      signal: requestSignal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.key}`,
      },
      body: serialized,
    })

    if (!response.ok) throw new DeploymentError(`Decision provider HTTP ${response.status}; request will not be retried automatically`)
    const responseText = await response.text()
    check(Buffer.byteLength(responseText, 'utf8') <= 128 * 1024, 'Decision provider response too large')

    let data
    try { data = JSON.parse(responseText) }
    catch { throw new DeploymentError('Decision provider returned invalid JSON') }

    check(data && typeof data === 'object' && !Array.isArray(data), 'Decision provider returned an invalid response')
    check(data.answers && typeof data.answers === 'object' && !Array.isArray(data.answers), 'Decision provider response has no answers')

    for (const [id, question] of Object.entries(questions)) {
      validateDecisionAnswer(id, question, data.answers[id])
    }

    if (data.usage !== undefined) {
      check(data.usage && typeof data.usage === 'object' && !Array.isArray(data.usage), 'Decision provider returned invalid usage')
      for (const field of ['input_tokens', 'output_tokens']) {
        if (data.usage[field] !== undefined) check(Number.isSafeInteger(data.usage[field]) && data.usage[field] >= 0, `Decision provider returned invalid ${field}`)
      }
      if (data.usage.cost !== undefined) check(typeof data.usage.cost === 'number' && Number.isFinite(data.usage.cost) && data.usage.cost >= 0, 'Decision provider returned invalid cost')
    }

    return {
      model: typeof data.model === 'string' ? data.model : config.model,
      provider: typeof data.provider === 'string' ? data.provider : config.provider,
      answers: data.answers,
      usage: data.usage,
    }
  }
  catch (error) {
    if (signal?.aborted) throw new DeploymentError('Decision provider request cancelled')
    if (timeoutSignal.aborted) throw new DeploymentError(`Decision provider timed out after ${config.timeoutMs} ms`)
    throw error
  }
}
