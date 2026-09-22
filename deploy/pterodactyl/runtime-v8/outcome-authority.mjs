const OUTCOME_KINDS = new Set([
  'execution_required',
  'runtime_active',
  'condition_wait_active',
  'verified_complete',
  'semantic_complete',
  'world_blocked',
  'recoverable_provider_failure',
  'cancelled',
])

const BLOCKER_EVIDENCE_KINDS = new Set([
  'deterministic_preflight',
  'operation_preflight_blocker',
  'operation_admission_failure',
  'operation_error_receipt',
  'autorio_failure',
  'fresh_world_observation',
  'missing_runtime_capability',
  'user_constraint_contradiction',
])

const COMPLETION_EVIDENCE_KINDS = new Set([
  'deterministic_verification',
  'authoritative_completion',
  'verified_world_state',
  'condition_satisfied',
])

const PROVIDER_CONTROL_PLANE_FAILURES = new Set([
  'provider_format',
  'provider_budget',
  'provider_safety',
])

function clean(value, max = 500) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

function normalizedMetaText(value) {
  return clean(value, 500)
    .toLowerCase()
    .replace(/[.!?;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isLifecycleMetaStep(value) {
  const text = normalizedMetaText(value)
  if (!text) return true
  if (/^(?:please\s+)?(?:stop|done|finish(?:ed)?|completed?)(?:\s+(?:the\s+)?(?:task|goal|request))?$/.test(text)) return true
  if (/^(?:end|close)\s+(?:the\s+)?(?:task|goal|request)$/.test(text)) return true
  if (/^(?:report|announce|confirm)\s+(?:the\s+)?completion(?:\s+to\s+(?:the\s+)?(?:player|user|requester|operator))?$/.test(text)) return true
  if (/^(?:report|tell|notify|inform)\s+(?:the\s+)?(?:player|user|requester|operator)(?:\s+that)?(?:\s+(?:it|the\s+task|the\s+goal)\s+is)?\s+(?:done|finished|completed?)$/.test(text)) return true
  if (/^(?:wait|idle)\s+(?:for\s+)?(?:the\s+)?(?:next|further)\s+(?:instruction|instructions|request|task)$/.test(text)) return true
  return false
}

export function normalizeCanonicalPlan(plan, currentStep = 0) {
  const source = Array.isArray(plan) ? plan.slice(0, 30) : []
  const kept = []
  for (let index = 0; index < source.length; index++) {
    const description = clean(source[index], 500)
    if (!description || isLifecycleMetaStep(description)) continue
    kept.push({ description, sourceIndex: index })
  }
  if (kept.length === 0) return { plan: [], currentStep: 0, removed: source.length }
  const requested = Number.isSafeInteger(currentStep) ? Math.max(0, currentStep) : 0
  let mapped = kept.findIndex(item => item.sourceIndex >= requested)
  if (mapped < 0) mapped = kept.length - 1
  return {
    plan: kept.map(item => item.description),
    currentStep: mapped,
    removed: Math.max(0, source.length - kept.length),
  }
}

export function authoritativeRuntimeState(world = {}) {
  const taskState = typeof world?.task_state === 'string' ? world.task_state.trim().toLowerCase() : ''
  const queueLength = Number.isSafeInteger(world?.queue_length) ? world.queue_length : undefined
  const persistentHealthy = world?.persistent_runtime_healthy === true
    || (world?.persistent_runtime?.active === true && world?.persistent_runtime?.healthy === true && world?.persistent_runtime?.controller_live === true)
  const conditionWaitActive = world?.condition_wait_active === true
    || (world?.condition_wait?.state === 'active' && world?.condition_wait?.healthy !== false)
  const active = conditionWaitActive || persistentHealthy || (queueLength !== undefined && queueLength > 0) || (taskState && taskState !== 'idle')
  const idle = !conditionWaitActive && !persistentHealthy && queueLength === 0 && taskState === 'idle'
  return {
    active,
    idle,
    task_state: taskState || undefined,
    queue_length: queueLength,
    persistent_runtime_healthy: persistentHealthy,
    condition_wait_active: conditionWaitActive,
  }
}

export function hasAuthoritativeBlockerEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : []).some(item => BLOCKER_EVIDENCE_KINDS.has(String(item?.kind ?? '')))
}

export function hasAuthoritativeCompletionEvidence(evidence) {
  return (Array.isArray(evidence) ? evidence : []).some(item => COMPLETION_EVIDENCE_KINDS.has(String(item?.kind ?? '')))
}

export function validateOutcomeCandidate(candidate, { world = {} } = {}) {
  const kind = String(candidate?.kind ?? '')
  const source = clean(candidate?.source, 80)
  const reasonCode = clean(candidate?.reason_code || kind || 'unknown_outcome', 160)
  const evidence = Array.isArray(candidate?.evidence) ? candidate.evidence : []
  const runtime = authoritativeRuntimeState(world)
  const base = { kind, source, reason_code: reasonCode, runtime, accepted: false, durable_status: undefined }

  if (!OUTCOME_KINDS.has(kind)) return { ...base, rejection_reason: 'unknown_outcome_kind' }

  if (kind === 'execution_required') {
    const operations = Array.isArray(candidate?.operations) ? candidate.operations : []
    return operations.length > 0
      ? { ...base, accepted: true }
      : { ...base, rejection_reason: 'execution_required_without_operations' }
  }

  if (kind === 'runtime_active') {
    return runtime.active
      ? { ...base, accepted: true, durable_status: 'active' }
      : { ...base, rejection_reason: 'runtime_active_without_authoritative_runtime' }
  }

  if (kind === 'condition_wait_active') {
    return runtime.condition_wait_active
      ? { ...base, accepted: true, durable_status: 'active' }
      : { ...base, rejection_reason: 'condition_wait_without_authoritative_watcher' }
  }

  if (kind === 'verified_complete') {
    return hasAuthoritativeCompletionEvidence(evidence)
      ? { ...base, accepted: true, durable_status: 'completed' }
      : { ...base, rejection_reason: 'completion_without_authoritative_evidence' }
  }

  if (kind === 'semantic_complete') {
    const metadata = candidate?.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {}
    const groundingRefs = Array.isArray(metadata.grounding_refs)
      ? metadata.grounding_refs.filter(ref => typeof ref === 'string' && ref.trim()).slice(0, 16)
      : []
    if (source !== 'main_planner') return { ...base, rejection_reason: 'semantic_completion_requires_main_planner' }
    if (metadata.scope !== 'step') return { ...base, rejection_reason: 'semantic_completion_must_target_step' }
    if (!clean(metadata.step_id, 200)) return { ...base, rejection_reason: 'semantic_completion_missing_step_id' }
    if (groundingRefs.length === 0) return { ...base, rejection_reason: 'semantic_completion_without_runtime_grounding' }
    return { ...base, accepted: true, durable_status: 'completed', semantic: true }
  }

  if (kind === 'world_blocked') {
    if (PROVIDER_CONTROL_PLANE_FAILURES.has(reasonCode)) {
      return { ...base, rejection_reason: 'provider_failure_cannot_be_world_blocker' }
    }
    const blocker = clean(candidate?.candidate_blocker, 500)
    if (!blocker) return { ...base, rejection_reason: 'world_blocked_without_candidate_blocker' }
    return hasAuthoritativeBlockerEvidence(evidence)
      ? { ...base, accepted: true, durable_status: 'blocked', blocker }
      : { ...base, rejection_reason: 'world_blocked_without_authoritative_evidence' }
  }

  if (kind === 'recoverable_provider_failure') {
    if (runtime.active) return { ...base, accepted: true, durable_status: 'active' }
    if (runtime.idle) return { ...base, accepted: true, durable_status: 'paused', pause_reason: `recoverable_provider_failure:${reasonCode}` }
    return { ...base, accepted: true, durable_status: 'active' }
  }

  const metadata = candidate?.metadata && typeof candidate.metadata === 'object' ? candidate.metadata : {}
  if (metadata.server_authoritative !== true) return { ...base, rejection_reason: 'cancelled_without_server_authority' }
  if (metadata.transition === 'paused') {
    return { ...base, accepted: true, durable_status: 'paused', pause_reason: clean(metadata.pause_reason || reasonCode, 300) }
  }
  return { ...base, accepted: true }
}
