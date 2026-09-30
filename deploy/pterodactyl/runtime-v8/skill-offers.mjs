// Skill offers (plan item 2.8): the harness offers skill cards in the
// plan-authoring context without the model having to call findSkills.
//
// - The mod scores the skill library against the goal (tags derived from
//   outputs, topology entities and technology preconditions, plus a short
//   hand-set goal_tags list) and checks each need against the live world
//   (`autorio_skills.offer`): have, can_craft, locked (naming the technology)
//   or unknown. This module never scores skills itself.
// - Each card is rendered ONCE by `renderSkillCard`. The same text goes into
//   the Main LLM's [SKILL_OFFERS] block and into Jev's candidate criteria, so
//   Jev judges exactly what the model sees.
// - When: a complete search runs for a new goal and whenever the next shelved
//   goal is picked up into the active plan (shelf -> active plan boundary).
//   The block is shown only in plan-authoring and revision rounds, never in
//   rounds that carry out a committed step. No per-step re-offers.
// - Jev's `skill_choice` runs in SHADOW mode (owner, 2026-09-28): its pick is
//   traced but never reaches the prompt, and the call is not awaited, so it
//   adds no planning latency. The path is shadow -> advisory ->
//   part of the decision loop; flip SKILL_CHOICE_MODE, not a user setting.
// - Loading full details stays explicit through getSkillDetails.
//
// Seam for 2.8 (e), meaning-based scoring with a local embedding model: it
// belongs on the mod side next to the keyword score (see skills.ts), always
// falling back to keywords. Nothing here depends on LM Studio.

import { luaString } from '../staging/structured-policy.mjs'
import { getActivePlan, nearestShelfRefinementTarget, PLAN_STATUS } from './planning-state.mjs'

export const SKILL_OFFERS_PREFIX = '[SKILL_OFFERS]'
export const SKILL_OFFER_LIMIT = 5
export const SKILL_CARD_MAX_CHARS = 600
// The mod measures the goal in UTF-8 bytes (Lua strings are bytes).
export const SKILL_OFFER_MAX_GOAL_BYTES = 500
export const SKILL_CHOICE_MIN_CONFIDENCE = 0.6
export const SKILL_CHOICE_CONTRACT = 'skill_choice'
// 'shadow': trace Jev's pick only. 'advisory': also add one advisor line to
// the block. Owner decision 2026-09-28: shadow first.
export const SKILL_CHOICE_MODES = Object.freeze({ SHADOW: 'shadow', ADVISORY: 'advisory' })
export const SKILL_CHOICE_MODE = SKILL_CHOICE_MODES.SHADOW
export const SKILL_NEED_STATES = Object.freeze(['have', 'can_craft', 'locked', 'unknown'])
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,99}$/
const STATUSES = new Set(['observed', 'candidate', 'verified', 'deprecated'])

// Bounded single-line text, cut by code points so an emoji (a UTF-16
// surrogate pair) is never split.
function text(value, max) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const points = Array.from(clean)
  return points.length <= max ? clean : `${points.slice(0, max - 3).join('')}...`
}

// The longest prefix of `value` that fits in `maxBytes` UTF-8 bytes, cut on a
// code point boundary (never half a character).
export function utf8Prefix(value, maxBytes) {
  const clean = text(value, Number.MAX_SAFE_INTEGER)
  if (Buffer.byteLength(clean, 'utf8') <= maxBytes) return clean
  let bytes = 0
  let end = 0
  for (const character of clean) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return clean.slice(0, end)
}

function list(value, maxItems = 5, maxChars = 60) {
  if (!Array.isArray(value)) return []
  return value.map(entry => text(entry, maxChars)).filter(Boolean).slice(0, maxItems)
}

function name(value) {
  return typeof value === 'string' && NAME_PATTERN.test(value) ? value : undefined
}

