// Skill offers (plan item 2.8): the harness offers skill cards in the
// plan-authoring context without the model having to call findSkills.
//
// - The mod scores the skill library against the goal (tags derived from
//   outputs, topology entities and technology preconditions, plus a short
//   hand-set goal_tags list) and checks preconditions against the live world
//   (`autorio_skills.offer`). This module never scores skills itself.
// - Each card is rendered ONCE by `renderSkillCard`. The same text goes into
//   the Main LLM's [SKILL_OFFERS] block and into Jev's candidate criteria, so
//   Jev ranks exactly what the model sees.
// - Jev's ranking is advisory: the card order stays deterministic, and a
//   confident Jev pick adds one "advisor" line. No Jev key, a Jev error or a
//   low-confidence answer leaves the deterministic order alone. Every outcome
//   is traced.
// - Loading full details stays explicit through getSkillDetails.
//
// Seam for 2.8 (e), meaning-based scoring with a local embedding model: it
// belongs on the mod side next to the keyword score (see skills.ts), always
// falling back to keywords. Nothing here depends on LM Studio.

import { luaString } from '../staging/structured-policy.mjs'

export const SKILL_OFFERS_PREFIX = '[SKILL_OFFERS]'
export const SKILL_OFFER_LIMIT = 5
export const SKILL_CARD_MAX_CHARS = 520
export const SKILL_OFFER_MAX_GOAL_CHARS = 500
export const SKILL_CHOICE_MIN_CONFIDENCE = 0.6
export const SKILL_CHOICE_CONTRACT = 'skill_choice'
const SKILL_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const STATUSES = new Set(['observed', 'candidate', 'verified', 'deprecated'])

