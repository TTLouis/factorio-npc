// Handoff packet builder (delegation plan 3.4a, design note section 5).
//
// A pure function of reducer state. When a conversation is discarded and a
// fresh one starts (a restage), the fresh one is briefed from this packet, not
// from the old transcript and not from a model summary. Nothing here reads the
// legacy task board, the message history or any provider output; the only
// model prose that can enter is the ending conversation's optional annotation,
// which is sanitized, capped, labelled unverified and never the sole carrier of
// state.
//
// Layout (design note section 5): a PLAN block first, then a STEP block.
//  - The PLAN block (`stableText`: goal, done-when, roadmap node, committed
//    plan id/version and step list) contains nothing that changes while the
//    plan executes: no step status, no timestamps, no handoff id, no
//    per-call values. It is byte-identical for every context of one committed
//    plan so the provider cache keeps hitting up to its end.
//  - The STEP block (`volatileText`: role, checkpoint, step statuses, active
//    step, receipt tail, loaded skills, budget, note) follows.
//  - Sizes are reported in characters and in estimated tokens (ceil(chars/4));
//    the restage policy measures its limits in provider-reported tokens.
//
// Size control: the packet is built from whole records. Over the limit, the
// lowest-priority records are dropped in a fixed order; a record is never cut
// mid-way. Mandatory records are never dropped (the result reports
// `over_limit: true` if they alone exceed the limit).
//
// Unwired: nothing calls this yet.

import { createHash } from 'node:crypto'

import { describeGoalCondition } from './goal-definition.mjs'
import {
  buildContextRestagedEvent,
  CONTEXT_RESTAGE_CHECKPOINTS,
  CONTEXT_RESTAGE_ROLES,
  getActivePlan,
  nearestShelfRefinementTarget,
} from './planning-state.mjs'

export const HANDOFF_PACKET_LIMITS = Object.freeze({
  // Design note section 5: start at 6,000 characters; set from the first live run.
  maxChars: 6000,
  receiptTail: 5,
  noteChars: 500,
  objectiveChars: 400,
  constraintChars: 200,
  constraints: 8,
  stepChars: 300,
  budgetChars: 200,
  skillIds: 16,
  reasonChars: 200,
})

// Drop order when over the limit: first entry is dropped first. Receipts go
// oldest first inside their group. Steps drop completed (earliest first) before
// pending (last first). Anything not listed is mandatory.
export const HANDOFF_DROP_ORDER = Object.freeze([
  'note',
  'receipt',
  'skills',
  'budget',
  'roadmap_node',
  'step_completed',
  'step_pending',
])

const HEADER = '[HANDOFF] Rebuilt from durable harness state, not from the previous conversation. Verify against the world before acting.'