function sanitizeNeed(raw) {
  if (typeof raw === 'string') return raw ? { subject: text(raw, 60), state: 'unknown' } : undefined
  if (!raw || typeof raw !== 'object') return undefined
  const subject = text(raw.subject, 60)
  if (!subject) return undefined
  const need = { subject, state: SKILL_NEED_STATES.includes(raw.state) ? raw.state : 'unknown' }
  const technology = name(raw.technology)
  const via = name(raw.via)
  if (technology && need.state === 'locked') need.technology = technology
  if (via && via !== subject) need.via = via
  return need
}

export function skillOfferCommand(goal, limit = SKILL_OFFER_LIMIT) {
  const request = JSON.stringify({ goal: utf8Prefix(goal, SKILL_OFFER_MAX_GOAL_BYTES), limit })
  return `/silent-command local request=helpers.json_to_table(${luaString(request)}); rcon.print(helpers.table_to_json(remote.call("autorio_skills","offer",request)))`
}

export function sanitizeSkillCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!SKILL_ID_PATTERN.test(id) || id.length > 80 || id === 'none') return undefined
  return {
    id,
    name: text(raw.name, 80) || id,
    status: STATUSES.has(raw.status) ? raw.status : 'candidate',
    summary: text(raw.summary, 170),
    produces: list(raw.produces),
    // table_to_json renders an empty Lua table as {}.
    needs: (Array.isArray(raw.needs) ? raw.needs : []).map(sanitizeNeed).filter(Boolean).slice(0, 5),
    matched: list(raw.matched),
    score: Number.isFinite(raw.score) ? Math.round(raw.score * 100) / 100 : 0,
  }
}

// { ok, cards } on success; { ok: false, reason, error? } otherwise.
export function parseSkillOffers(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw ?? '').trim()) }
  catch { return { ok: false, reason: 'lookup_unreadable' } }
  if (!parsed || typeof parsed !== 'object' || parsed.ok !== true) {
    return { ok: false, reason: 'lookup_failed', error: text(parsed?.error, 200) || undefined }
  }
  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : []
  const cards = []
  for (const card of rawCards) {
    const clean = sanitizeSkillCard(card)
    if (clean && !cards.some(existing => existing.id === clean.id)) cards.push(clean)
    if (cards.length >= SKILL_OFFER_LIMIT) break
  }
  return { ok: true, cards }
}

function renderNeed(need) {
  if (need.state === 'have') return `${need.subject} (have)`
  if (need.state === 'can_craft') return `${need.subject} (can craft${need.via ? ` ${need.via}` : ''})`
  if (need.state === 'locked') {
    const what = need.via ?? need.subject
    return need.technology
      ? `${need.subject} (locked: ${what === need.technology ? `needs research ${what}` : `${what} needs ${need.technology}`})`
      : `${need.subject} (locked)`
  }
  return need.subject
}

// The one card format, shared by the planner block and Jev's criteria.
export function renderSkillCard(card) {
  const parts = [
    `${card.id} "${card.name}" [${card.status}]: ${card.summary}`,
    `Produces: ${card.produces.join(', ') || 'none recorded'}.`,
    `Needs: ${card.needs.map(renderNeed).join(', ') || 'none recorded'}.`,
    `Matched: ${card.matched.join(', ') || 'text'}.`,
  ]
  return text(parts.join(' '), SKILL_CARD_MAX_CHARS)
}

export function needCounts(cards) {
  const counts = { have: 0, can_craft: 0, locked: 0, unknown: 0 }
  for (const card of cards) for (const need of card.needs) counts[need.state]++
  return counts
}

export function skillOfferBlock(offer) {
  if (!offer?.cards?.length) return ''
  const lines = [
    `${SKILL_OFFERS_PREFIX} Skills matched to this goal by the harness (tags and live needs), best first. Needs: have = held or already placed; can craft = recipe enabled; locked = research first. These are cards, not loaded skills: call getSkillDetails with an id before following one. Guidance only; revalidate live state. You may still use findSkills for a different sub-problem.`,
    ...offer.cards.map((card, index) => `${index + 1}. ${renderSkillCard(card)}`),
  ]
  if (SKILL_CHOICE_MODE === SKILL_CHOICE_MODES.ADVISORY && offer.advisor?.applied) {
    lines.push(`Advisor: Jev ranked ${offer.advisor.pick} first (confidence ${offer.advisor.confidence.toFixed(2)}). Advisory only.`)
  }
  return lines.join('\n')
}

