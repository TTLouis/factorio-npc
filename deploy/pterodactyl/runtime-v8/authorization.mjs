// MW1: authorization records, grant checks, protected assets and reserved supplies.
//
// Design authority: docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md section 2 and the 2026-09-30 owner answers.
//
// Everything here is PURE: no I/O, no clock, no model. planning-state.mjs owns the reducer events that call
// these functions and persists the record with the planning state; the harness (memory facade and agent loop)
// calls the checks. Nothing in this module lets a model, Jev or the planner grant, revise or approve anything:
// the reducer only accepts grant/approval events from runtime or user authority.
//
// Vocabulary
//   grant      A standing Auto mandate or a player task, revisioned. It names the goal/task, the requested result
//              and destination, the actions it permits, the constraints it carries and what it protects.
//   approval   A user answer that clears specific ask reasons for specific subjects on one blocked plan.
//   question   A pending approval request raised when a replacement would leave the grant. It blocks only the
//              affected plan: the old committed plan stays frozen and untouched while it is pending.
//   world      Facts that outlive a goal: NPC placement receipts (to tell NPC-built from player-built) and
//              reserved containers. Player inventories are never available to the NPC.

export const AUTHORIZATION_VERSION = 1

export const MANDATE_KIND = Object.freeze({
  STANDING_AUTO: 'standing_auto',
  PLAYER_TASK: 'player_task',
})
const MANDATE_KINDS = Object.freeze(Object.values(MANDATE_KIND))

// What a grant may permit. A replacement names the one scope it relies on.
export const ACTION_SCOPE = Object.freeze({
  EXPAND_INFRASTRUCTURE: 'expand_infrastructure',
  ROUTE_CHANGE: 'route_change',
  RESOURCE_EXPANSION: 'resource_expansion',
  SUPPORTING_WORK: 'supporting_work',
  RECOVERY: 'recovery',
})
const ACTION_SCOPES = Object.freeze(Object.values(ACTION_SCOPE))

export const GRANT_STATUS = Object.freeze({ ACTIVE: 'active', REVOKED: 'revoked' })

export const REPLACEMENT_DECISION = Object.freeze({ ACCEPT: 'accept', ASK: 'ask', REFUSE: 'refuse' })

// Why a grant cannot be relied on right now. Named, so a trace or a test can assert the exact cause.
export const GRANT_REFUSAL = Object.freeze({
  NO_AUTHORIZATION: 'no_authorization',
  GRANT_NOT_FOUND: 'grant_not_found',
  GRANT_REVOKED: 'grant_revoked',
  GRANT_REVISION_STALE: 'grant_revision_stale',
  GOAL_NOT_ACTIVE: 'goal_not_active',
  GOAL_MISMATCH: 'goal_mismatch',
  ACTOR_REPLACED: 'actor_replaced',
  ACTOR_EPOCH_CHANGED: 'actor_epoch_changed',
  ACTOR_UNVERIFIED: 'actor_unverified',
})

// Why a replacement needs the player instead of the grant.
export const ASK_REASON = Object.freeze({
  OUTCOME_CHANGED: 'outcome_changed',
  DESTINATION_CHANGED: 'destination_changed',
  PROTECTED_REDESIGN: 'protected_redesign',
  RESERVED_SUPPLIES: 'reserved_supplies',
  CONSTRAINT_CROSSED: 'constraint_crossed',
  SCOPE_NOT_GRANTED: 'scope_not_granted',
})

// A changed outcome or destination is never approvable through a grant approval: it is a different request, which
// only the user's own revision (USER_REVISION_APPROVED) can introduce.
const NOT_APPROVABLE_ASK = Object.freeze([ASK_REASON.OUTCOME_CHANGED, ASK_REASON.DESTINATION_CHANGED])

export const REPLACEMENT_REFUSAL = Object.freeze({
  INVALID_REQUEST: 'invalid_request',
  PREDECESSOR_NOT_FOUND: 'predecessor_not_found',
  PREDECESSOR_NOT_BLOCKED: 'predecessor_not_blocked',
  // A blocked plan that is no longer the active one (a user revision or another successor replaced it) is history.
  PREDECESSOR_NOT_ACTIVE: 'predecessor_not_active',
  PREDECESSOR_ALREADY_REPLACED: 'predecessor_already_replaced',
  REPLACEMENT_PENDING: 'replacement_pending',
  REASON_NOT_GROUNDED: 'reason_not_grounded',
  STEPS_EMPTY: 'steps_empty',
  STEPS_CHANGED_SINCE_AUTHORIZATION: 'steps_changed_since_authorization',
})

// Admission refusals (operation level).
export const ADMISSION_REFUSAL = Object.freeze({
  AUTHORIZATION_STALE: 'authorization_stale',
  PROTECTED_ENTITY: 'protected_entity_refused',
  RESERVED_SUPPLY: 'reserved_supply_refused',
  RESERVED_AMBIGUOUS: 'reserved_supply_ambiguous_target',
  PLAYER_INVENTORY: 'player_inventory_excluded',
})
export const ADMISSION_REFUSAL_CODES = Object.freeze(Object.values(ADMISSION_REFUSAL))

// Approval reason codes for operation-level protected/reserved targets.
export const APPROVAL_REASON = Object.freeze({
  PROTECTED_ENTITY: 'protected_entity',
  RESERVED_SUPPLY: 'reserved_supply',
})

// Operations that remove, rotate, mine or reconfigure an EXISTING exact entity. Each reports the engine's
// last_user for its target in the preflight result (`target.last_user`).
export const PROTECTED_MUTATION_OPERATIONS = Object.freeze(['mine_entity_exact', 'rotate_entity', 'set_machine_recipe'])

export const AUTHORIZATION_LIMITS = Object.freeze({
  grants: 16,
  questions: 16,
  approvals: 32,
  refusals: 16,
  placements: 512,
  reservations: 64,
  scope: 8,
  constraints: 24,
  materials: 16,
  unitNumbers: 64,
  evidenceRefs: 16,
  revisionHistory: 8,
})

