// MW5 (minimal): the pure pieces of the replacement wake.
//
// When a plan becomes BLOCKED by a harness-evidenced structural blocker (or a deadlock) and the goal carries a current
// grant, the planner is woken once to author a replacement plan version instead of the request ending to wait for the
// player. Everything here is deterministic text and counting; the model never decides eligibility. Authority stays where
// MW1 put it: the grant check, the replacement classification and the commit-time re-check live in authorization.mjs and
// planning-state.mjs.
//
// Design authority: docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md sections 1, 2 and 7.

import { ACTION_SCOPE, authorizationOf, GRANT_STATUS, MANDATE_KIND } from './authorization.mjs'

/** Accepted replacements one goal may use before a blocked plan waits for the player again (owner default; not final). */
export const MAX_REPLACEMENTS_PER_GOAL = 3

export const REPLACEMENT_WAKE_SKIP = Object.freeze({
  NO_ACTIVE_BLOCKED_PLAN: 'no_active_blocked_plan',
  GOAL_NOT_ACTIVE: 'goal_not_active',
  NO_GRANT: 'no_current_grant',
  GRANT_STALE: 'grant_stale',
  CAP_REACHED: 'replacement_cap_reached',
  USER_CHOICE_RECORDED: 'user_choice_recorded',
  PLANNER_UNAVAILABLE: 'planner_unavailable',
  NOT_PROVABLY_UNEXECUTED: 'batch_may_have_run',
  // The plan was never committed (a blocked pre-commit DRAFT): there is nothing to replace, the draft is simply refused.
  PLAN_NOT_COMMITTED: 'plan_not_committed',
  // The blocker is not harness-evidenced world change (see blockerWorldEvidence).
  BLOCKER_NOT_WORLD_EVIDENCE: 'blocker_not_world_evidence',
})

// What counts as "the world changed under the plan". The wake is only for blockers the harness itself observed in the game;
// anything else (a model's argument mistake, an authorization refusal, an uncertain-effect hold, a provider failure) keeps
// today's blocked end. Default deny: a code that is not listed here never wakes the planner.
export const WORLD_CHANGE_PREFLIGHT_CODES = Object.freeze({
  // The exact entity the batch targets is gone (destroyed, mined, replaced). The mod resolves the unit number against the live
  // world, so a miss is an engine fact - but only if the unit really existed, which is checked separately (EXISTENCE_EVIDENCE_CODES).
  stale_exact_target: 'the exact target entity no longer exists',
  // Live facts measured by the mod's transfer preflight: the plan assumed stock or room that the world does not have now.
  extraction_empty: 'the entity the step takes from holds none of the item now',
  destination_full: 'the entity the step feeds accepts none of the item now',
})

// Codes whose meaning depends on the target having existed: a model-invented unit number must not trigger a replan.
export const EXISTENCE_EVIDENCE_CODES = Object.freeze(['stale_exact_target'])

// Never world evidence, listed so the intent is explicit (default deny already covers them): authorization refusals of MW1
// (protected / reserved / player inventory / stale grant), the uncertain-effect hold, argument and prototype errors the model
// can fix itself, a locked recipe (the plan was wrong from the start; the requirements block informs the planner), and the
// actor or surface being elsewhere.
export const NEVER_WAKE_PREFLIGHT_CODES = Object.freeze([
  'authorization_stale', 'protected_entity_refused', 'reserved_supply_refused', 'reserved_supply_ambiguous_target', 'player_inventory_excluded',
  'duplicate_effect_suppressed',
  'recipe_locked', 'unknown_prototype', 'unknown_recipe', 'unknown_technology', 'invalid_unit_number', 'invalid_target_kind', 'invalid_preflight_args',
  'bootstrap_dependency_unresolved', 'no_actor', 'different_surface', 'preflight_transport_error',
  // The NPC's own inventory accounting (what it expected to hold) is usually the planner's or executor's mistake, not the world changing.
  'supply_missing',
])

/**
 * Is this blocker harness-evidenced world change?
 *   trigger 'operation_preflight_blocker': the preflight code must be in WORLD_CHANGE_PREFLIGHT_CODES, and for the existence
 *     codes the harness must hold evidence the target existed (`existed`: an NPC placement receipt, an earlier authoritative
 *     observation of the unit, or the mod's own last-observed record).
 *   trigger 'operation_admission_failure': only a refusal the mod proved happened before any mutation of the first operation
 *     (`provenRefusal`). A transport, epoch or journal refusal is a harness problem, not the world.
 */