export function skillChoiceQuestions(cards) {
  const criteria = {}
  for (const card of cards) criteria[card.id] = renderSkillCard(card)
  criteria.none = 'None of these skills fits the goal.'
  return {
    skill_choice: {
      type: 'choice',
      instructions: 'Judge from the goal text only. Which skill card is the best starting pattern for this goal? Each card lists what it produces, what it needs (have, can craft, or locked behind research), and which tags matched; locked needs are fine if the skill is still the right pattern to follow.',
      criteria,
    },
  }
}

// Jev's ranking over the offered ids, highest probability first.
export function parseSkillChoice(response, cards) {
  const answer = response?.answers?.skill_choice
  if (!answer || typeof answer.choice !== 'string') return undefined
  const ids = cards.map(card => card.id)
  if (answer.choice !== 'none' && !ids.includes(answer.choice)) return undefined
  const confidence = Number.isFinite(answer.confidence) ? Math.min(1, Math.max(0, answer.confidence)) : 0
  const probabilities = answer.probabilities && typeof answer.probabilities === 'object' ? answer.probabilities : {}
  const order = [...ids].sort((left, right) => (Number(probabilities[right]) || 0) - (Number(probabilities[left]) || 0)
    || ids.indexOf(left) - ids.indexOf(right))
  if (answer.choice !== 'none') {
    order.splice(order.indexOf(answer.choice), 1)
    order.unshift(answer.choice)
  }
  return { pick: answer.choice, confidence, order }
}

function planningGoal(loop, memoryKey) {
  const planning = loop.memory?.planningState?.(memoryKey)
  return planning?.goal?.status === 'active' ? planning : undefined
}

function jevFailureOutcome(error, controller) {
  if (controller.signal.aborted) return 'aborted'
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout/i.test(message)) return 'timeout'
  if (/abort|cancel/i.test(message)) return 'aborted'
  return 'error'
}

// Aborts the in-flight Jev skill_choice call, if any. Hooked into loop
// cancel/stop; a newer search calls it too.
export function abortSkillChoice(loop, reason = 'cancelled') {
  const controller = loop?.skillChoiceAbort
  if (!controller) return
  loop.skillChoiceAbort = null
  controller.abort(new Error(`skill_choice cancelled: ${reason}`))
}