// --- small pure helpers ----------------------------------------------------

function text(value, max = 500) {
  const cleaned = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max)
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : undefined
}

function stringList(value, { max = 32, maxLength = 160 } = {}) {
  if (!Array.isArray(value)) return []
  return value.map(item => text(item, maxLength)).filter(Boolean).slice(0, max)
}

function unitNumberList(value, max = AUTHORIZATION_LIMITS.unitNumbers) {
  const seen = new Set()
  const out = []
  for (const item of Array.isArray(value) ? value : []) {
    if (!Number.isSafeInteger(item) || item < 1 || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= max) break
  }
  return out
}

function recent(value, max) {
  return Array.isArray(value) ? value.slice(-max) : []
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** FNV-1a, deterministic and dependency-free; the same scheme the reducer uses for step ids. */
export function authorizationFingerprint(value) {
  let hash = 0x811C9DC5
  const source = String(value ?? '')
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36).padStart(7, '0').slice(0, 7)
}

/** The fingerprint of what a replacement draft says it will do; commit refuses a draft that drifted from it. */
export function replacementStepsFingerprint(steps) {
  return authorizationFingerprint((Array.isArray(steps) ? steps : [])
    .map(step => text(typeof step === 'string' ? step : step?.description, 500))
    .join('\n'))
}

// --- record construction ---------------------------------------------------

export function createEmptyAuthorization() {
  return {
    version: AUTHORIZATION_VERSION,
    sequence: 0,
    grants: [],
    questions: [],
    approvals: [],
    refusals: [],
    world: { npc_placements: [], reservations: [] },
  }
}

export function authorizationOf(state) {
  return state?.authorization && typeof state.authorization === 'object' ? state.authorization : createEmptyAuthorization()
}

/** True when the record holds anything worth persisting. */
export function authorizationHasContent(auth) {
  return Boolean(auth) && (
    auth.sequence > 0
    || auth.grants.length > 0
    || auth.world.npc_placements.length > 0
    || auth.world.reservations.length > 0
  )
}

/** What survives a new goal: the world facts, never the previous goal's grants, questions or approvals. */
export function carryAuthorizationAcrossGoals(auth) {
  if (!auth) return undefined
  const world = {
    npc_placements: [...auth.world.npc_placements],
    reservations: [...auth.world.reservations],
  }
  if (world.npc_placements.length === 0 && world.reservations.length === 0) return undefined
  return { ...createEmptyAuthorization(), sequence: auth.sequence, world }
}

function sanitizeRequestedResult(raw) {
  if (!isRecord(raw)) return undefined
  const resultKey = text(raw.result_key, 200)
  if (!resultKey) return undefined
  return { result_key: resultKey, destination: text(raw.destination, 200) }
}

function sanitizeActor(raw) {
  if (!isRecord(raw)) return null
  const actorId = Number.isSafeInteger(raw.actor_id) ? raw.actor_id : undefined
  const actorEpoch = Number.isSafeInteger(raw.actor_epoch) ? raw.actor_epoch : undefined
  if (actorId === undefined && actorEpoch === undefined) return null
  return { actor_id: actorId ?? null, actor_epoch: actorEpoch ?? null }
}

function sanitizeMaterials(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (!isRecord(item)) return []
    const itemName = text(item.item_name, 120)
    const container = Number.isSafeInteger(item.container_unit_number) ? item.container_unit_number : undefined
    if (!itemName && container === undefined) return []
    return [{ item_name: itemName || null, container_unit_number: container ?? null }]
  }).slice(0, AUTHORIZATION_LIMITS.materials)
}

function sanitizeScope(raw) {
  return stringList(raw, { max: AUTHORIZATION_LIMITS.scope, maxLength: 60 }).filter(item => ACTION_SCOPES.includes(item))
}

function sanitizeGrantFields(raw) {
  if (!isRecord(raw)) return undefined
  const kind = text(raw.mandate_kind, 40)
  if (!MANDATE_KINDS.includes(kind)) return undefined
  const mandateId = text(raw.mandate_id, 120)
  const goalId = text(raw.goal_id, 120)
  const result = sanitizeRequestedResult(raw.requested_result)
  const scope = sanitizeScope(raw.permitted_scope)
  if (!mandateId || !goalId || !result || scope.length === 0) return undefined
  return {
    mandate_kind: kind,
    mandate_id: mandateId,
    goal_id: goalId,
    task_id: text(raw.task_id, 120) || null,
    requested_result: result,
    permitted_scope: [...new Set(scope)],
    constraints: stringList(raw.constraints, { max: AUTHORIZATION_LIMITS.constraints, maxLength: 300 }),
    protected_materials: sanitizeMaterials(raw.protected_materials),
    protected_assets: { unit_numbers: unitNumberList(raw.protected_assets?.unit_numbers) },
    actor: sanitizeActor(raw.actor),
  }
}

export function grantIdFor(kind, mandateId) {
  return `${text(kind, 40)}:${text(mandateId, 120)}`
}

// --- grant lifecycle -------------------------------------------------------

/**
 * Create a grant at revision 1, or re-activate a revoked one at the next revision (so a reference to the old
 * revision stays stale). An already-active grant is refused: change it with a revision.
 */
export function grantAuthorization(auth, input, now) {
  const fields = sanitizeGrantFields(input)
  if (!fields) return { refused: 'invalid_grant' }
  const grantId = grantIdFor(fields.mandate_kind, fields.mandate_id)
  const existing = auth.grants.find(grant => grant.grant_id === grantId)
  if (existing?.status === GRANT_STATUS.ACTIVE) return { refused: 'grant_already_active', grant: existing }
  const revision = existing ? existing.revision + 1 : 1
  const grant = {
    grant_id: grantId,
    ...fields,
    revision,
    status: GRANT_STATUS.ACTIVE,
    granted_at: now,
    updated_at: now,
    revoked_at: null,
    revision_history: [...recent(existing?.revision_history, AUTHORIZATION_LIMITS.revisionHistory - 1), {
      revision,
      at: now,
      change: existing ? 'reactivated' : 'granted',
      reason: text(input.reason, 200),
    }],
  }
  const grants = existing ? auth.grants.map(item => (item.grant_id === grantId ? grant : item)) : [...auth.grants, grant]
  return {
    grant,
    auth: {
      ...auth,
      sequence: auth.sequence + 1,
      grants: recent(grants, AUTHORIZATION_LIMITS.grants),
    },
  }
}