function oneLine(value, max) {
  const flat = String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

// Same redaction rules as sanitizeDurableModelText in npc-agent-loop.mjs
// (historical unit numbers must not steer a fresh conversation to stale
// entities). Duplicated because that helper is private to the agent loop and
// this module must stay importable without it.
export function sanitizeHandoffNote(value, max = HANDOFF_PACKET_LIMITS.noteChars) {
  const text = oneLine(value, Math.max(2000, String(value ?? '').length))
    .replace(/(["']?(?:target_)?unit_number["']?\s*[:=]\s*)\d+/gi, '$1[historical-id-omitted]')
    .replace(/(["']?observed_unit_numbers["']?\s*[:=]\s*)\[[^\]]*\]/gi, '$1[historical-ids-omitted]')
    .replace(/\b(?:unit_number|target_unit_number)[_:#-]?\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\bunit[_:#-]\d+\b/gi, 'historical-exact-identity-[omitted]')
    .replace(/\b(?:exact\s+entity\s+target\s+|target\s+)?unit\s+#?\d+\b/gi, 'historical exact identity [omitted]')
  return oneLine(text, max)
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function stepStatus(plan, step) {
  return plan.execution?.step_progress?.[step.step_id]?.status ?? 'pending'
}

function skillIdsOf(state, plan) {
  const raw = plan?.loaded_skill_ids ?? state?.loaded_skill_ids
  if (!Array.isArray(raw)) return []
  return raw.filter(id => typeof id === 'string' && id).slice(0, HANDOFF_PACKET_LIMITS.skillIds)
}

// A record is { key, block: 'plan'|'step', drop?: string, rank?: number, text }.
// `rank` orders records inside one drop group (higher drops first).
function goalRecords(state, limits) {
  const goal = state.goal
  const records = []
  records.push({ key: 'goal_id', block: 'plan', text: `goal_id: ${goal.goal_id}` })
  records.push({ key: 'goal_text', block: 'plan', text: `goal: ${oneLine(goal.objective, limits.objectiveChars)}` })
  const constraints = (Array.isArray(goal.constraints) ? goal.constraints : []).slice(0, limits.constraints)
  for (const [index, constraint] of constraints.entries()) {
    records.push({ key: `constraint_${index}`, block: 'plan', text: `constraint: ${oneLine(constraint, limits.constraintChars)}` })
  }
  const definition = goal.definition
  if (definition) {
    records.push({ key: 'goal_scope', block: 'plan', text: `scope: ${definition.scope}; ${oneLine(definition.summary, limits.objectiveChars)}` })
    for (const condition of definition.done_when ?? []) {
      records.push({ key: `done_${condition.id}`, block: 'plan', text: `done_when ${condition.id}: ${oneLine(describeGoalCondition(condition), limits.objectiveChars)}` })
    }
  }
  else {
    records.push({ key: 'goal_scope', block: 'plan', text: 'done_when: not defined yet' })
  }
  return records
}

function roadmapRecord(state, plan) {
  const nodes = state.roadmap?.nodes ?? []
  const ids = plan?.roadmap_node_ids ?? []
  const lines = ids.flatMap((id) => {
    const node = nodes.find(item => item.id === id)
    return node ? [`${node.id}: ${oneLine(node.intent, 200)}`] : []
  })
  if (lines.length > 0) return { key: 'roadmap_node', block: 'plan', drop: 'roadmap_node', text: `roadmap_node: ${lines.join(' | ')}` }
  // No plan yet (new goal or shelf pickup): the nearest ready node, labelled.
  const next = plan ? undefined : nearestShelfRefinementTarget(state)
  if (next) return { key: 'roadmap_node', block: 'plan', drop: 'roadmap_node', text: `roadmap_node (next candidate, not yet refined): ${next.node_id}: ${oneLine(next.intent, 200)}` }
  return undefined
}

function planRecords(plan, activeIndex, limits) {
  if (!plan) return [{ key: 'plan', block: 'plan', text: 'plan: none committed yet' }]
  const records = [{ key: 'plan', block: 'plan', text: `plan: ${plan.plan_id} v${plan.plan_version}` }]
  plan.steps.forEach((step, index) => {
    const status = stepStatus(plan, step)
    const isActive = index === activeIndex
    const record = { key: `step_${index}`, block: 'plan', text: `step ${index + 1}: ${step.step_id} | ${oneLine(step.description, limits.stepChars)}` }
    if (!isActive) {
      record.drop = status === 'completed' ? 'step_completed' : 'step_pending'
      // completed: earliest first; pending: last first
      record.rank = record.drop === 'step_completed' ? plan.steps.length - index : index
    }
    records.push(record)
  })
  return records
}

function stepRecords(state, plan, activeIndex, limits, { role, checkpoint, reason, budget, note }) {
  const records = [
    { key: 'restage', block: 'step', text: `restage: role=${role} checkpoint=${checkpoint}${reason ? ` reason=${oneLine(reason, limits.reasonChars)}` : ''}` },
  ]
  if (!plan) {
    records.push({ key: 'active_step', block: 'step', text: 'active_step: none (no committed plan)' })
  }
  else {
    const statuses = plan.steps.map((step, index) => `${index + 1}:${stepStatus(plan, step)}`).join(' ')
    records.push({ key: 'plan_status', block: 'step', text: `plan_status: ${plan.status}; steps ${statuses}` })
    const step = plan.steps[activeIndex]
    if (step) {
      const progress = plan.execution?.step_progress?.[step.step_id]
      const evidence = Array.isArray(progress?.accepted_evidence) ? progress.accepted_evidence.length : 0
      records.push({
        key: 'active_step',
        block: 'step',
        text: `active_step: ${activeIndex + 1} of ${plan.steps.length} ${step.step_id} | ${oneLine(step.description, limits.stepChars)} | batches=${progress?.batches_attempted ?? 0} accepted_for_close=${evidence}`,
      })
      const held = plan.execution?.receipts?.[step.step_id]
      const tail = (Array.isArray(held) ? held : []).slice(-limits.receiptTail)
      tail.forEach((entry, index) => {
        records.push({
          key: `receipt_${entry.seq ?? index}`,
          block: 'step',
          drop: 'receipt',
          rank: tail.length - index, // oldest drops first
          text: `receipt #${entry.seq ?? index + 1} ${entry.kind} ${entry.ref}: ${oneLine(entry.summary, 240)}`,
        })
      })
    }
    else {
      records.push({ key: 'active_step', block: 'step', text: 'active_step: none (all steps closed)' })
    }
  }
  const skills = skillIdsOf(state, plan)
  if (skills.length > 0) records.push({ key: 'skills', block: 'step', drop: 'skills', text: `loaded_skills: ${skills.join(', ')}` })
  const budgetLine = oneLine(budget, limits.budgetChars)
  if (budgetLine) records.push({ key: 'budget', block: 'step', drop: 'budget', text: `budget: ${budgetLine}` })
  const noteText = sanitizeHandoffNote(note, limits.noteChars)
  if (noteText) {
    records.push({ key: 'note', block: 'step', drop: 'note', text: `note (UNVERIFIED, written by the ending conversation; never the only source of state): ${noteText}` })
  }
  return records
}

// stableText: header + plan block, byte-identical for every context of one
// committed plan (cache prefix). volatileText: everything that moves with the
// step, the ledger, the budget or the note. text = stableText + '\n' + volatileText.
function render(records) {
  const plan = records.filter(record => record.block === 'plan').map(record => record.text)
  const step = records.filter(record => record.block === 'step').map(record => record.text)
  const stableText = [HEADER, '--- plan block (stable while this plan runs) ---', ...plan].join('\n')
  const volatileText = ['--- step block ---', ...step].join('\n')
  return { stableText, volatileText, text: `${stableText}\n${volatileText}` }
}

// The caller measures real limits from provider-reported tokens; this estimate
// is only for the packet's own size line and the first request before a reply.
export function estimateTokens(chars) {
  return Math.ceil(Math.max(0, chars) / 4)
}

/**
 * Build the handoff packet for a fresh conversation.
 *
 * @param {object} args
 * @param {object} args.planningState reducer state (`applyPlanningEvent` output)
 * @param {'planner'|'executor'} args.role role of the NEW conversation
 * @param {string} args.checkpoint one of CONTEXT_RESTAGE_CHECKPOINTS (C1..C8)
 * @param {string} [args.reason] short machine reason for the restage
 * @param {string} [args.note] optional annotation from the ending conversation
 * @param {number} [args.previousContextChars] size of the discarded context
 * @param {number} [args.now] timestamp for the event (never enters `text`)
 * @param {object} [args.limits] overrides for HANDOFF_PACKET_LIMITS
 * @param {string} [args.budget] optional budget line (harness-computed)
 */
export function buildHandoffPacket({ planningState, role, checkpoint, reason = '', note = '', budget = '', previousContextChars, now, limits: limitOverrides } = {}) {
  if (!CONTEXT_RESTAGE_ROLES.includes(role)) throw new RangeError(`handoff role must be one of ${CONTEXT_RESTAGE_ROLES.join(', ')}`)
  if (!CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint)) throw new RangeError(`handoff checkpoint must be one of ${CONTEXT_RESTAGE_CHECKPOINTS.join(', ')}`)
  if (!planningState?.goal?.goal_id) throw new RangeError('handoff packet needs a planning state with a goal')
  const limits = { ...HANDOFF_PACKET_LIMITS, ...limitOverrides }

  const plan = getActivePlan(planningState)
  const activeIndex = plan && Number.isInteger(plan.active_step_index) ? plan.active_step_index : -1
  const roadmap = roadmapRecord(planningState, plan)
  const records = [
    ...goalRecords(planningState, limits),
    ...(roadmap ? [roadmap] : []),
    ...planRecords(plan, activeIndex, limits),
    ...stepRecords(planningState, plan, activeIndex, limits, { role, checkpoint, reason, budget, note }),
  ]

  // Drop whole records, lowest priority first, until the packet fits.
  const dropped = []
  let kept = records
  let rendered = render(kept)
  const droppable = kept
    .filter(record => record.drop)
    .sort((left, right) => (HANDOFF_DROP_ORDER.indexOf(left.drop) - HANDOFF_DROP_ORDER.indexOf(right.drop))
      || ((right.rank ?? 0) - (left.rank ?? 0))
      || left.key.localeCompare(right.key))
  for (const record of droppable) {
    if (rendered.text.length <= limits.maxChars) break
    kept = kept.filter(item => item !== record)
    dropped.push(record.key)
    rendered = render(kept)
  }
  const { text, stableText, volatileText } = rendered

  const hash = sha256(text).slice(0, 16)
  const goalId = planningState.goal.goal_id
  const handoffId = `ho_${sha256(`${goalId}|${plan?.plan_id ?? ''}|${role}|${checkpoint}|${now ?? ''}|${hash}`).slice(0, 12)}`
  const event = buildContextRestagedEvent(planningState, {
    role,
    checkpoint,
    reason: oneLine(reason, limits.reasonChars),
    packetChars: text.length,
    previousContextChars,
    now,
  })
  return {
    text,
    stableText,
    volatileText,
    chars: text.length,
    estimated_tokens: estimateTokens(text.length),
    hash,
    handoff_id: handoffId,
    event,
    dropped,
    over_limit: text.length > limits.maxChars,
  }
}