export function blockerWorldEvidence({ trigger, preflight, existed = false, provenRefusal = false, refusalCode } = {}) {
  if (trigger === 'operation_preflight_blocker') {
    const code = clean(preflight?.code, 80)
    if (!Object.hasOwn(WORLD_CHANGE_PREFLIGHT_CODES, code)) return { ok: false, detail: `code_not_world_change:${code || 'none'}` }
    if (EXISTENCE_EVIDENCE_CODES.includes(code) && !existed) return { ok: false, detail: 'target_existence_unproven' }
    return { ok: true, detail: code }
  }
  if (trigger === 'operation_admission_failure') {
    // The mod's own refusal code is checked against the never-wake list first: a proven refusal for an authorization reason is not the world.
    const refusal = clean(refusalCode, 80)
    if (refusal && NEVER_WAKE_PREFLIGHT_CODES.includes(refusal)) return { ok: false, detail: `refusal_code_never_wakes:${refusal}` }
    return provenRefusal ? { ok: true, detail: 'proven_refusal_before_mutation' } : { ok: false, detail: 'admission_refusal_not_proven_by_the_game' }
  }
  return { ok: false, detail: `unsupported_trigger:${clean(trigger, 60)}` }
}

// The scopes the implicit goal grant carries: everything a player's request permits toward its own result.
export const PLAYER_OBJECTIVE_SCOPE = Object.freeze([
  ACTION_SCOPE.EXPAND_INFRASTRUCTURE,
  ACTION_SCOPE.ROUTE_CHANGE,
  ACTION_SCOPE.RESOURCE_EXPANSION,
  ACTION_SCOPE.SUPPORTING_WORK,
  ACTION_SCOPE.RECOVERY,
])