const REVISABLE_FIELDS = Object.freeze(['permitted_scope', 'constraints', 'protected_materials', 'protected_assets', 'requested_result', 'actor'])

/** Change an active grant. Any accepted change bumps the revision, so work holding the old revision is stale. */
export function reviseAuthorization(auth, { grant_id: grantId, changes, reason } = {}, now) {
  const grant = auth.grants.find(item => item.grant_id === text(grantId, 200))
  if (!grant) return { refused: GRANT_REFUSAL.GRANT_NOT_FOUND }
  if (grant.status !== GRANT_STATUS.ACTIVE) return { refused: GRANT_REFUSAL.GRANT_REVOKED }
  if (!isRecord(changes)) return { refused: 'invalid_revision' }
  const merged = { ...grant }
  const changed = []
  for (const field of REVISABLE_FIELDS) {
    if (changes[field] === undefined) continue
    const candidate = sanitizeGrantFields({
      mandate_kind: grant.mandate_kind,
      mandate_id: grant.mandate_id,
      goal_id: grant.goal_id,
      requested_result: grant.requested_result,
      permitted_scope: grant.permitted_scope,
      ...{ [field]: changes[field] },
    })
    if (!candidate) return { refused: 'invalid_revision' }
    merged[field] = candidate[field]
    changed.push(field)
  }
  if (changed.length === 0) return { refused: 'no_change' }
  const revision = grant.revision + 1
  const next = {
    ...merged,
    revision,
    updated_at: now,
    revision_history: [...recent(grant.revision_history, AUTHORIZATION_LIMITS.revisionHistory - 1), {
      revision, at: now, change: `revised:${changed.join(',')}`, reason: text(reason, 200),
    }],
  }
  return {
    grant: next,
    changed,
    auth: { ...auth, sequence: auth.sequence + 1, grants: auth.grants.map(item => (item.grant_id === next.grant_id ? next : item)) },
  }
}

export function revokeAuthorization(auth, { grant_id: grantId, reason } = {}, now) {
  const grant = auth.grants.find(item => item.grant_id === text(grantId, 200))
  if (!grant) return { refused: GRANT_REFUSAL.GRANT_NOT_FOUND }
  if (grant.status !== GRANT_STATUS.ACTIVE) return { refused: GRANT_REFUSAL.GRANT_REVOKED }
  const revision = grant.revision + 1
  const next = {
    ...grant,
    status: GRANT_STATUS.REVOKED,
    revision,
    updated_at: now,
    revoked_at: now,
    revision_history: [...recent(grant.revision_history, AUTHORIZATION_LIMITS.revisionHistory - 1), {
      revision, at: now, change: 'revoked', reason: text(reason, 200),
    }],
  }
  return {
    grant: next,
    auth: { ...auth, sequence: auth.sequence + 1, grants: auth.grants.map(item => (item.grant_id === next.grant_id ? next : item)) },
  }
}

// --- the grant check -------------------------------------------------------

/**
 * Is this grant reference still current?
 *
 * `ref` = { grant_id, grant_revision, actor_id?, actor_epoch? }. A grant bound to an actor is refused when the
 * caller does not supply that actor (`actor_unverified`), when the actor was replaced, or when its epoch moved:
 * stale work after replacement, death, restart or an epoch change fails safely.
 */
export function checkGrant(auth, goal, ref) {
  if (!auth || auth.grants.length === 0) return { ok: false, reason: GRANT_REFUSAL.NO_AUTHORIZATION }
  const grant = auth.grants.find(item => item.grant_id === text(ref?.grant_id, 200))
  if (!grant) return { ok: false, reason: GRANT_REFUSAL.GRANT_NOT_FOUND }
  const base = { grant_id: grant.grant_id, grant_revision: grant.revision }
  if (grant.status !== GRANT_STATUS.ACTIVE) return { ok: false, reason: GRANT_REFUSAL.GRANT_REVOKED, ...base }
  if (ref?.grant_revision !== grant.revision) return { ok: false, reason: GRANT_REFUSAL.GRANT_REVISION_STALE, ...base, held_revision: ref?.grant_revision }
  if (!goal || goal.status !== 'active') return { ok: false, reason: GRANT_REFUSAL.GOAL_NOT_ACTIVE, ...base }
  if (goal.goal_id !== grant.goal_id) return { ok: false, reason: GRANT_REFUSAL.GOAL_MISMATCH, ...base }
  if (grant.actor) {
    const hasActor = Number.isSafeInteger(ref?.actor_id) && Number.isSafeInteger(ref?.actor_epoch)
    if (!hasActor) return { ok: false, reason: GRANT_REFUSAL.ACTOR_UNVERIFIED, ...base }
    if (grant.actor.actor_id !== null && grant.actor.actor_id !== ref.actor_id) return { ok: false, reason: GRANT_REFUSAL.ACTOR_REPLACED, ...base }
    if (grant.actor.actor_epoch !== null && grant.actor.actor_epoch !== ref.actor_epoch) return { ok: false, reason: GRANT_REFUSAL.ACTOR_EPOCH_CHANGED, ...base }
  }
  return { ok: true, grant, ...base }
}

// --- world facts: NPC placements and reservations ---------------------------