// One Jev skill_choice call over the offer's cards. Resolves to nothing and
// never rejects: every outcome is traced as skill.ranked. The result is kept
// only when the offer is still the current one for the same actor epoch; a
// late answer for a replaced offer or a replaced actor is traced and dropped.
async function runSkillChoice(loop, offer, trigger, base) {
  let controller
  try {
    const questions = skillChoiceQuestions(offer.cards)
    const decisionId = `decision_${Date.now().toString(36)}_skill_${(++loop.decisionRequestSequence).toString(36)}`
    const state = { contract: SKILL_CHOICE_CONTRACT, goal: offer.goal, trigger, candidate_count: offer.cards.length }
    // A newer search aborts the older Jev call.
    abortSkillChoice(loop, 'superseded_by_newer_offer')
    controller = new AbortController()
    loop.skillChoiceAbort = controller
    const epoch = { epoch: loop.epoch?.epoch, actor_id: loop.epoch?.actor_id }
    const correlation = { decision_id: decisionId, offer_seq: offer.seq, offer_request_id: offer.request_id }
    const shadow = SKILL_CHOICE_MODE === SKILL_CHOICE_MODES.SHADOW
    await loop.decisionTraceEvent('decision.request', {
      decision_id: decisionId,
      contract: SKILL_CHOICE_CONTRACT,
      mode: SKILL_CHOICE_MODE,
      shadow,
      question_ids: Object.keys(questions),
    })
    const startedAt = Date.now()
    const failed = async (outcome, reason) => {
      await loop.decisionTraceEvent('decision.fallback', {
        decision_id: decisionId,
        contract: SKILL_CHOICE_CONTRACT,
        reason,
        fallback: 'deterministic_skill_order',
        shadow,
      })
      await loop.traceEvent('skill.ranked', {
        ...base,
        ...correlation,
        source: 'deterministic',
        outcome,
        reason: outcome === 'error' ? 'jev_error' : `jev_${outcome}`,
        error: reason,
        latency_ms: Date.now() - startedAt,
      })
    }
    let response
    try {
      response = await loop.skillDecisionProvider(state, questions, { epoch: epoch.epoch, actorId: epoch.actor_id, signal: controller.signal, decisionId })
    }
    catch (error) {
      await failed(jevFailureOutcome(error, controller), text(error instanceof Error ? error.message : String(error), 300))
      return
    }
    // A late answer: the call was aborted, the offer was replaced, or the actor changed.
    const stale = controller.signal.aborted
      ? text(controller.signal.reason instanceof Error ? controller.signal.reason.message : String(controller.signal.reason ?? 'skill_choice cancelled'), 200)
      : loop.skillOffers !== offer
        ? 'skill_choice cancelled: superseded_by_newer_offer'
        // The offer can be made before the request captures its epoch; only
        // a known epoch that later changed counts as a replaced actor.
        : (epoch.epoch !== undefined && (loop.epoch?.epoch !== epoch.epoch || loop.epoch?.actor_id !== epoch.actor_id))
            ? 'skill_choice cancelled: actor epoch changed'
            : ''
    if (stale) {
      await failed('aborted', stale)
      return
    }
    const choice = parseSkillChoice(response, offer.cards)
    if (!choice) {
      await failed('error', 'skill_choice answer missing or not one of the offered ids')
      return
    }
    const latency = Date.now() - startedAt
    await loop.decisionTraceEvent('decision.response', {
      decision_id: decisionId,
      contract: SKILL_CHOICE_CONTRACT,
      mode: SKILL_CHOICE_MODE,
      pick: choice.pick,
      confidence: choice.confidence,
      latency_ms: latency,
      shadow,
    })
    const confident = choice.pick !== 'none' && choice.confidence >= SKILL_CHOICE_MIN_CONFIDENCE
    const applied = confident && SKILL_CHOICE_MODE === SKILL_CHOICE_MODES.ADVISORY
    offer.jev = { pick: choice.pick, confidence: choice.confidence, order: choice.order }
    offer.advisor = applied ? { applied: true, pick: choice.pick, confidence: choice.confidence } : null
    // U11: the pick goes through the judgment ledger so it is scored against what the fresh agent then loads.
    await loop.jev?.recordSkillOrder({ offer, choice, deterministicOrder: base.deterministic_order, latencyMs: latency })
    await loop.traceEvent('skill.ranked', {
      ...base,
      ...correlation,
      source: 'jev',
      outcome: 'ranked',
      reason: confident ? 'jev_confident_pick' : choice.pick === 'none' ? 'jev_none_fits' : 'jev_low_confidence',
      jev_order: choice.order,
      jev_pick: choice.pick,
      confidence: choice.confidence,
      agrees_with_top: choice.pick === base.deterministic_order[0],
      prompt_applied: applied,
      latency_ms: latency,
    })
  }
  catch (error) {
    loop.log?.(`[skills] skill_choice failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  finally {
    if (controller && loop.skillChoiceAbort === controller) loop.skillChoiceAbort = null
  }
}

// Shadow mode: nothing uses Jev's answer, so the call starts and the planner
// goes on without waiting (plan 2.10, responsiveness). Advisory mode awaits,
// because its answer would go into the prompt.
async function rankWithJev(loop, offer, trigger) {
  const base = { trigger, deterministic_order: offer.cards.map(card => card.id), mode: SKILL_CHOICE_MODE }
  if (typeof loop.skillDecisionProvider !== 'function') {
    await loop.traceEvent('skill.ranked', { ...base, offer_seq: offer.seq, source: 'deterministic', outcome: 'skipped', reason: 'jev_unavailable' })
    return
  }
  const job = runSkillChoice(loop, offer, trigger, base)
  loop.skillChoicePending = job
  if (SKILL_CHOICE_MODE === SKILL_CHOICE_MODES.ADVISORY) await job
}

// One complete search: ask the mod, keep the cards, trace, then Jev's shadow
// pick. Never throws; a failure leaves no offer and says why.
async function searchSkills(loop, { memoryKey, goal, trigger, intent }) {
  abortSkillChoice(loop, 'superseded_by_newer_search')
  const query = utf8Prefix(goal, SKILL_OFFER_MAX_GOAL_BYTES)
  if (!query) {
    loop.skillOffers = null
    await loop.traceEvent('skill.offer_skipped', { trigger, reason: 'no_goal_text', intent })
    return null
  }
  let raw
  try { raw = await loop.rcon.command(skillOfferCommand(query)) }
  catch (error) {
    loop.skillOffers = null
    await loop.traceEvent('skill.offer_skipped', { trigger, reason: 'lookup_failed', intent, error: text(error instanceof Error ? error.message : String(error), 200) })
    return null
  }
  const parsed = parseSkillOffers(raw)
  if (!parsed.ok || parsed.cards.length === 0) {
    loop.skillOffers = null
    await loop.traceEvent('skill.offer_skipped', {
      trigger,
      reason: parsed.ok ? 'no_matching_skill' : parsed.reason,
      intent,
      ...(parsed.error ? { error: parsed.error } : {}),
    })
    return null
  }
  loop.skillOfferSequence = (loop.skillOfferSequence ?? 0) + 1
  const offer = { seq: loop.skillOfferSequence, request_id: loop.traceRequest?.id, memoryKey, goal: query, trigger, cards: parsed.cards, advisor: null, jev: null, authoring: true }
  loop.skillOffers = offer
  loop.lastFollowedSkillKey = null
  await loop.traceEvent('skill.offered', {
    offer_seq: offer.seq,
    trigger,
    reason: trigger,
    intent,
    offered_ids: offer.cards.map(card => card.id),
    need_counts: needCounts(offer.cards),
    cards: offer.cards.map(card => ({
      id: card.id,
      status: card.status,
      score: card.score,
      matched: card.matched,
      need_counts: needCounts([card]),
      locked: card.needs.filter(need => need.state === 'locked').map(need => ({ subject: need.subject, technology: need.technology })),
    })),
  })
  await rankWithJev(loop, offer, trigger)
  return offer
}

function isRevisionRound(loop, memoryKey, intent) {
  if (intent === 'amend_current') return true
  const planning = loop.memory?.planningState?.(memoryKey)
  const plan = planning ? getActivePlan(planning) : undefined
  return plan?.status === PLAN_STATUS.BLOCKED && plan.blocker?.user_choice?.choice === 'revise'
}

// One-line hook at the start of a planning request. A new goal runs a complete
// search. A revision round (amendment, or a blocked plan the user chose to
// revise) shows the goal's cards again, searching if there are none. Any other
// request leaves offers alone. Never throws.
export async function ensureSkillOffers(loop, { memoryKey, intent, text: requestText }) {
  try {
    if (intent === 'new_goal') {
      return await searchSkills(loop, { memoryKey, goal: requestText, trigger: 'new_goal', intent })
    }
    if (!isRevisionRound(loop, memoryKey, intent)) return loop.skillOffers ?? null
    const current = loop.skillOffers
    if (current?.memoryKey === memoryKey) {
      current.authoring = true
      await loop.traceEvent('skill.offer_reshown', { trigger: 'revision', reason: 'revision_round', intent, offered_ids: current.cards.map(card => card.id) })
      return current
    }
    const objective = planningGoal(loop, memoryKey)?.goal?.objective ?? requestText
    return await searchSkills(loop, { memoryKey, goal: objective, trigger: 'revision', intent })
  }
  catch (error) {
    loop.log?.(`[skills] offer failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// One-line hook at the LOD shelf -> active plan boundary (a verified plan
// slice completed and the planner is woken to refine the next shelf node).
// Runs a complete search for that node. Never throws.
export async function refreshSkillOffersAtShelfPickup(loop, planning) {
  try {
    const memoryKey = loop.activePlanKey()
    const node = nearestShelfRefinementTarget(planning)
    const goal = node
      ? [node.intent, node.why_it_matters].filter(value => typeof value === 'string' && value).join('. ')
      : planning?.goal?.objective
    const offer = await searchSkills(loop, { memoryKey, goal, trigger: 'shelf_pickup', intent: 'shelf_pickup' })
    if (offer && node?.node_id) offer.shelf_node_id = node.node_id
    return offer
  }
  catch (error) {
    loop.log?.(`[skills] shelf pickup offer failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

// The block, only while the planner is authoring or revising a plan.
export function skillOffersContext(loop) {
  const offer = loop.skillOffers
  if (!offer || !offer.authoring || offer.memoryKey !== loop.activePlanKey?.()) return ''
  return skillOfferBlock(offer)
}

// Characters the harness injects as skill text (offers plus loaded skill
// context), so the working-context ceiling can count them.
export function injectedSkillChars(loop) {
  const offers = skillOffersContext(loop)
  const loaded = typeof loop.skillContext === 'function' ? loop.skillContext() : ''
  return offers.length + loaded.length
}

function offerRank(loop, id) {
  const index = loop.skillOffers?.cards?.findIndex(card => card.id === id) ?? -1
  return index >= 0 ? index + 1 : undefined
}

export async function traceSkillLoaded(loop, skill) {
  if (!skill?.id) return
  const rank = offerRank(loop, skill.id)
  await loop.traceEvent('skill.loaded', {
    skill_id: skill.id,
    revision: skill.revision,
    offered: rank !== undefined,
    offer_rank: rank,
    reason: rank !== undefined ? 'loaded_offered_skill' : 'loaded_unoffered_skill',
  })
}

// Hook in commitPlan. A committed plan ends the authoring round, so the block
// leaves the prompt for the rounds that carry out its steps. "Followed" is the
// harness's evidence, not the model's claim: a plan was committed while these
// skills were loaded into [SKILL_CONTEXT]. Emitted once per distinct loaded set
// per offer.
export async function traceSkillsFollowed(loop, plan) {
  const loaded = loop.loadedSkillContext instanceof Map ? [...loop.loadedSkillContext.keys()] : []
  if (loop.skillOffers?.authoring && Array.isArray(plan?.plan) && plan.plan.length > 0) {
    loop.skillOffers.authoring = false
    // What the fresh agent had loaded when it committed: a late Jev answer is still scored against it (U11).
    loop.skillOffers.retired_loaded = loaded
    await loop.traceEvent('skill.offer_retired', { reason: 'plan_committed', trigger: loop.skillOffers.trigger })
    await loop.jev?.scoreSkillOrderAtCommit({ offer: loop.skillOffers, loaded })
  }
  if (loaded.length === 0) return
  const key = loaded.slice().sort().join(',')
  if (loop.lastFollowedSkillKey === key) return
  loop.lastFollowedSkillKey = key
  const planText = JSON.stringify([plan?.chatMessage, plan?.plan]).toLowerCase()
  await loop.traceEvent('skill.followed', {
    skill_ids: loaded,
    offered_ids: loaded.filter(id => offerRank(loop, id) !== undefined),
    mentioned_in_plan: loaded.filter(id => planText.includes(id)),
    reason: 'plan_committed_with_skill_context',
  })
}