function clean(value, max = 300) {
  const text = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`
}

/** The grant record admission issues to a player's own objective (chat-origin new_goal only). */
export function playerObjectiveGrant(goalId) {
  return {
    mandate_kind: MANDATE_KIND.PLAYER_TASK,
    mandate_id: goalId,
    requested_result: { result_key: `goal:${goalId}`, destination: '' },
    permitted_scope: [...PLAYER_OBJECTIVE_SCOPE],
    reason: 'player_objective',
  }
}

/** The active grant of the planning state's goal, if any (a revoked grant is not current). */
export function currentGoalGrant(planning) {
  const goalId = planning?.goal?.goal_id
  if (!goalId || planning.goal.status !== 'active') return undefined
  return authorizationOf(planning).grants.find(grant => grant.status === GRANT_STATUS.ACTIVE && grant.goal_id === goalId)
}

/** Accepted replacements this goal has used. Durable: the reducer counts them on the goal record (snapshot/restore safe). */
export function replacementsUsed(planning) {
  const used = planning?.goal?.replacements_accepted
  return Number.isSafeInteger(used) && used > 0 ? used : 0
}

/** The blocker of the plan as the replacement request needs it: reason code, detail and the evidence it is grounded in. */
export function blockerFacts(plan) {
  const blocker = plan?.blocker ?? {}
  const signals = Array.isArray(blocker.signals) ? blocker.signals : []
  const refs = Array.isArray(blocker.evidence_refs) && blocker.evidence_refs.length > 0
    ? blocker.evidence_refs.map(ref => clean(ref, 200))
    : signals.map(signal => clean(`${plan?.plan_id}/deadlock/${signal?.kind ?? 'signal'}`, 200))
  return {
    kind: clean(blocker.kind, 40) || 'structural',
    reason_code: clean(blocker.reason_code, 120) || 'structural_blocker',
    detail: clean(blocker.detail || signals.map(signal => signal?.detail).filter(Boolean).join('; '), 400),
    evidence_refs: refs.filter(Boolean).slice(0, 16),
  }
}

// The world-change codes in the words a player reads; any other code is shown as its own words.
const PLAIN_BLOCKER_REASONS = Object.freeze({
  stale_exact_target: 'something I was working on is gone',
  extraction_empty: 'the machine or chest I was taking from is empty',
  destination_full: 'the machine or chest I was filling is full',
})

/** Why the plan stopped, in plain words for the player: `operation_preflight_failed:stale_exact_target` becomes a phrase. */
export function plainBlockerReason(reasonCode) {
  const code = clean(reasonCode, 160).replace(/^operation_preflight_failed:/, '')
  if (Object.hasOwn(PLAIN_BLOCKER_REASONS, code)) return PLAIN_BLOCKER_REASONS[code]
  const text = code.replace(/[_:]+/g, ' ').trim()
  return text || 'a structural blocker'
}

function stepStatus(plan, step, index) {
  const progress = plan.execution?.step_progress?.[step.step_id]?.status
  if (progress === 'completed') return 'completed'
  if (index === plan.active_step_index) return 'blocked'
  return progress === 'active' ? 'pending' : (progress || 'pending')
}

/**
 * The harness-facts message the woken planner receives. Facts only: what blocked, the plan as it stood, what is verified,
 * what the grant keeps fixed and which things still need the player. No advice on how to solve it.
 */
export function buildPlanBlockedMessage({ plan, grant, replacementsUsedCount, cap = MAX_REPLACEMENTS_PER_GOAL }) {
  const facts = blockerFacts(plan)
  const lines = [
    `[PLAN_BLOCKED] The harness blocked committed plan ${plan.plan_id} (version ${plan.plan_version}). It is preserved as history and cannot be edited.`,
    `blocker: ${facts.reason_code}${facts.detail ? ` - ${facts.detail}` : ''}`,
    `evidence: ${facts.evidence_refs.join(', ') || 'none recorded'}`,
    'steps (status, completion mode, description):',
  ]
  const verified = []
  plan.steps.forEach((step, index) => {
    const status = stepStatus(plan, step, index)
    if (status === 'completed') verified.push(index + 1)
    lines.push(`${index + 1}. ${status}, ${step.completion_mode || 'unspecified'}: ${clean(step.description, 300)}`)
  })
  const carried = Array.isArray(plan.carried_forward_evidence) ? plan.carried_forward_evidence.length : 0
  lines.push(`verified prefix: ${verified.length > 0 ? `steps ${verified.join(', ')}` : 'none'}${carried > 0 ? `; ${carried} earlier verified step(s) carried from previous versions` : ''}. Verified work stays verified in the successor.`)
  const scope = grant.permitted_scope.join(', ')
  lines.push(
    `authorization: ${grant.grant_id} revision ${grant.revision} (${grant.mandate_kind}) permits ${scope}. The requested result stays ${grant.requested_result.result_key}${grant.requested_result.destination ? ` delivered to ${grant.requested_result.destination}` : ''}; a replacement cannot change it.`,
    'needs the player: changing the requested result or destination, removing or redesigning player-built structures, using reserved supplies. The harness checks each operation at admission.',
    `replacements used for this goal: ${replacementsUsedCount} of ${cap}.`,
    'reply: an ordinary submitPlan. List every step of the plan, completed steps unchanged, with stepCompletions for every step (a checkpoint for the step at currentStep, {kind:"deterministic"} after it), currentStep set to the first unfinished step, and the operations for that step. The harness validates it and commits it as a new plan version.',
  )
  return lines.join('\n')
}

/** The line the player sees when a replacement plan has committed. */
export function replacementAnnouncement({ plan, blocker, firstStep, unchanged = false }) {
  const reason = plainBlockerReason(blocker?.reason_code)
  const first = clean(firstStep, 160) || 'the next step'
  // A replacement with the very same steps is a retry, not a change of plan.
  if (unchanged) return `Retrying the plan: ${reason}. Plan v${plan.plan_version} resumes with: ${first}.`
  return `Changed plan: ${reason}. New plan v${plan.plan_version} starts with: ${first}.`
}

/** The line the player sees when the replacement needs their approval. */
export function replacementApprovalLine({ reasonCodes, detail }) {
  const needs = {
    outcome_changed: 'a different result than you asked for',
    destination_changed: 'a different destination than you asked for',
    protected_redesign: 'removing or changing something you built',
    reserved_supplies: 'using supplies you reserved',
    constraint_crossed: 'crossing a constraint you set',
    scope_not_granted: 'work outside what your request covers',
  }
  const list = (Array.isArray(reasonCodes) ? reasonCodes : []).map(code => needs[code] ?? clean(code, 60))
  const what = list.length > 0 ? list.join(' and ') : 'a change that needs your approval'
  return `[Plan blocked] The new plan needs ${what}${detail ? ` (${clean(detail, 160)})` : ''}. The old plan stays unchanged until you decide: Revise, Keep paused or Cancel.`
}