export function recordNpcPlacement(auth, raw, now) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.unit_number) || raw.unit_number < 1) return { refused: 'invalid_placement' }
  const entry = {
    unit_number: raw.unit_number,
    entity_name: text(raw.entity_name, 120),
    actor_id: Number.isSafeInteger(raw.actor_id) ? raw.actor_id : null,
    actor_epoch: Number.isSafeInteger(raw.actor_epoch) ? raw.actor_epoch : null,
    // The engine's last_user right after placement (nil for the standalone NPC; the controlled player's name in the
    // legacy connected-player mode). A DIFFERENT human last_user later means a player changed the entity.
    placed_last_user: text(raw.placed_last_user, 80) || null,
    at: now,
  }
  const placements = auth.world.npc_placements.filter(item => item.unit_number !== entry.unit_number)
  return {
    auth: {
      ...auth,
      world: { ...auth.world, npc_placements: recent([...placements, entry], AUTHORIZATION_LIMITS.placements) },
    },
    placement: entry,
  }
}

export function recordReservation(auth, raw, now) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.unit_number) || raw.unit_number < 1) return { refused: 'invalid_reservation' }
  const existing = auth.world.reservations.find(item => item.unit_number === raw.unit_number && item.status === 'active')
  if (existing) return { refused: 'already_reserved', reservation: existing }
  const sequence = auth.sequence + 1
  const reservation = {
    reservation_id: `res_${raw.unit_number}_${sequence}`,
    unit_number: raw.unit_number,
    entity_name: text(raw.entity_name, 120) || null,
    surface_index: Number.isSafeInteger(raw.surface_index) ? raw.surface_index : null,
    position: isRecord(raw.position) && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)
      ? { x: raw.position.x, y: raw.position.y }
      : null,
    reserved_by: text(raw.reserved_by, 128) || null,
    status: 'active',
    reserved_at: now,
    released_at: null,
    released_by: null,
  }
  return {
    reservation,
    auth: {
      ...auth,
      sequence,
      world: { ...auth.world, reservations: recent([...auth.world.reservations, reservation], AUTHORIZATION_LIMITS.reservations) },
    },
  }
}

export function releaseReservation(auth, raw, now) {
  const unit = Number.isSafeInteger(raw?.unit_number) ? raw.unit_number : undefined
  const id = text(raw?.reservation_id, 80)
  const target = auth.world.reservations.find(item => item.status === 'active'
    && ((unit !== undefined && item.unit_number === unit) || (id && item.reservation_id === id)))
  if (!target) return { refused: 'not_reserved' }
  const released = { ...target, status: 'released', released_at: now, released_by: text(raw?.released_by, 128) || null }
  return {
    reservation: released,
    auth: {
      ...auth,
      sequence: auth.sequence + 1,
      world: { ...auth.world, reservations: auth.world.reservations.map(item => (item === target ? released : item)) },
    },
  }
}

export function activeReservations(auth) {
  return (auth?.world?.reservations ?? []).filter(item => item.status === 'active')
}

/** Unit numbers of reserved containers: the exclusion list for availability queries. */
export function reservedContainerUnitNumbers(auth) {
  return activeReservations(auth).map(item => item.unit_number)
}

/** Mark observed entities with `reserved: true` and, for the model's availability view, drop nothing silently. */
export function annotateReservedEntities(auth, entities) {
  const reserved = new Set(reservedContainerUnitNumbers(auth))
  if (reserved.size === 0 || !Array.isArray(entities)) return entities
  return entities.map(entity => (reserved.has(entity?.unit_number) ? { ...entity, reserved: true } : entity))
}

// --- approvals and questions -----------------------------------------------

export function raiseQuestion(auth, raw, now) {
  const reasons = stringList(raw.reason_codes, { max: 8, maxLength: 60 })
  const planId = text(raw.plan_id, 200)
  const kind = text(raw.kind, 40) || 'replacement_approval'
  const duplicate = auth.questions.find(item => item.status === 'pending'
    && item.kind === kind
    && item.plan_id === (planId || null)
    && item.reason_codes.join('|') === reasons.join('|')
    && item.subject_key === text(raw.subject_key, 200))
  if (duplicate) return { auth, question: duplicate, duplicate: true }
  const sequence = auth.sequence + 1
  const question = {
    question_id: `q${sequence}`,
    kind,
    reason_codes: reasons,
    plan_id: planId || null,
    goal_id: text(raw.goal_id, 120) || null,
    grant_id: text(raw.grant_id, 200) || null,
    grant_revision: Number.isSafeInteger(raw.grant_revision) ? raw.grant_revision : null,
    subject_key: text(raw.subject_key, 200),
    subjects: boundedSubjects(raw.subjects),
    detail: text(raw.detail, 400),
    status: 'pending',
    raised_at: now,
    answered_at: null,
  }
  return {
    question,
    auth: { ...auth, sequence, questions: recent([...auth.questions, question], AUTHORIZATION_LIMITS.questions) },
  }
}

function boundedSubjects(raw) {
  return (Array.isArray(raw) ? raw : []).flatMap((item) => {
    if (Number.isSafeInteger(item)) return [item]
    const label = text(item, 120)
    return label ? [label] : []
  }).slice(0, AUTHORIZATION_LIMITS.unitNumbers)
}

/** A user's answer. `approve` clears the named reasons for the named subjects on one plan; `deny` is recorded. */
export function recordApproval(auth, raw, now) {
  const approvedBy = text(raw?.approved_by, 128)
  const decision = text(raw?.decision, 20)
  if (!approvedBy || !['approve', 'deny'].includes(decision)) return { refused: 'invalid_approval' }
  const reasons = stringList(raw.reason_codes, { max: 8, maxLength: 60 })
  if (reasons.length === 0) return { refused: 'invalid_approval' }
  const question = raw.question_id ? auth.questions.find(item => item.question_id === text(raw.question_id, 40)) : undefined
  if (raw.question_id && (!question || question.status !== 'pending')) return { refused: 'question_not_pending' }
  const sequence = auth.sequence + 1
  const approval = {
    approval_id: `a${sequence}`,
    question_id: question?.question_id ?? null,
    decision,
    reason_codes: reasons,
    plan_id: text(raw.plan_id, 200) || question?.plan_id || null,
    goal_id: text(raw.goal_id, 120) || question?.goal_id || null,
    subjects: boundedSubjects(raw.subjects ?? question?.subjects),
    approved_by: approvedBy,
    at: now,
    consumed: false,
  }
  return {
    approval,
    auth: {
      ...auth,
      sequence,
      questions: auth.questions.map(item => (item === question ? { ...item, status: 'answered', answered_at: now } : item)),
      approvals: recent([...auth.approvals, approval], AUTHORIZATION_LIMITS.approvals),
    },
  }
}

