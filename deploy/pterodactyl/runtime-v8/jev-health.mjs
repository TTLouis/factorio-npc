// Per-request Jev health accounting.
//
// Every live Jev boundary falls back to deterministic/Main-LLM handling when the
// decision provider fails. That keeps Jev off the critical path, but it also
// means a run can silently degrade into a Jev-off run: on 2026-09-24 every call
// fell back in 1-4 ms on a request-contract bug and nothing visible said so.
//
// This module counts decision requests/responses/fallbacks per logical request,
// classifies each fallback, and decides whether the request is valid evidence
// about Jev at all. It never changes routing; it only reports.

// A request whose Jev calls fell back more often than this is not evidence
// about Jev's judgments, only about its availability.
export const JEV_MEASUREMENT_FALLBACK_LIMIT = 0.25

export const JEV_MEASUREMENT = Object.freeze({
  JEV_OFF: 'jev_off',
  NO_CALLS: 'no_calls',
  VALID: 'valid',
  DEGRADED: 'degraded',
})

// Fallback kinds whose presence alone invalidates a measurement: they mean the
// harness never asked Jev a well-formed question.
const HARNESS_FAULT_KINDS = new Set(['request_contract', 'not_configured'])

const FALLBACK_RULES = [
  ['cancelled', /cancelled|superseded|epoch changed|aborted/i],
  ['timeout', /timed out|timeout/i],
  ['budget', /hourly provider request budget|budget reached/i],
  ['rate_limited', /HTTP 429/],
  ['http', /HTTP \d{3}/],
  ['not_configured', /not configured|requires a budget reservation/i],
  ['request_contract', /Decision provider state|Decision question|Choice question|Score question|Noul question|Decision request must contain|request exceeds \d+ characters|not JSON serializable|Invalid decision question identifier/],
  ['response_contract', /Decision provider (answer|response|returned)|probabilities|legend/i],
  ['transport', /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i],
]

export function classifyDecisionFallback(reason) {
  const text = String(reason ?? '')
  for (const [kind, pattern] of FALLBACK_RULES) {
    if (pattern.test(text)) return kind
  }
  // Provider answered, but the runtime's own parser/policy rejected it.
  return text ? 'runtime_parse' : 'unknown'
}

export function emptyJevHealth() {
  return {
    requests: 0,
    responses: 0,
    fallbacks: 0,
    by_contract: {},
    by_kind: {},
    last_fallback: null,
  }
}

function contractBucket(health, contract) {
  const key = String(contract || 'unknown')
  health.by_contract[key] ??= { requests: 0, responses: 0, fallbacks: 0 }
  return health.by_contract[key]
}

// Returns the classified fallback for 'decision.fallback', otherwise undefined.
export function recordJevHealth(health, event, data = {}) {
  if (event === 'decision.request') {
    health.requests += 1
    contractBucket(health, data.contract).requests += 1
    return undefined
  }
  if (event === 'decision.response') {
    health.responses += 1
    contractBucket(health, data.contract).responses += 1
    return undefined
  }
  if (event !== 'decision.fallback') return undefined

  const kind = classifyDecisionFallback(data.reason)
  health.fallbacks += 1
  contractBucket(health, data.contract).fallbacks += 1
  health.by_kind[kind] = (health.by_kind[kind] ?? 0) + 1
  health.last_fallback = {
    contract: String(data.contract || 'unknown'),
    kind,
    reason: String(data.reason ?? '').slice(0, 300),
    target: String(data.fallback_target ?? ''),
  }
  return health.last_fallback
}

export function jevMeasurement(health, { configured = true } = {}) {
  if (!configured) return JEV_MEASUREMENT.JEV_OFF
  if (health.requests === 0) return JEV_MEASUREMENT.NO_CALLS
  if (Object.keys(health.by_kind).some(kind => HARNESS_FAULT_KINDS.has(kind))) return JEV_MEASUREMENT.DEGRADED
  return health.fallbacks / health.requests > JEV_MEASUREMENT_FALLBACK_LIMIT
    ? JEV_MEASUREMENT.DEGRADED
    : JEV_MEASUREMENT.VALID
}

export function summarizeJevHealth(health, { configured = true } = {}) {
  return {
    measurement: jevMeasurement(health, { configured }),
    requests: health.requests,
    responses: health.responses,
    fallbacks: health.fallbacks,
    fallback_rate_percent: health.requests > 0 ? Math.round((health.fallbacks / health.requests) * 100) : 0,
    by_contract: structuredClone(health.by_contract),
    by_kind: { ...health.by_kind },
    last_fallback: health.last_fallback ? { ...health.last_fallback } : null,
  }
}