function text(value, max) {
  if (typeof value !== 'string') return ''
  const clean = value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`
}

function list(value, maxItems = 5, maxChars = 60) {
  if (!Array.isArray(value)) return []
  return value.map(entry => text(entry, maxChars)).filter(Boolean).slice(0, maxItems)
}

export function skillOfferCommand(goal, limit = SKILL_OFFER_LIMIT) {
  const request = JSON.stringify({ goal: text(goal, SKILL_OFFER_MAX_GOAL_CHARS), limit })
  return `/silent-command local request=helpers.json_to_table(${luaString(request)}); rcon.print(helpers.table_to_json(remote.call("autorio_skills","offer",request)))`
}

export function sanitizeSkillCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const id = typeof raw.id === 'string' ? raw.id : ''
  if (!SKILL_ID_PATTERN.test(id) || id.length > 80) return undefined
  return {
    id,
    name: text(raw.name, 80) || id,
    status: STATUSES.has(raw.status) ? raw.status : 'candidate',
    summary: text(raw.summary, 170),
    produces: list(raw.produces),
    needs: list(raw.needs),
    matched: list(raw.matched),
    unmet: list(raw.unmet),
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
  // table_to_json renders an empty Lua table as {} or [].
  const rawCards = Array.isArray(parsed.cards) ? parsed.cards : []
  const cards = []
  for (const card of rawCards) {
    const clean = sanitizeSkillCard(card)
    if (clean && !cards.some(existing => existing.id === clean.id)) cards.push(clean)
    if (cards.length >= SKILL_OFFER_LIMIT) break
  }
  return { ok: true, cards }
}

// The one card format, shared by the planner block and Jev's criteria.
export function renderSkillCard(card) {
  const why = []
  if (card.matched.length > 0) why.push(`matched ${card.matched.join(', ')}`)
  if (card.unmet.length > 0) why.push(`unmet ${card.unmet.join(', ')}`)
  const parts = [
    `${card.id} "${card.name}" [${card.status}]: ${card.summary}`,
    `Produces: ${card.produces.join(', ') || 'none recorded'}.`,
    `Needs: ${card.needs.join(', ') || 'none recorded'}.`,
    `Why: ${why.join('; ') || 'text match'}.`,
  ]
  return text(parts.join(' '), SKILL_CARD_MAX_CHARS)
}

export function skillOfferBlock(offer) {
  if (!offer?.cards?.length) return ''
  const lines = [
    `${SKILL_OFFERS_PREFIX} Skills matched to this goal by the harness (tags and live preconditions), best first. These are cards, not loaded skills: call getSkillDetails with an id before following one. Guidance only; revalidate live state. You may still use findSkills for a different sub-problem.`,
    ...offer.cards.map((card, index) => `${index + 1}. ${renderSkillCard(card)}`),
  ]
  if (offer.advisor?.applied) {
    lines.push(`Advisor: Jev ranked ${offer.advisor.pick} first (confidence ${offer.advisor.confidence.toFixed(2)}). Advisory only.`)
  }
  return lines.join('\n')
}

export function skillChoiceQuestions(cards) {
  const criteria = {}
  for (const card of cards) if (card.id !== 'none') criteria[card.id] = renderSkillCard(card)
  criteria.none = 'None of these skills fits the goal.'
  return {
    skill_choice: {
      type: 'choice',
      instructions: 'Judge from the goal text only. Which skill card is the best starting pattern for this goal? Each card lists what it produces, what it needs, and why the harness matched it; unmet needs are fine if the skill is still the right pattern to follow.',
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

function goalObjective(loop, memoryKey) {
  const planning = loop.memory?.planningState?.(memoryKey)
  if (planning?.goal?.status === 'active' && typeof planning.goal.objective === 'string') return planning.goal.objective
  const legacy = loop.memory?.currentPlan?.(memoryKey)
  if (legacy?.status === 'active' && typeof legacy.objective === 'string') return legacy.objective
  return ''
}

async function rankWithJev(loop, offer, goal) {
  const deterministic = offer.cards.map(card => card.id)
  const base = { deterministic_order: deterministic, mode: 'advisory' }
  if (typeof loop.skillDecisionProvider !== 'function') {
    await loop.traceEvent('skill.ranked', { ...base, source: 'deterministic', reason: 'jev_unavailable' })
    return
  }
  const questions = skillChoiceQuestions(offer.cards)
  const decisionId = `decision_${Date.now().toString(36)}_skill_${(++loop.decisionRequestSequence).toString(36)}`
  const state = {
    contract: SKILL_CHOICE_CONTRACT,
    goal: text(goal, SKILL_OFFER_MAX_GOAL_CHARS),
    candidate_count: offer.cards.length,
  }
  await loop.decisionTraceEvent('decision.request', {
    decision_id: decisionId,
    contract: SKILL_CHOICE_CONTRACT,
    mode: 'advisory',
    question_ids: Object.keys(questions),
  })
  const startedAt = Date.now()
  let choice
  try {
    const response = await loop.skillDecisionProvider(state, questions, {
      epoch: loop.epoch?.epoch,
      actorId: loop.epoch?.actor_id,
    })
    choice = parseSkillChoice(response, offer.cards)
    if (!choice) throw new Error('skill_choice answer missing or not one of the offered ids')
    await loop.decisionTraceEvent('decision.response', {
      decision_id: decisionId,
      contract: SKILL_CHOICE_CONTRACT,
      mode: 'advisory',
      pick: choice.pick,
      confidence: choice.confidence,
      latency_ms: Date.now() - startedAt,
    })
  }
  catch (error) {
    const reason = text(error instanceof Error ? error.message : String(error), 300)
    await loop.decisionTraceEvent('decision.fallback', {
      decision_id: decisionId,
      contract: SKILL_CHOICE_CONTRACT,
      reason,
      fallback: 'deterministic_skill_order',
    })
    await loop.traceEvent('skill.ranked', { ...base, source: 'deterministic', reason: 'jev_error', decision_id: decisionId, error: reason })
    return
  }
  const confident = choice.pick !== 'none' && choice.confidence >= SKILL_CHOICE_MIN_CONFIDENCE
  // Advisory only when Jev is confident and disagrees with nothing it could
  // not see: it can only pick among the offered cards.
  offer.advisor = confident ? { applied: true, pick: choice.pick, confidence: choice.confidence } : null
  await loop.traceEvent('skill.ranked', {
    ...base,
    source: 'jev',
    reason: confident ? 'jev_confident_pick' : choice.pick === 'none' ? 'jev_none_fits' : 'jev_low_confidence',
    decision_id: decisionId,
    jev_order: choice.order,
    jev_pick: choice.pick,
    confidence: choice.confidence,
    agrees_with_top: choice.pick === deterministic[0],
    advisory_applied: confident,
  })
}

// One-line hook at the start of a planning request. A new goal always gets a
// fresh offer; any other planning request keeps the goal's offer, or builds
// one for the active goal when none exists (after a restart). Never throws.
export async function ensureSkillOffers(loop, { memoryKey, intent, text: requestText }) {
  try {
    const current = loop.skillOffers
    if (intent !== 'new_goal' && current?.memoryKey === memoryKey) return current
    const goal = intent === 'new_goal' ? requestText : goalObjective(loop, memoryKey)
    const reason = intent === 'new_goal' ? 'new_goal' : 'active_goal_without_offer'
    if (!text(goal, SKILL_OFFER_MAX_GOAL_CHARS)) {
      loop.skillOffers = null
      await loop.traceEvent('skill.offer_skipped', { reason: 'no_goal_text', intent })
      return null
    }
    let raw
    try { raw = await loop.rcon.command(skillOfferCommand(goal)) }
    catch (error) {
      loop.skillOffers = null
      await loop.traceEvent('skill.offer_skipped', { reason: 'lookup_failed', intent, error: text(error instanceof Error ? error.message : String(error), 200) })
      return null
    }
    const parsed = parseSkillOffers(raw)
    if (!parsed.ok || parsed.cards.length === 0) {
      loop.skillOffers = null
      await loop.traceEvent('skill.offer_skipped', {
        reason: parsed.ok ? 'no_matching_skill' : parsed.reason,
        intent,
        ...(parsed.error ? { error: parsed.error } : {}),
      })
      return null
    }
    const offer = { memoryKey, goal: text(goal, SKILL_OFFER_MAX_GOAL_CHARS), cards: parsed.cards, advisor: null }
    loop.skillOffers = offer
    loop.lastFollowedSkillKey = null
    await loop.traceEvent('skill.offered', {
      reason,
      intent,
      offered_ids: offer.cards.map(card => card.id),
      cards: offer.cards.map(card => ({ id: card.id, status: card.status, score: card.score, matched: card.matched, unmet: card.unmet })),
    })
    await rankWithJev(loop, offer, goal)
    return offer
  }
  catch (error) {
    loop.log?.(`[skills] offer failed: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}

export function skillOffersContext(loop) {
  const offer = loop.skillOffers
  if (!offer || offer.memoryKey !== loop.activePlanKey?.()) return ''
  return skillOfferBlock(offer)
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

// "Followed" is the harness's evidence, not the model's claim: a plan was
// committed while these skills were loaded into [SKILL_CONTEXT]. Emitted once
// per distinct loaded set per goal offer.
export async function traceSkillsFollowed(loop, plan) {
  const loaded = loop.loadedSkillContext instanceof Map ? [...loop.loadedSkillContext.keys()] : []
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