export function consumeApproval(auth, approvalId) {
  return { ...auth, approvals: auth.approvals.map(item => (item.approval_id === approvalId ? { ...item, consumed: true } : item)) }
}

export function recordRefusal(auth, raw, now) {
  const entry = {
    at: now,
    stage: text(raw.stage, 40) || 'replacement',
    reason: text(raw.reason, 80),
    grant_id: text(raw.grant_id, 200) || null,
    grant_revision: Number.isSafeInteger(raw.grant_revision) ? raw.grant_revision : null,
    plan_id: text(raw.plan_id, 200) || null,
  }
  return { ...auth, refusals: recent([...auth.refusals, entry], AUTHORIZATION_LIMITS.refusals) }
}

function approvalCovers(auth, { approvalId, planId, goalId, reason, subject }) {
  const approval = auth.approvals.find(item => item.approval_id === approvalId)
  if (!approval || approval.decision !== 'approve' || approval.consumed) return false
  if (approval.goal_id && approval.goal_id !== goalId) return false
  if (planId !== undefined && approval.plan_id !== planId) return false
  if (!approval.reason_codes.includes(reason)) return false
  if (subject !== undefined && approval.subjects.length > 0 && !approval.subjects.includes(subject)) return false
  return true
}

// --- protected assets ------------------------------------------------------

/**
 * Is this existing entity a player's?
 *
 * Owner decision (2026-09-30): Factorio's `LuaEntity.last_user` marks the entity player-built. The standalone NPC
 * character is not a LuaPlayer and its placements leave last_user empty (tests/factorio last_user lane), so an
 * entity with NO last_user is not protected by that rule. NPC placements are identified by their placement
 * receipts; in the legacy connected-player mode the NPC's own player identity is the placement's last_user and is
 * not treated as a human change. A human last_user that differs from the placement-time one marks a player edit.
 * An explicitly protected unit number in an active grant is always protected.
 */
export function entityProtection(auth, { unit_number: unitNumber, last_user: lastUser } = {}, { goalId } = {}) {
  const explicit = auth?.grants?.some(grant => grant.status === GRANT_STATUS.ACTIVE
    && (!goalId || grant.goal_id === goalId)
    && grant.protected_assets.unit_numbers.includes(unitNumber))
  if (explicit) return { protected: true, reason: 'grant_protected_asset' }
  const name = text(lastUser?.name, 80)
  if (!name) return { protected: false, reason: 'no_human_last_user' }
  const placement = auth?.world?.npc_placements?.find(item => item.unit_number === unitNumber)
  if (placement && placement.placed_last_user === name) return { protected: false, reason: 'npc_placement_receipt' }
  return { protected: true, reason: placement ? 'human_changed_npc_placement' : 'human_last_user', last_user: name }
}

// --- the replacement decision ----------------------------------------------

/**
 * Decide a replacement-plan request against the current grant. Pure; the reducer handler and the harness call it
 * with the same inputs, so the trace and the state change cannot disagree.
 *
 * request: { plan_id, grant:{grant_id,revision}, current:{actor_id,actor_epoch}, requested_result, action_scope,
 *            reason:{code,detail,evidence_refs}, impacts:{player_built_unit_numbers, consumed_container_unit_numbers,
 *            consumed_items, touched_constraints}, approval_id?, steps }
 *
 * Returns { decision: 'accept' | 'ask' | 'refuse', reason, ... }.
 */
export function classifyReplacement(state, request) {
  const auth = authorizationOf(state)
  const goal = state?.goal
  const refuse = (reason, extra = {}) => ({ decision: REPLACEMENT_DECISION.REFUSE, reason, ...extra })
  if (!isRecord(request) || !isRecord(request.grant)) return refuse(REPLACEMENT_REFUSAL.INVALID_REQUEST)
  const planId = text(request.plan_id, 200)
  const predecessor = state?.plans?.find(plan => plan.plan_id === planId)
  if (!planId || !predecessor) return refuse(REPLACEMENT_REFUSAL.PREDECESSOR_NOT_FOUND)
  if (predecessor.status !== 'BLOCKED') return refuse(REPLACEMENT_REFUSAL.PREDECESSOR_NOT_BLOCKED, { plan_id: planId })
  // Only the CURRENT blocked plan can be replaced: a replacement may never displace a healthy active plan, stack on a
  // replacement draft that is already pending, or resurrect a plan something else already succeeded.
  if (predecessor.superseded_by_plan_id) return refuse(REPLACEMENT_REFUSAL.PREDECESSOR_ALREADY_REPLACED, { plan_id: planId })
  if (state.active_plan_id !== planId) return refuse(REPLACEMENT_REFUSAL.PREDECESSOR_NOT_ACTIVE, { plan_id: planId })
  if (state.plans.some(plan => plan.replacement && ['DRAFT', 'RUNTIME_VALIDATION', 'READY'].includes(plan.status))) {
    return refuse(REPLACEMENT_REFUSAL.REPLACEMENT_PENDING, { plan_id: planId })
  }

  const check = checkGrant(auth, goal, {
    grant_id: request.grant.grant_id,
    grant_revision: request.grant.revision,
    actor_id: request.current?.actor_id,
    actor_epoch: request.current?.actor_epoch,
  })
  if (!check.ok) return refuse(check.reason, { stale: true, plan_id: planId, grant_id: check.grant_id ?? text(request.grant.grant_id, 200), grant_revision: check.grant_revision })
  const grant = check.grant

  const reason = {
    code: text(request.reason?.code, 120),
    detail: text(request.reason?.detail, 400),
    evidence_refs: stringList(request.reason?.evidence_refs, { max: AUTHORIZATION_LIMITS.evidenceRefs, maxLength: 200 }),
  }
  // A replacement is grounded in an OBSERVED failure or shortage: a code and at least one evidence reference.
  if (!reason.code || reason.evidence_refs.length === 0) return refuse(REPLACEMENT_REFUSAL.REASON_NOT_GROUNDED, { plan_id: planId, grant_id: grant.grant_id })
  if (!Array.isArray(request.steps) || request.steps.length === 0) return refuse(REPLACEMENT_REFUSAL.STEPS_EMPTY, { plan_id: planId, grant_id: grant.grant_id })

  const asks = []
  const result = sanitizeRequestedResult(request.requested_result)
  if (!result || result.result_key !== grant.requested_result.result_key) asks.push(ASK_REASON.OUTCOME_CHANGED)
  else if (result.destination !== grant.requested_result.destination) asks.push(ASK_REASON.DESTINATION_CHANGED)

  const scope = text(request.action_scope, 60)
  if (!scope || !grant.permitted_scope.includes(scope)) asks.push(ASK_REASON.SCOPE_NOT_GRANTED)

  const impacts = isRecord(request.impacts) ? request.impacts : {}
  const playerBuilt = unitNumberList(impacts.player_built_unit_numbers)
  const consumedContainers = unitNumberList(impacts.consumed_container_unit_numbers)
  const consumedItems = stringList(impacts.consumed_items, { max: 32, maxLength: 120 })
  const touchedConstraints = stringList(impacts.touched_constraints, { max: 16, maxLength: 300 })

  const reservedUnits = new Set(reservedContainerUnitNumbers(auth))
  const reservedHits = consumedContainers.filter(unit => reservedUnits.has(unit)
    || grant.protected_materials.some(material => material.container_unit_number === unit))
  const protectedItemNames = new Set(grant.protected_materials.map(material => material.item_name).filter(Boolean))
  const reservedItemHits = consumedItems.filter(name => protectedItemNames.has(name))

  const context = { approvalId: text(request.approval_id, 40) || undefined, planId, goalId: goal?.goal_id }
  const unapproved = (reasonCode, subjects) => subjects.filter(subject => !approvalCovers(auth, { ...context, reason: reasonCode, subject }))
  const askDetail = {}
  const addAsk = (code, subjects) => {
    const pending = unapproved(code, subjects)
    if (pending.length === 0) return
    asks.push(code)
    askDetail[code] = pending
  }
  if (playerBuilt.length > 0) addAsk(ASK_REASON.PROTECTED_REDESIGN, playerBuilt)
  if (reservedHits.length > 0 || reservedItemHits.length > 0) addAsk(ASK_REASON.RESERVED_SUPPLIES, [...reservedHits, ...reservedItemHits])
  if (touchedConstraints.length > 0) addAsk(ASK_REASON.CONSTRAINT_CROSSED, touchedConstraints)

  // A scope outside the grant can be cleared by an approval for that reason; the others cannot (see above).
  const effectiveAsks = [...new Set(asks)].filter(code => code !== ASK_REASON.SCOPE_NOT_GRANTED
    || !approvalCovers(auth, { ...context, reason: code, subject: undefined }))
  if (effectiveAsks.length > 0) {
    return {
      decision: REPLACEMENT_DECISION.ASK,
      reason: effectiveAsks[0],
      reason_codes: effectiveAsks,
      approvable: effectiveAsks.every(code => !NOT_APPROVABLE_ASK.includes(code)),
      subjects: askDetail,
      plan_id: planId,
      grant_id: grant.grant_id,
      grant_revision: grant.revision,
    }
  }

  return {
    decision: REPLACEMENT_DECISION.ACCEPT,
    reason: 'within_grant',
    plan_id: planId,
    grant_id: grant.grant_id,
    grant_revision: grant.revision,
    mandate_kind: grant.mandate_kind,
    action_scope: scope,
    requested_result: result,
    replacement_reason: reason,
    approval_id: context.approvalId ?? null,
    steps_fingerprint: replacementStepsFingerprint(request.steps),
  }
}

/** The lineage a committed-or-pending replacement plan carries (immutable after the plan commits). */
export function replacementLineage(verdict, { predecessorPlanId, now }) {
  return {
    predecessor_plan_id: predecessorPlanId,
    grant_id: verdict.grant_id,
    grant_revision: verdict.grant_revision,
    mandate_kind: verdict.mandate_kind,
    action_scope: verdict.action_scope,
    requested_result: clone(verdict.requested_result),
    reason: clone(verdict.replacement_reason),
    approval_id: verdict.approval_id ?? null,
    steps_fingerprint: verdict.steps_fingerprint,
    requested_at: now,
  }
}

/**
 * The commit-time grant check for a plan that carries replacement lineage. A draft whose steps drifted from what was
 * classified is refused too: the authorization covered THOSE steps.
 */
export function checkReplacementAtCommit(state, plan, current) {
  const lineage = plan?.replacement
  if (!lineage) return { ok: true, reason: 'not_a_replacement' }
  const check = checkGrant(authorizationOf(state), state?.goal, {
    grant_id: lineage.grant_id,
    grant_revision: lineage.grant_revision,
    actor_id: current?.actor_id,
    actor_epoch: current?.actor_epoch,
  })
  if (!check.ok) return { ...check, stage: 'commit', plan_id: plan.plan_id, stale: true }
  if (replacementStepsFingerprint(plan.steps) !== lineage.steps_fingerprint) {
    return { ok: false, reason: REPLACEMENT_REFUSAL.STEPS_CHANGED_SINCE_AUTHORIZATION, stage: 'commit', plan_id: plan.plan_id, grant_id: lineage.grant_id, grant_revision: lineage.grant_revision }
  }
  return { ok: true, reason: 'within_grant', stage: 'commit', plan_id: plan.plan_id, grant_id: lineage.grant_id, grant_revision: lineage.grant_revision }
}

// --- operation admission ----------------------------------------------------

function hasApproval(auth, { reason, subject, goalId }) {
  return auth.approvals.some(item => item.decision === 'approve'
    && !item.consumed
    && item.reason_codes.includes(reason)
    && (!item.goal_id || item.goal_id === goalId)
    && item.subjects.includes(subject))
}

/**
 * Admission check for a batch of operations, run by the harness right before they are sent to the game.
 *
 *   1. If the active plan is a replacement, its grant must still be current (revision, goal, actor epoch).
 *   2. An exact operation that removes, rotates, mines or reconfigures a PLAYER-BUILT entity is refused without an
 *      approval record for that entity.
 *   3. Reserved containers are never withdrawn from (or mined), and a player's inventory is never a source.
 *
 * `preflight[i].target` carries the engine's view of operation i's exact target (`last_user`). Returns
 * { ok: true } or { ok: false, code, reason, operation_index, ... } for the FIRST refused operation.
 */
export function evaluateOperationAdmission(state, { operations, preflight, actor } = {}) {
  const auth = authorizationOf(state)
  const goalId = state?.goal?.goal_id
  const plan = state?.plans?.find(item => item.plan_id === state.active_plan_id)
  if (plan?.replacement) {
    const check = checkGrant(auth, state.goal, {
      grant_id: plan.replacement.grant_id,
      grant_revision: plan.replacement.grant_revision,
      actor_id: actor?.actor_id,
      actor_epoch: actor?.actor_epoch,
    })
    if (!check.ok) {
      return {
        ok: false,
        code: ADMISSION_REFUSAL.AUTHORIZATION_STALE,
        reason: check.reason,
        stage: 'admission',
        grant_id: plan.replacement.grant_id,
        grant_revision: plan.replacement.grant_revision,
        plan_id: plan.plan_id,
        operation_index: 0,
      }
    }
  }

  // INTERIM (owner decision pending): protected-asset and player-inventory gates apply only to grant-backed work - a plan
  // that carries replacement lineage, or any goal with an active grant. An ordinary user-requested goal is the player's own
  // request and behaves as before MW1. Reserved-container exclusion applies to every goal.
  // MW5: admission issues a bare player_task grant (no protected assets or materials) to every player objective so a
  // replacement can be authorized. That grant records the request itself; it does not turn the gates on for an ordinary goal.
  const grantBacked = Boolean(plan?.replacement) || auth.grants.some(grant => grant.status === GRANT_STATUS.ACTIVE
    && grant.goal_id === goalId
    && !(grant.mandate_kind === MANDATE_KIND.PLAYER_TASK
      && grant.protected_assets.unit_numbers.length === 0
      && grant.protected_materials.length === 0))

  const reservations = activeReservations(auth)
  const reservedUnits = new Set(reservations.map(item => item.unit_number))
  const reservedNames = new Set(reservations.map(item => item.entity_name).filter(Boolean))
  const list = Array.isArray(operations) ? operations : []
  for (let index = 0; index < list.length; index += 1) {
    const operation = list[index]
    const args = operation?.args ?? {}
    const name = operation?.name
    const target = preflight?.[index]?.target

    if (grantBacked && name === 'move_items_with_player' && args.to_player === false) {
      return { ok: false, code: ADMISSION_REFUSAL.PLAYER_INVENTORY, reason: 'player_inventories_are_never_available', operation: name, operation_index: index, player_name: text(args.player_name, 80) }
    }

    const unit = Number.isSafeInteger(args.unit_number) ? args.unit_number : undefined
    const withdraws = (name === 'move_items_exact' && args.to_entity === false) || name === 'mine_entity_exact'
    if (withdraws && unit !== undefined && reservedUnits.has(unit) && !hasApproval(auth, { reason: APPROVAL_REASON.RESERVED_SUPPLY, subject: unit, goalId })) {
      return { ok: false, code: ADMISSION_REFUSAL.RESERVED_SUPPLY, reason: 'container_is_reserved', operation: name, operation_index: index, unit_number: unit }
    }
    // A name-based withdrawal cannot say which container it will take from; while a container of that name is
    // reserved it is refused rather than guessed. The exact variant (move_items_exact) is the supported path.
    if (name === 'move_items' && args.to_entity === false && reservedNames.has(args.entity_name)) {
      return { ok: false, code: ADMISSION_REFUSAL.RESERVED_AMBIGUOUS, reason: 'name_based_withdrawal_while_a_container_of_that_name_is_reserved', operation: name, operation_index: index, entity_name: text(args.entity_name, 120) }
    }
    // Name-based mining picks its target inside the mod; while a container of that name is reserved it could pick the
    // reserved one, so it is refused. (clear_construction_area is a known gap: its targets are chosen in the mod too.)
    if (name === 'mine_entity' && reservedNames.has(args.entity_name)) {
      return { ok: false, code: ADMISSION_REFUSAL.RESERVED_AMBIGUOUS, reason: 'name_based_mining_while_a_container_of_that_name_is_reserved', operation: name, operation_index: index, entity_name: text(args.entity_name, 120) }
    }

    if (grantBacked && PROTECTED_MUTATION_OPERATIONS.includes(name) && unit !== undefined) {
      const protection = entityProtection(auth, { unit_number: unit, last_user: target?.last_user }, { goalId })
      if (protection.protected && !hasApproval(auth, { reason: APPROVAL_REASON.PROTECTED_ENTITY, subject: unit, goalId })) {
        return {
          ok: false,
          code: ADMISSION_REFUSAL.PROTECTED_ENTITY,
          reason: protection.reason,
          operation: name,
          operation_index: index,
          unit_number: unit,
          last_user: protection.last_user ?? null,
        }
      }
    }
  }
  return { ok: true }
}

// --- persistence -----------------------------------------------------------

export function serializeAuthorization(auth) {
  return auth ? clone(auth) : undefined
}

function restoreGrant(raw) {
  const fields = sanitizeGrantFields(raw)
  if (!fields) return undefined
  const grantId = grantIdFor(fields.mandate_kind, fields.mandate_id)
  const revision = Number.isSafeInteger(raw.revision) && raw.revision >= 1 ? raw.revision : 1
  const status = raw.status === GRANT_STATUS.REVOKED ? GRANT_STATUS.REVOKED : GRANT_STATUS.ACTIVE
  return {
    grant_id: grantId,
    ...fields,
    revision,
    status,
    granted_at: finiteNumber(raw.granted_at) ?? 0,
    updated_at: finiteNumber(raw.updated_at) ?? 0,
    revoked_at: status === GRANT_STATUS.REVOKED ? (finiteNumber(raw.revoked_at) ?? 0) : null,
    revision_history: recent(raw.revision_history, AUTHORIZATION_LIMITS.revisionHistory).flatMap(item => (isRecord(item)
      ? [{ revision: Number.isSafeInteger(item.revision) ? item.revision : 0, at: finiteNumber(item.at) ?? 0, change: text(item.change, 80), reason: text(item.reason, 200) }]
      : [])),
  }
}

function restoreQuestion(raw) {
  if (!isRecord(raw) || !text(raw.question_id, 40)) return undefined
  return {
    question_id: text(raw.question_id, 40),
    kind: text(raw.kind, 40) || 'replacement_approval',
    reason_codes: stringList(raw.reason_codes, { max: 8, maxLength: 60 }),
    plan_id: text(raw.plan_id, 200) || null,
    goal_id: text(raw.goal_id, 120) || null,
    grant_id: text(raw.grant_id, 200) || null,
    grant_revision: Number.isSafeInteger(raw.grant_revision) ? raw.grant_revision : null,
    subject_key: text(raw.subject_key, 200),
    subjects: boundedSubjects(raw.subjects),
    detail: text(raw.detail, 400),
    status: raw.status === 'answered' ? 'answered' : 'pending',
    raised_at: finiteNumber(raw.raised_at) ?? 0,
    answered_at: finiteNumber(raw.answered_at) ?? null,
  }
}

function restoreApproval(raw) {
  if (!isRecord(raw) || !text(raw.approval_id, 40)) return undefined
  const decision = raw.decision === 'deny' ? 'deny' : raw.decision === 'approve' ? 'approve' : undefined
  if (!decision) return undefined
  return {
    approval_id: text(raw.approval_id, 40),
    question_id: text(raw.question_id, 40) || null,
    decision,
    reason_codes: stringList(raw.reason_codes, { max: 8, maxLength: 60 }),
    plan_id: text(raw.plan_id, 200) || null,
    goal_id: text(raw.goal_id, 120) || null,
    subjects: boundedSubjects(raw.subjects),
    approved_by: text(raw.approved_by, 128),
    at: finiteNumber(raw.at) ?? 0,
    consumed: raw.consumed === true,
  }
}

function restorePlacement(raw) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.unit_number) || raw.unit_number < 1) return undefined
  return {
    unit_number: raw.unit_number,
    entity_name: text(raw.entity_name, 120),
    actor_id: Number.isSafeInteger(raw.actor_id) ? raw.actor_id : null,
    actor_epoch: Number.isSafeInteger(raw.actor_epoch) ? raw.actor_epoch : null,
    placed_last_user: text(raw.placed_last_user, 80) || null,
    at: finiteNumber(raw.at) ?? 0,
  }
}

function restoreReservation(raw) {
  if (!isRecord(raw) || !Number.isSafeInteger(raw.unit_number) || raw.unit_number < 1) return undefined
  return {
    reservation_id: text(raw.reservation_id, 80) || `res_${raw.unit_number}_0`,
    unit_number: raw.unit_number,
    entity_name: text(raw.entity_name, 120) || null,
    surface_index: Number.isSafeInteger(raw.surface_index) ? raw.surface_index : null,
    position: isRecord(raw.position) && Number.isFinite(raw.position.x) && Number.isFinite(raw.position.y)
      ? { x: raw.position.x, y: raw.position.y }
      : null,
    reserved_by: text(raw.reserved_by, 128) || null,
    status: raw.status === 'released' ? 'released' : 'active',
    reserved_at: finiteNumber(raw.reserved_at) ?? 0,
    released_at: finiteNumber(raw.released_at) ?? null,
    released_by: text(raw.released_by, 128) || null,
  }
}

/** Restore a persisted record; anything malformed is dropped rather than trusted. `undefined` when empty. */
export function restoreAuthorization(raw) {
  if (!isRecord(raw)) return undefined
  const world = isRecord(raw.world) ? raw.world : {}
  const auth = {
    version: AUTHORIZATION_VERSION,
    sequence: Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0,
    grants: recent(raw.grants, AUTHORIZATION_LIMITS.grants).map(restoreGrant).filter(Boolean),
    questions: recent(raw.questions, AUTHORIZATION_LIMITS.questions).map(restoreQuestion).filter(Boolean),
    approvals: recent(raw.approvals, AUTHORIZATION_LIMITS.approvals).map(restoreApproval).filter(Boolean),
    refusals: recent(raw.refusals, AUTHORIZATION_LIMITS.refusals).flatMap(item => (isRecord(item)
      ? [{
          at: finiteNumber(item.at) ?? 0,
          stage: text(item.stage, 40),
          reason: text(item.reason, 80),
          grant_id: text(item.grant_id, 200) || null,
          grant_revision: Number.isSafeInteger(item.grant_revision) ? item.grant_revision : null,
          plan_id: text(item.plan_id, 200) || null,
        }]
      : [])),
    world: {
      npc_placements: recent(world.npc_placements, AUTHORIZATION_LIMITS.placements).map(restorePlacement).filter(Boolean),
      reservations: recent(world.reservations, AUTHORIZATION_LIMITS.reservations).map(restoreReservation).filter(Boolean),
    },
  }
  return authorizationHasContent(auth) ? auth : undefined
}
