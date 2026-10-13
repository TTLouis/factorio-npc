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
// Executor facts (repair unit D2): a fresh executor conversation has none of the planner's earlier reads, so an
// executor restage can carry a bounded, labelled record of what the harness itself read from the live game
// (`executorFacts`): stable recipe facts, held counts (fresh, or stale with the tick they date from), the machine
// the step checkpoint names, a residual-needs derivation from those facts, and historical entity observations
// with exact ids withheld. Labels and fields only; nothing here is advice and no game rule is baked in.
//
// Wired: the C5 budget handoff and the C7 recovery restage (U8), the planner slice-close
// restage at C1/C2 (U7) and the executor's C3, C6 and C8 restages (U6) build one through
// NpcAgentLoop.buildRestagePacket.

import { createHash } from 'node:crypto'

import { sanitizeDurableModelText } from './durable-text.mjs'
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
  shelfCandidates: 5,
  candidateChars: 260,
  contractChars: 300,
  runtimeChars: 200,
  amendmentChars: 500,
  // U11 advisory: what Jev's observation families may ADD. Bounded by count and length, and the first records dropped
  // when the packet is over its limit (they are never mandatory).
  jevFacts: 4,
  jevFactChars: 300,
})

// Drop order when over the limit: first entry is dropped first. Receipts go
// oldest first inside their group. Steps drop completed (earliest first) before
// pending (last first). Anything not listed is mandatory.
export const HANDOFF_DROP_ORDER = Object.freeze([
  'jev_facts',
  'note',
  'historical_entities',
  'fluid_source_hints',
  'receipt',
  'skills',
  'runtime',
  'budget',
  'shelf_candidates',
  'recipe_facts',
  'stale_counts',
  'contract',
  'fresh_counts',
  'residual_needs',
  'raw_leaf_acquisition',
  'roadmap_node',
  'step_completed',
  'step_pending',
])

// Executor-facts bounds (repair unit D2). Kept apart from HANDOFF_PACKET_LIMITS: a packet without facts is unchanged.
export const EXECUTOR_FACT_LIMITS = Object.freeze({
  recipes: 5,
  recipeChars: 340,
  recipeIngredients: 8,
  recipeProducts: 4,
  recipeMachines: 6,
  countItems: 12,
  countChars: 360,
  machineChars: 480,
  residualRows: 10,
  residualChars: 520,
  acquisitionChars: 900,
  historicalKinds: 6,
  historicalChars: 280,
  authorityChars: 320,
  cachedRecipes: 32,
  researchTargets: 4,
  researchNodes: 8,
  researchChars: 1600,
  // Historical native fluid-tile anchors (unit 3a): bounded count, rendered length, stored length and accepted answer size.
  fluidHints: 16,
  fluidHintChars: 1200,
  fluidHintStoreChars: 4000,
  fluidReadChars: 4096,
  // Unit 3b: recipe reads the harness may spend on one handoff to close a step root's recipe chain.
  recipePrefetchReads: 8,
  noRecipeItems: 32,
  // Unit 6: raw leaves (items a resource prototype mines) are remembered with their mining sources, and the harness reads the
  // nearest instance of at most `rawLeafResources` distinct resources per handoff, within `rawLeafRadius` tiles.
  rawLeafResources: 3,
  rawLeafRadius: 1024,
  rawLeafMinedFrom: 4,
})

const HEADER = '[HANDOFF] Rebuilt from durable harness state, not from the previous conversation. Verify against the world before acting.'

function oneLine(value, max) {
  const flat = String(value ?? '').replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

// The note is the ending conversation's own prose. It goes through the same
// durable-text sanitizer as the agent loop's memory (historical unit numbers
// must not steer a fresh conversation to stale entities), after the packet's
// one-line/control-character normalization.
export function sanitizeHandoffNote(value, max = HANDOFF_PACKET_LIMITS.noteChars) {
  return sanitizeDurableModelText(oneLine(value, Math.max(2000, String(value ?? '').length)), max)
}

// A user amendment staged for the planner (not yet applied). It is the USER's wording, bounded
// and sanitized like every other text that can carry entity identities.
export function sanitizeAmendmentText(value, max = HANDOFF_PACKET_LIMITS.amendmentChars) {
  return sanitizeDurableModelText(oneLine(value, Math.max(2000, String(value ?? '').length)), max)
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

// Shelf candidates (a C1/C2 restage of the planner): the nodes the planner may
// refine next, from shelfRefinementCandidates. Intent and lineage only, never
// operations. Last candidate drops first.
function shelfCandidateRecords(candidates, limits) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, limits.shelfCandidates)
  return list.map((candidate, index) => {
    const parts = [`${candidate.node_id} [${candidate.status}]: ${oneLine(candidate.intent, 200)}`]
    if (candidate.why_it_matters) parts.push(`why: ${oneLine(candidate.why_it_matters, 120)}`)
    if (Array.isArray(candidate.depends_on) && candidate.depends_on.length > 0) parts.push(`depends_on: ${candidate.depends_on.join(',')}`)
    if (Array.isArray(candidate.verified_results) && candidate.verified_results.length > 0) parts.push(`verified: ${candidate.verified_results.slice(0, 3).join(',')}`)
    return {
      key: `shelf_candidate_${index}`,
      block: 'step',
      drop: 'shelf_candidates',
      rank: index,
      text: `shelf_candidate ${index + 1}: ${oneLine(parts.join(' | '), limits.candidateChars)}`,
    }
  })
}

// Whitelisted scalar fields only: a snapshot object from the runtime (deployment
// status, task status) never dumps whole into the packet, and no entity unit
// number can ride in through it.
function scalarLine(source, keys, max) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return ''
  const parts = []
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value) parts.push(`${key}=${oneLine(value, 60)}`)
    else if (typeof value === 'number' && Number.isFinite(value)) parts.push(`${key}=${value}`)
    else if (typeof value === 'boolean') parts.push(`${key}=${value}`)
  }
  return oneLine(parts.join(' '), max)
}

const ACTOR_KEYS = Object.freeze(['actor_id', 'actor_kind', 'epoch', 'connected_players'])
const RUNTIME_KEYS = Object.freeze(['task_state', 'queue_length', 'idle'])

// The active step's completion contract, described without any entity identity
// (a historical unit number must never steer a fresh conversation).
function contractText(step, max) {
  const contract = step?.completion_contract
  if (!contract || !Array.isArray(contract.requirements) || contract.requirements.length === 0) return ''
  const parts = contract.requirements.map((requirement) => {
    const subject = requirement.item_name ?? requirement.entity_name ?? requirement.operation_name ?? ''
    const minimum = Number.isFinite(requirement.minimum) ? `>=${requirement.minimum}` : ''
    return `${requirement.kind}${subject ? ` ${subject}` : ''}${minimum}`
  })
  return oneLine(`${contract.mode}: ${parts.join('; ')}`, max)
}

// Jev's advisory additions (U11): deterministic facts the harness read for the families Jev selected, and one hint
// line naming families that have no parameterless fact read. They only ADD; nothing mandatory is replaced or
// removed, and they are the first records dropped when the packet is over its size limit.
function jevFactRecords(jevFacts, jevHints, limits) {
  const records = []
  const facts = (Array.isArray(jevFacts) ? jevFacts : []).filter(fact => fact && typeof fact.family === 'string' && typeof fact.text === 'string' && fact.text).slice(0, limits.jevFacts)
  facts.forEach((fact, index) => {
    records.push({
      key: `jev_fact_${index}`,
      block: 'step',
      drop: 'jev_facts',
      rank: index,
      text: `jev_fact[${oneLine(fact.family, 40)}] (harness read at this restage, selected by Jev; advisory, verify before acting): ${oneLine(sanitizeDurableModelText(fact.text, limits.jevFactChars), limits.jevFactChars)}`,
    })
  })
  const hints = (Array.isArray(jevHints) ? jevHints : []).filter(family => typeof family === 'string' && family).slice(0, limits.jevFacts)
  if (hints.length > 0) {
    records.push({
      key: 'jev_fact_hint',
      block: 'step',
      drop: 'jev_facts',
      rank: -1,
      text: `jev_fact_hint (Jev, advisory): lookups likely useful here: ${oneLine(hints.join(', '), limits.jevFactChars)}`,
    })
  }
  return records
}

// --- executor facts (repair unit D2) --------------------------------------------------------------------------------
//
// Everything below is a pure function of facts the harness read from the live game (recipe tool results, the
// requirements answer, requires_machine preflight facts, fresh count and machine reads). Nothing is hard-coded about
// which recipe makes what: the derivation only reads the amounts those facts carry.

const FACT_NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/

function factName(value) {
  return typeof value === 'string' && FACT_NAME.test(value) ? value : undefined
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asList(value) {
  return Array.isArray(value) ? value : []
}

// Where and when a fact came from: the game tick when the harness knew one, the actor epoch and the wall clock.
export function normalizeFactTag(tag) {
  const out = {}
  if (Number.isSafeInteger(tag?.tick)) out.tick = tag.tick
  if (Number.isSafeInteger(tag?.epoch)) out.epoch = tag.epoch
  if (Number.isSafeInteger(tag?.actor_id)) out.actor_id = tag.actor_id
  if (finiteNumber(tag?.at_ms) !== undefined) out.at_ms = tag.at_ms
  return out
}

function tagText(tag) {
  const parts = []
  if (Number.isSafeInteger(tag?.tick)) parts.push(`tick:${tag.tick}`)
  if (Number.isSafeInteger(tag?.epoch)) parts.push(`epoch:${tag.epoch}`)
  return parts.length > 0 ? parts.join(',') : 'unknown'
}

function normalizeIngredient(raw) {
  const name = factName(raw?.name)
  if (!name) return undefined
  const amount = finiteNumber(raw.amount)
  return { type: raw.type === 'fluid' ? 'fluid' : 'item', name, ...(amount !== undefined ? { amount } : {}) }
}

function normalizeProduct(raw) {
  const name = factName(raw?.name)
  if (!name) return undefined
  const product = { type: raw.type === 'fluid' ? 'fluid' : 'item', name }
  for (const key of ['amount', 'amount_min', 'amount_max']) {
    const value = finiteNumber(raw[key])
    if (value !== undefined) product[key] = value
  }
  const probability = finiteNumber(raw.probability ?? raw.independent_probability)
  if (probability !== undefined) product.probability = probability
  return product
}

/**
 * One recipe fact, bounded and name-checked. `raw` is a recipe entry as the live game reported it (getRecipeDetails
 * `recipes[]`, or the requires_machine facts' recipe plus its machine names). `complete` is false when anything was
 * cut or unreadable: an incomplete recipe is shown but never used to derive quantities.
 */
export function recipeApplicability(raw) {
  const reasons = {
    available: ['no_surface_conditions', 'surface_conditions_satisfied', 'surface_conditions_ignored'],
    unavailable: ['surface_condition_mismatch'],
    unknown: ['recipe_prototype_unavailable', 'actor_surface_unavailable', 'surface_property_unavailable'],
  }
  const state = raw?.state
  const surface = Number.isSafeInteger(raw?.surface_index) && raw.surface_index > 0 ? raw.surface_index : undefined
  const unbound = state === 'available' && raw?.reason === 'no_surface_conditions' && raw?.surface_bound === false
  if (!reasons[state]?.includes(raw?.reason) || (!unbound && raw?.surface_bound !== true)
    || (state !== 'unknown' && !unbound && surface === undefined)) {
    return { state: 'unknown', reason: 'applicability_not_reported', surface_bound: true }
  }
  return { state, reason: raw.reason, surface_bound: !unbound, ...(surface !== undefined ? { surface_index: surface } : {}) }
}

export function normalizeRecipeFact(raw, { source = 'unknown', tag, limits: overrides } = {}) {
  const limits = { ...EXECUTOR_FACT_LIMITS, ...overrides }
  const name = factName(raw?.name)
  if (!name) return undefined
  const rawIngredients = asList(raw.ingredients)
  const rawProducts = asList(raw.products)
  const ingredients = rawIngredients.map(normalizeIngredient).filter(Boolean)
  const products = rawProducts.map(normalizeProduct).filter(Boolean)
  if (ingredients.length === 0 && products.length === 0) return undefined
  const machines = [...new Set(asList(raw.machines).map(machine => factName(typeof machine === 'string' ? machine : machine?.name)).filter(Boolean))]
  // Complete also means every quantity the derivation will use was reported: an ingredient without an amount, a product
  // with neither an amount nor a min/max pair, or a probability outside [0, 1] makes the recipe shown but never derived from.
  const amountsKnown = rawIngredients.every(entry => finiteNumber(entry?.amount) !== undefined)
    && rawProducts.every(entry => finiteNumber(entry?.amount) !== undefined
      || (finiteNumber(entry?.amount_min) !== undefined && finiteNumber(entry?.amount_max) !== undefined))
  const probabilitiesKnown = rawProducts.every((entry) => {
    const probability = entry?.probability ?? entry?.independent_probability
    return probability === undefined || (finiteNumber(probability) !== undefined && probability >= 0 && probability <= 1)
  })
  const complete = raw.truncated !== true
    && ingredients.length === rawIngredients.length
    && products.length === rawProducts.length
    && ingredients.length <= limits.recipeIngredients
    && products.length <= limits.recipeProducts
    && amountsKnown
    && probabilitiesKnown
  const energy = finiteNumber(raw.energy)
  return {
    name,
    ...(raw.applicability ? { applicability: recipeApplicability(raw.applicability) } : {}),
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(typeof raw.hidden_from_player_crafting === 'boolean' ? { hidden_from_player_crafting: raw.hidden_from_player_crafting } : {}),
    ...(typeof raw.hand_craftable_category === 'boolean' ? { hand_craftable_category: raw.hand_craftable_category } : {}),
    categories: [...new Set(asList(raw.categories).map(factName).filter(Boolean))].slice(0, 6),
    ...(energy !== undefined ? { energy } : {}),
    ingredients: ingredients.slice(0, limits.recipeIngredients),
    products: products.slice(0, limits.recipeProducts),
    machines: machines.slice(0, limits.recipeMachines),
    machines_truncated: machines.length > limits.recipeMachines || raw.machines_truncated === true,
    complete,
    source: typeof source === 'string' ? source.slice(0, 40) : 'unknown',
    as_of: normalizeFactTag(tag),
  }
}

/** Recipe facts out of a parsed getRecipeDetails answer (found, recipes[] with crafting_machines[]). */
export function recipeFactsFromDetails(parsed, { tag, limits } = {}) {
  if (!parsed || typeof parsed !== 'object' || parsed.found !== true) return []
  return asList(parsed.recipes).flatMap((entry) => {
    const applicability = recipeApplicability(entry?.applicability)
    if (applicability.state === 'unavailable') return []
    const fact = normalizeRecipeFact({
      name: entry?.name,
      // Legacy reads remain explicit unknowns rather than silently becoming proven eligible.
      applicability,
      enabled: entry?.enabled,
      hidden: entry?.hidden,
      hidden_from_player_crafting: entry?.hidden_from_player_crafting,
      hand_craftable_category: entry?.hand_craftable_category,
      energy: entry?.energy,
      categories: entry?.categories,
      ingredients: entry?.ingredients,
      products: entry?.products,
      machines: asList(entry?.crafting_machines),
      machines_truncated: entry?.crafting_machines_truncated === true,
    }, { source: 'getRecipeDetails', tag, limits })
    return fact ? [fact] : []
  })
}

/** The recipe a requires_machine preflight reported (requiresMachineFacts shape), with the compatible machine names. */
export function recipeFactFromRequiresMachine(facts, { tag, limits } = {}) {
  const recipe = facts?.recipe
  if (!recipe) return undefined
  return normalizeRecipeFact({
    name: recipe.name,
    energy: recipe.energy,
    categories: recipe.categories,
    ingredients: recipe.ingredients,
    products: recipe.products,
    machines: asList(facts?.machines?.candidates),
    machines_truncated: facts?.machines?.truncated === true,
    // requiresMachineFacts cuts the lists before this point: a cut recipe is not a complete one.
    truncated: recipe.ingredients_truncated === true || recipe.products_truncated === true,
  }, { source: 'requires_machine', tag, limits })
}

/** Merge a newer read of the same recipe over an older one; machine names survive when the newer read has none. */
export function mergeRecipeFact(existing, incoming) {
  if (!existing) return incoming
  return {
    ...incoming,
    machines: incoming.machines.length > 0 ? incoming.machines : existing.machines,
    machines_truncated: incoming.machines.length > 0 ? incoming.machines_truncated : existing.machines_truncated,
    categories: incoming.categories.length > 0 ? incoming.categories : existing.categories,
  }
}

/** Parse the actor inventory the game printed: a JSON array, or the serpent block of {name, count} tables. */
export function parseInventoryCounts(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return undefined
  const counts = new Map()
  const add = (name, count) => {
    const clean = factName(name)
    if (!clean || !Number.isSafeInteger(count) || count < 0) return
    counts.set(clean, (counts.get(clean) ?? 0) + count)
  }
  try {
    const parsed = JSON.parse(text)
    if (Array.isArray(parsed)) {
      for (const entry of parsed) add(entry?.name, entry?.count)
      return counts
    }
    // An empty Lua table prints as {} (or []): an empty inventory. Any other object is not an inventory.
    if (parsed && typeof parsed === 'object') return Object.keys(parsed).length === 0 ? counts : undefined
  }
  catch {}
  // serpent.block: fields sorted by key, so `count` precedes `name`; accept either order inside one table.
  const tables = text.match(/\{[^{}]*\}/g) ?? []
  for (const table of tables) {
    const name = /name\s*=\s*"([^"]*)"/.exec(table)?.[1]
    const count = /count\s*=\s*(-?\d+)/.exec(table)?.[1]
    if (name !== undefined && count !== undefined) add(name, Number(count))
  }
  return counts.size > 0 || /^\{\s*\}$/.test(text) ? counts : undefined
}

/**
 * What the active step's committed contract asks of the actor inventory, and every item its contract names.
 * Only a mode `all` contract names definite roots: a mode `any` contract does not say which requirement will be met.
 */
export function stepContractNeeds(step) {
  const contract = step?.completion_contract
  const requirements = asList(contract?.requirements)
  const items = []
  const roots = []
  const technologies = []
  for (const requirement of requirements) {
    const technology = requirement.kind === 'research_completed' ? factName(requirement.technology) : undefined
    if (technology && !technologies.includes(technology)) technologies.push(technology)
    const item = factName(requirement?.item_name)
    if (!item) continue
    if (!items.includes(item)) items.push(item)
    if (contract.mode === 'all' && requirement.kind === 'inventory_count' && Number.isSafeInteger(requirement.minimum) && requirement.minimum > 0) {
      const existing = roots.find(root => root.item === item)
      if (existing) existing.count = Math.max(existing.count, requirement.minimum)
      else roots.push({ item, count: requirement.minimum })
    }
  }
  return { roots, items, ...(technologies.length ? { technologies } : {}) }
}

// Fresh research paths are bounded whole records. A malformed, incomplete or oversized answer is explicitly
// unavailable, never a partial path presented as complete. Quantities/actions remain the executor's choice.
export function researchPathFact(parsed, target, tag) {
  const unavailable = reason => ({ target, state: 'unavailable', reason })
  const nodes = asList(parsed?.nodes)
  if (parsed?.ok !== true || parsed.target !== target || nodes.length === 0 || !nodes.some(node => node.name === target)
    || nodes.length > EXECUTOR_FACT_LIMITS.researchNodes || (parsed.node_count !== undefined && parsed.node_count !== nodes.length)
    || parsed.truncated === true) return unavailable('research_path_incomplete')
  const selected = []
  for (const node of nodes) {
    if (!factName(node.name) || typeof node.researched !== 'boolean' || !['trigger', 'science'].includes(node.mode)) return unavailable('research_node_invalid')
    if (node.mode === 'trigger' && !node.research_trigger?.type) return unavailable('research_trigger_missing')
    if (node.mode === 'science' && !node.science && !node.researched) return unavailable('research_science_missing')
    selected.push({ name: node.name, researched: node.researched, mode: node.mode, status: node.status,
      prerequisites: node.prerequisites, unresolved_prerequisites: node.unresolved_prerequisites,
      ...(node.research_trigger ? { research_trigger: node.research_trigger } : {}),
      ...(node.science ? { science: node.science } : {}) })
  }
  const fact = { target, state: 'fresh', as_of: normalizeFactTag(tag), nodes: selected }
  if (JSON.stringify(fact).length > EXECUTOR_FACT_LIMITS.researchChars) return unavailable('research_path_size_limit')
  return fact
}

const CRAFT_CAPABILITY_REASONS = new Set(['supported', 'recipe_locked', 'hidden_recipe', 'fluid_recipe', 'category_unsupported', 'actor_categories_unknown'])

function historicalTriggerCrafting(technology, item, raw, tag) {
  const report = { technology, item, source: 'goal_requirements', state: 'historical', as_of: normalizeFactTag(tag),
    recipes_status: 'available', recipes: [], truncated: raw?.truncated === true }
  if (!raw || raw.item !== item || raw.unavailable === true || raw.state === 'unavailable') {
    return { technology, item, source: 'goal_requirements', state: 'unavailable', as_of: report.as_of,
      reason: raw ? 'trigger_crafting_unavailable' : 'trigger_crafting_not_reported' }
  }
  if (!Array.isArray(raw.recipes)) return { ...report, state: 'unavailable', reason: 'trigger_crafting_invalid' }
  report.recipes_status = raw.recipes_status === 'unavailable' ? 'unavailable' : raw.recipes.length === 0 ? 'no_known_recipe' : 'available'
  for (const recipe of raw.recipes.slice(0, EXECUTOR_FACT_LIMITS.recipes)) {
    const name = factName(recipe?.recipe)
    const reason = CRAFT_CAPABILITY_REASONS.has(recipe?.hand_craftable_reason) ? recipe.hand_craftable_reason : 'actor_categories_unknown'
    const categories = [...new Set(asList(recipe?.categories).map(factName).filter(Boolean))].slice(0, EXECUTOR_FACT_LIMITS.recipeProducts)
    if (!name || categories.length === 0) { report.truncated = true; continue }
    const machines = asList(recipe.machines).map(machine => ({ entity: factName(machine?.entity), item: factName(machine?.item),
      status: ['craftable', 'locked', 'no_recipe'].includes(machine?.status) ? machine.status : 'unknown',
      ...(factName(machine?.unlocked_by) ? { unlocked_by: machine.unlocked_by } : {}) }))
      .filter(machine => machine.entity && machine.item).slice(0, EXECUTOR_FACT_LIMITS.recipeMachines)
    // Every value remains historical. Volatile craftable-now inventory counts
    // are intentionally excluded, even if they were present in the source.
    const handKnown = typeof recipe.hand_craftable === 'boolean' && CRAFT_CAPABILITY_REASONS.has(recipe.hand_craftable_reason)
      && !(recipe.hand_craftable && (recipe.enabled !== true || reason !== 'supported'))
      && !(!recipe.hand_craftable && ['supported', 'actor_categories_unknown'].includes(reason))
    report.recipes.push({ recipe: name, enabled: typeof recipe.enabled === 'boolean' ? recipe.enabled : 'unknown', categories,
      categories_truncated: recipe.categories_truncated === true || asList(recipe.categories).length > categories.length,
      hand_craftable: handKnown ? recipe.hand_craftable : 'unknown', hand_craftable_reason: handKnown ? reason : 'actor_categories_unknown',
      machines, machines_truncated: recipe.machines_truncated === true || asList(recipe.machines).length > machines.length })
  }
  if (raw.recipes.length > report.recipes.length) report.truncated = true
  while (report.recipes.length > 0 && JSON.stringify(report).length > EXECUTOR_FACT_LIMITS.researchChars) {
    report.recipes.pop(); report.truncated = true
  }
  if (report.recipes.length === 0 && raw.recipes.length > 0) {
    report.recipes_status = 'unavailable'; report.reason = 'trigger_crafting_cache_size_or_validation_limit'
  }
  return report
}

// Cache only native craft-item capability reports. Serialization retains tags;
// enabled state and actor capabilities are labelled historical, never fresh.
export function cacheTriggerCraftingReports(research, tag) {
  if (!research || typeof research !== 'object' || Array.isArray(research)) return []
  return Object.entries(research).filter(([technology, node]) => factName(technology)
    && node?.trigger?.type === 'craft-item' && factName(node.trigger.item))
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, EXECUTOR_FACT_LIMITS.researchNodes)
    .map(([technology, node]) => historicalTriggerCrafting(technology, node.trigger.item, node.trigger_crafting, tag))
}

// Augment a validated fresh getResearchPath fact with matching cached facts.
// Keep the authoritative trigger untouched and the old capability tag intact.
// Size reduction drops whole recipe alternatives, always marking omissions.
export function attachCachedTriggerCrafting(fact, cachedReports) {
  if (fact?.state !== 'fresh' || !Array.isArray(fact.nodes)) return fact
  if (fact.nodes.length > EXECUTOR_FACT_LIMITS.researchNodes || JSON.stringify(fact).length > EXECUTOR_FACT_LIMITS.researchChars) {
    return { target: fact.target, state: 'unavailable', reason: 'research_path_size_limit' }
  }
  const reports = asList(cachedReports).slice(0, EXECUTOR_FACT_LIMITS.researchNodes)
  const augmented = { ...fact, nodes: fact.nodes.map(node => ({ ...node })) }
  const craftNodes = augmented.nodes.filter(node => node.research_trigger?.type === 'craft-item' && factName(node.research_trigger.item))
  // Reserve explicit unknown markers for all nodes before filling any cached
  // details. An early recipe must not consume the space a later node needs.
  for (const node of craftNodes) node.trigger_crafting = { item: node.research_trigger.item, state: 'unavailable', reason: 'trigger_crafting_not_reported' }
  if (JSON.stringify(augmented).length > EXECUTOR_FACT_LIMITS.researchChars) {
    return { target: fact.target, state: 'unavailable', reason: 'research_path_with_trigger_crafting_size_limit' }
  }
  for (const node of craftNodes) {
    const cached = reports.find(report => report?.technology === node.name && report.item === node.research_trigger.item)
    const report = historicalTriggerCrafting(node.name, node.research_trigger.item, cached, cached?.as_of)
    node.trigger_crafting = report
    while (report.recipes?.length > 0 && JSON.stringify(augmented).length > EXECUTOR_FACT_LIMITS.researchChars) {
      report.recipes.pop(); report.truncated = true
      if (report.recipes.length === 0) { report.recipes_status = 'unavailable'; report.reason = 'trigger_crafting_handoff_size_limit' }
    }
    if (JSON.stringify(augmented).length > EXECUTOR_FACT_LIMITS.researchChars) {
      node.trigger_crafting = { item: node.research_trigger.item, state: 'unavailable', reason: 'craft_facts_size_limit' }
    }
  }
  return augmented
}

export function researchFactItems(paths) {
  return [...new Set(asList(paths).filter(path => path.state === 'fresh').flatMap(path => path.nodes.flatMap(node => [
    node.research_trigger?.item, ...asList(node.science?.ingredients).map(ingredient => ingredient.name),
  ])).map(factName).filter(Boolean))]
}

function researchRecords(paths) {
  return asList(paths).map((path, index) => ({ key: `research_path_${index}`, block: 'step',
    text: `research_path (authoritative getResearchPath; current read or explicit missing fact${path.nodes?.some(node => node.trigger_crafting) ? '; trigger_crafting is cached/historical, not current admission proof' : ''}): ${JSON.stringify(path)}` }))
}

// The recipe the derivation may use to make `item`: one deterministic, complete recipe with a certain item output.
function expandableRecipe(item, recipes) {
  const candidates = recipes.filter(recipe => recipe.complete && recipe.products.some(product => product.name === item && product.type === 'item'))
  const chosen = candidates.length === 1 ? candidates[0] : candidates.find(recipe => recipe.name === item)
  if (!chosen) return undefined
  const product = chosen.products.find(entry => entry.name === item && entry.type === 'item')
  const output = product?.amount
  if (!(output > 0) || product.amount_min !== undefined || product.amount_max !== undefined) return undefined
  // A recipe with several item products yields them together: counting crafts for one product would double count the other.
  if (chosen.products.filter(entry => entry.type === 'item').length !== 1) return undefined
  if (product.probability !== undefined && product.probability !== 1) return undefined
  if (chosen.ingredients.length === 0) return undefined
  const usable = chosen.ingredients.every(ingredient => ingredient.type === 'item' && ingredient.amount > 0 && ingredient.name !== item)
  if (!usable) return undefined
  return { recipe: chosen, output }
}

/**
 * The item ingredients of the one recipe a derivation would expand `item` with, or [] when no recipe can be counted exactly.
 * `rawLeaves` (anything with `has(item)`) names items that are mined, not made: they are never expanded.
 */
export function expandableIngredients(item, recipes, rawLeaves) {
  if (rawLeaves?.has?.(item)) return []
  const expansion = expandableRecipe(item, asList(recipes))
  return expansion ? expansion.recipe.ingredients.map(ingredient => ingredient.name) : []
}

// --- Raw leaves (unit 6) -------------------------------------------------------------------------------------------
//
// An item that a resource prototype mines (the mod's getRecipeDetails answer carries `mined_from`) is acquired by mining,
// whatever recycling or crushing recipes also list it as a product. Those recipes are noise for a step brief, so the
// harness keeps the item as a raw leaf: never expanded, and no recipe that produces it is carried.

/** The raw-leaf declaration of a parsed getRecipeDetails answer: `{ item, mined_from }`, or undefined when it has none. */
export function rawLeafFromRecipeDetails(parsed, limits = EXECUTOR_FACT_LIMITS) {
  if (!parsed || typeof parsed !== 'object') return undefined
  if (!(parsed.found === true || (parsed.found === false && parsed.code === 'no_recipe'))) return undefined
  const item = factName(parsed.query)
  if (!item || !Array.isArray(parsed.mined_from)) return undefined
  const minedFrom = [...new Set(parsed.mined_from.map(factName).filter(Boolean))].slice(0, limits.rawLeafMinedFrom)
  return minedFrom.length > 0 ? { item, mined_from: minedFrom } : undefined
}

/** The recipe facts that do not produce a raw leaf; `rawLeaves` is anything with `has(item)`. */
export function withoutRawLeafRecipes(recipes, rawLeaves) {
  const list = asList(recipes)
  if (!rawLeaves || !(rawLeaves.size > 0)) return list
  return list.filter(recipe => !recipe.products.some(product => rawLeaves.has(product.name)))
}

/**
 * One mining source read: the answer of findLongRangeEntities (name, max_radius, limit 1) for `resource`, as a fact.
 * `found` carries the nearest instance's position and distance; `none` only for the mod's own empty answer (matched_count 0,
 * no error); anything else, including an answer for another name, is `failed`: never read as absence.
 */
export function rawLeafSourceFromRead(raw, resource, radius) {
  let parsed
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return { resource, state: 'failed' } }
  if (!parsed || typeof parsed !== 'object' || parsed.ok === false || parsed.error !== undefined) return { resource, state: 'failed' }
  if (parsed.name !== resource || parsed.max_radius !== radius || !Number.isFinite(parsed.searched_radius) || parsed.searched_radius < 1 || parsed.searched_radius > radius) return { resource, state: 'failed' }
  const nearest = Array.isArray(parsed.entities) ? parsed.entities[0] : undefined
  if (parsed.found === true && parsed.returned_count === 1 && Array.isArray(parsed.entities) && parsed.entities.length === 1 && parsed.matched_count >= 1 && nearest?.name === resource && nearest.type === 'resource') {
    const x = finiteNumber(nearest.position?.x)
    const y = finiteNumber(nearest.position?.y)
    const distance = finiteNumber(nearest.distance)
    if (x === undefined || y === undefined || distance === undefined || distance < 0 || distance > parsed.searched_radius || Math.abs(x) > 10000256 || Math.abs(y) > 10000256) return { resource, state: 'failed' }
    const round = value => Math.round(value * 10) / 10
    return { resource, state: 'found', x: round(x), y: round(y), distance: round(distance), radius }
  }
  if (parsed.found === false && parsed.searched_radius === radius && parsed.returned_count === 0 && parsed.matched_count === 0 && Array.isArray(parsed.entities) && parsed.entities.length === 0) return { resource, state: 'none', radius }
  return { resource, state: 'failed' }
}

function rawSourceText(source, multiple) {
  const label = multiple ? `@${source.resource}` : ''
  if (source.state === 'found') return `nearest${label}=(${source.x},${source.y}) distance${label}=${source.distance}`
  if (source.state === 'none') return `nearest${label}=none_within_${source.radius}`
  if (source.state === 'failed') return `nearest${label}=read_failed`
  return `nearest${label}=not_read`
}

/** The acquisition clause of a residual row: how the raw leaf is natively acquired and where the nearest source was last read. */
export function rawLeafRowText(raw) {
  const sources = asList(raw?.sources)
  const minedFrom = asList(raw?.mined_from)
  if (minedFrom.length === 0) return ''
  const read = sources.some(source => source.state !== 'not_read')
  return [
    `raw: mined_from=${minedFrom.join(',')} (source observation; reach/path unverified)`,
    ...sources.map(source => rawSourceText(source, minedFrom.length > 1)),
    read ? `as_of=${tagText(raw.as_of)}` : '',
  ].filter(Boolean).join(' ')
}

/** Whether any recipe fact names `item` (by recipe name or as an item product). */
export function recipeKnownForItem(item, recipes) {
  return asList(recipes).some(recipe => recipe.name === item || recipe.products.some(product => product.name === item))
}

/** The items a derivation would need counts for, breadth first from the roots through the recipes it can expand. */
export function neededItems(roots, recipes, limit = EXECUTOR_FACT_LIMITS.countItems) {
  const order = []
  const queue = roots.map(root => root.item)
  while (queue.length > 0) {
    const item = queue.shift()
    if (order.includes(item)) continue
    order.push(item)
    const expansion = expandableRecipe(item, recipes)
    if (expansion) for (const ingredient of expansion.recipe.ingredients) queue.push(ingredient.name)
  }
  return { items: order.slice(0, limit), complete: order.length <= limit }
}

/**
 * Residual needs of one step: per needed item the required amount, the held amount and what is still missing, with
 * shared stock (an item two consumers need is accumulated once and the held amount is taken once) and recipe output
 * quantities (a recipe yielding two per craft needs half the crafts). Returns `{ ok: true, rows }`, or
 * `{ ok: false, reason }` when an input is unknown: it never guesses. `held` is a Map of fresh counts.
 */
export function deriveResidualNeeds({ roots, recipes, held }) {
  if (!Array.isArray(roots) || roots.length === 0) return { ok: false, reason: 'no_contract_roots' }
  const facts = Array.isArray(recipes) ? recipes : []
  // Reachable graph through expandable recipes, in dependency order (consumers before their ingredients).
  const edges = new Map()
  const expansions = new Map()
  const visit = [...roots.map(root => root.item)]
  while (visit.length > 0) {
    const item = visit.pop()
    if (edges.has(item)) continue
    const expansion = expandableRecipe(item, facts)
    expansions.set(item, expansion)
    const next = expansion ? [...new Set(expansion.recipe.ingredients.map(ingredient => ingredient.name))] : []
    edges.set(item, next)
    visit.push(...next)
  }
  const indegree = new Map([...edges.keys()].map(item => [item, 0]))
  for (const next of edges.values()) for (const item of next) indegree.set(item, (indegree.get(item) ?? 0) + 1)
  const ready = [...indegree.entries()].filter(([, degree]) => degree === 0).map(([item]) => item)
  const order = []
  while (ready.length > 0) {
    const item = ready.shift()
    order.push(item)
    for (const next of edges.get(item) ?? []) {
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) ready.push(next)
    }
  }
  if (order.length !== edges.size) return { ok: false, reason: 'recipe_cycle' }
  // Two needed items made by one recipe would each claim its ingredients: refuse rather than double count.
  const used = new Set()
  for (const expansion of expansions.values()) {
    if (!expansion) continue
    if (used.has(expansion.recipe.name)) return { ok: false, reason: `shared_recipe:${expansion.recipe.name}` }
    used.add(expansion.recipe.name)
  }
  const demand = new Map()
  for (const root of roots) demand.set(root.item, (demand.get(root.item) ?? 0) + root.count)
  const rows = []
  for (const item of order) {
    const required = demand.get(item) ?? 0
    if (required <= 0) continue
    const count = held instanceof Map ? held.get(item) : undefined
    if (!Number.isSafeInteger(count) || count < 0) return { ok: false, reason: `held_unknown:${item}` }
    const missing = Math.max(0, required - count)
    const row = { item, required, held: count, missing }
    const expansion = expansions.get(item)
    if (expansion && missing > 0) {
      const crafts = Math.ceil(missing / expansion.output)
      row.crafts = crafts
      row.recipe = expansion.recipe.name
      for (const ingredient of expansion.recipe.ingredients) demand.set(ingredient.name, (demand.get(ingredient.name) ?? 0) + crafts * ingredient.amount)
    }
    rows.push(row)
  }
  return { ok: true, rows }
}

/**
 * Which recipe facts to carry: those producing an item the step or the goal names first, then those touching an item the
 * derivation needs, then the most recently read. `recipes` is oldest read first. Bounded; stable order.
 */
export function selectRecipeFacts(recipes, { wanted = [], needed = [], limit = EXECUTOR_FACT_LIMITS.recipes } = {}) {
  const list = Array.isArray(recipes) ? recipes : []
  const wantedSet = new Set(wanted)
  const neededSet = new Set(needed)
  const scored = list.map((recipe, index) => {
    const produces = recipe.products.map(product => product.name)
    const consumes = recipe.ingredients.map(ingredient => ingredient.name)
    const score = produces.some(name => wantedSet.has(name)) ? 3
      : produces.some(name => neededSet.has(name)) || consumes.some(name => wantedSet.has(name)) ? 2
        : 1
    return { recipe, score, index }
  })
  scored.sort((left, right) => (right.score - left.score) || (right.index - left.index))
  return scored.slice(0, limit).map(entry => entry.recipe)
}

function amountText(entry) {
  if (entry.amount !== undefined) return String(entry.amount)
  if (entry.amount_min !== undefined || entry.amount_max !== undefined) return `${entry.amount_min ?? '?'}-${entry.amount_max ?? '?'}`
  return '?'
}

function stackText(entry) {
  const probability = entry.probability !== undefined && entry.probability !== 1 ? ` p=${entry.probability}` : ''
  return `${entry.type === 'fluid' ? 'fluid ' : ''}${amountText(entry)} ${entry.name}${probability}`
}

// The whole parts that fit a character budget (the first part is always kept).
function boundedKept(parts, separator, max) {
  const kept = []
  let used = 0
  for (const part of parts) {
    const next = used + (kept.length > 0 ? separator.length : 0) + part.length
    if (next > max && kept.length > 0) break
    kept.push(part)
    used = next
  }
  return kept
}

// Joins whole parts up to a character budget; the parts that do not fit are counted, never cut.
function joinBounded(parts, separator, max) {
  const kept = boundedKept(parts, separator, max)
  const left = parts.length - kept.length
  return `${kept.join(separator)}${left > 0 ? `${separator}(+${left} more)` : ''}`
}

export function recipeFactLine(fact, max = EXECUTOR_FACT_LIMITS.recipeChars) {
  const head = `recipe_fact ${fact.name} (stable recipe data, source=${fact.source}, as_of=${tagText(fact.as_of)}${fact.complete ? '' : ', incomplete'})`
  const body = [
    fact.applicability ? `applicability=${fact.applicability.state}${fact.applicability.surface_index ? `@surface:${fact.applicability.surface_index}` : ''}` : '',
    fact.enabled === false ? 'locked (planning dependency)' : '',
    fact.categories.length > 0 ? `categories=${fact.categories.join('+')}` : '',
    fact.energy !== undefined ? `energy=${fact.energy}` : '',
    `ingredients=${fact.ingredients.map(stackText).join(' + ') || 'none'}`,
    `products=${fact.products.map(stackText).join(' + ') || 'none'}`,
    fact.machines.length > 0 ? `machines=${fact.machines.join(',')}${fact.machines_truncated ? '+' : ''}` : '',
  ].filter(Boolean)
  return oneLine(`${head}: ${body.join(' | ')}`, max)
}

function countsRecords(counts, limits) {
  const records = []
  const items = asList(counts?.items).filter(entry => factName(entry?.item) && Number.isSafeInteger(entry.count)).slice(0, limits.countItems)
  const fresh = items.filter(entry => entry.state === 'fresh')
  const stale = items.filter(entry => entry.state === 'stale')
  const unavailable = asList(counts?.unavailable).map(factName).filter(Boolean).slice(0, limits.countItems)
  if (counts?.deferred === 'batch_in_flight') {
    records.push({
      key: 'counts_deferred',
      block: 'step',
      drop: 'fresh_counts',
      text: 'counts_deferred=batch_in_flight (an operation batch was sent and has not finished; held_counts, checkpoint_machine and residual_needs are omitted from this packet)',
    })
  }
  if (fresh.length > 0) {
    records.push({
      key: 'held_counts',
      block: 'step',
      drop: 'fresh_counts',
      text: `held_counts (fresh live read of the actor inventory, as_of=${tagText(counts.as_of)}): ${joinBounded(fresh.map(entry => `${entry.item}=${entry.count}`), ' ', limits.countChars)}`,
    })
  }
  if (stale.length > 0 || unavailable.length > 0) {
    const parts = stale.map(entry => `${entry.item}=${entry.count} (observed ${tagText(entry)}${entry.reason ? `, ${entry.reason}` : ''})`)
    if (unavailable.length > 0) parts.push(`no value: ${unavailable.join(',')}`)
    records.push({
      key: 'held_counts_stale',
      block: 'step',
      drop: 'stale_counts',
      text: `held_counts_STALE (earlier observations, NOT current; the fresh read failed or was skipped): ${joinBounded(parts, ' ', limits.countChars)}`,
    })
  }
  return records
}

function machineRecord(machine, limits) {
  if (!machine || typeof machine !== 'object' || !machine.facts) return undefined
  const facts = machine.facts
  const body = {}
  for (const key of ['unit_number', 'name', 'recipe', 'working', 'status_code', 'checkpoint', 'inventories', 'inventory_read', 'error']) {
    if (facts[key] !== undefined) body[key] = facts[key]
  }
  const fresh = machine.state === 'fresh'
  const label = fresh
    ? `checkpoint_machine (fresh live read, as_of=${tagText(machine.as_of)})`
    : `checkpoint_machine_STALE (earlier observation as_of=${tagText(machine.as_of)}, NOT current${machine.reason ? `; ${machine.reason}` : ''})`
  return {
    key: 'checkpoint_machine',
    block: 'step',
    drop: fresh ? 'fresh_counts' : 'stale_counts',
    text: oneLine(`${label}: ${JSON.stringify(body)}`, limits.machineChars),
  }
}

function residualRecord(residual, limits) {
  if (!residual?.rows || residual.rows.length === 0) return undefined
  const rows = residual.rows.slice(0, limits.residualRows).map(row => `${row.item} required=${row.required} held=${row.held} missing=${row.missing}${row.crafts !== undefined ? ` crafts=${row.crafts} via ${row.recipe}` : ''}`)
  const roots = asList(residual.roots).map(root => `${root.item}>=${root.count}`).join(',')
  return {
    key: 'residual_needs',
    block: 'step',
    drop: 'residual_needs',
    text: `residual_needs (derived from recipe_fact and fresh held_counts for the step contract ${roots}; shared stock counted once): ${joinBounded(rows, ' | ', limits.residualChars)}`,
  }
}

// Acquisition is separate from recipe arithmetic so long intermediate chains cannot truncate the raw leaves.
function acquisitionRecord(residual, limits) {
  const rows = asList(residual?.rows).filter(row => row.raw).map(row => `${row.item} missing=${row.missing} ${rawLeafRowText(row.raw)}`)
  if (!rows.length) return undefined
  return { key: 'raw_leaf_acquisition', block: 'step', drop: 'raw_leaf_acquisition',
    text: `raw_leaf_acquisition: ${joinBounded(rows, ' | ', limits.acquisitionChars)}` }
}

// --- Historical native fluid-tile anchors (unit 3a) ----------------------------------------------------------------
//
// getFluidSourceTiles answers live only in the conversation that asked, and a restage or compaction discards them. The
// harness keeps the tile positions a WELL-FORMED native answer reported, as history: where water was observed, not
// where it is reachable, legal to place on, or nearest. The validator mirrors the answer the mod actually returns
// (packages/autorio fluid_source_observation) and refuses anything that does not match the request it answers.

const FLUID_COORDINATE_LIMIT = 10000256

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

export function fluidHintKey(anchor) {
  return `${anchor.surface_index}:${anchor.position.x}:${anchor.position.y}`
}

/**
 * The anchors in one getFluidSourceTiles answer, or `{ rejected: <reason> }`. `raw` is the answer text, `args` the request
 * the model made (fluid_name, search_radius default 128, limit default 8), `tag` where the read happened (its tick is
 * replaced by the game tick the answer itself reports). An empty answer is `{ rejected: 'no_samples' }`: nothing to keep.
 */
export function fluidSourceHintsFromRead(raw, args, tag, limits = EXECUTOR_FACT_LIMITS) {
  const rejected = reason => ({ rejected: reason })
  if (typeof raw !== 'string' || raw.length > limits.fluidReadChars) return rejected('unreadable_or_oversized')
  let result
  try { result = JSON.parse(raw) }
  catch { return rejected('unreadable_or_oversized') }
  if (!isPlainObject(result) || result.ok !== true) return rejected('not_a_successful_answer')
  if (!isPlainObject(args)) return rejected('request_unknown')
  const fluid = factName(result.fluid_name)
  if (!fluid || result.fluid_name !== args.fluid_name) return rejected('fluid_name_mismatch')
  if (result.coverage !== 'generated_bounding_square') return rejected('coverage_not_declared')
  if (!Number.isSafeInteger(result.surface_index) || result.surface_index < 1) return rejected('surface_index_invalid')
  if (!Number.isSafeInteger(result.observed_tick) || result.observed_tick < 0) return rejected('observed_tick_invalid')
  const radius = args.search_radius ?? 128
  if (!Number.isSafeInteger(radius) || radius < 1 || radius > 256 || result.search_radius !== radius) return rejected('search_radius_mismatch')
  const limit = args.limit ?? 8
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) return rejected('limit_invalid')
  // An empty Lua table prints as [] or {}.
  const samples = Array.isArray(result.samples) ? result.samples
    : isPlainObject(result.samples) && Object.keys(result.samples).length === 0 ? [] : undefined
  if (!samples || typeof result.truncated !== 'boolean' || result.returned_count !== samples.length || samples.length > limit) return rejected('sample_count_inconsistent')
  if (samples.length === 0) return rejected('no_samples')
  const inRange = value => Number.isInteger(value) && Math.abs(value) <= FLUID_COORDINATE_LIMIT
  if (samples.some(sample => !isPlainObject(sample) || !factName(sample.name) || sample.fluid_name !== result.fluid_name
    || sample.surface_index !== result.surface_index || !inRange(sample.position?.x) || !inRange(sample.position?.y))) return rejected('sample_invalid')
  const as_of = normalizeFactTag({ ...tag, tick: result.observed_tick })
  return {
    anchors: samples.map(sample => ({
      name: sample.name,
      fluid_name: sample.fluid_name,
      surface_index: sample.surface_index,
      position: { x: sample.position.x, y: sample.position.y },
      as_of,
    })),
  }
}

/** Merge anchors into a Map keyed surface_index:x:y (most recent last). Bounded by count and by serialized size; returns the number evicted. */
export function rememberFluidHints(store, anchors, limits = EXECUTOR_FACT_LIMITS) {
  for (const anchor of anchors) {
    const key = fluidHintKey(anchor)
    store.delete(key) // a re-read is the most recent read
    store.set(key, anchor)
  }
  let evicted = 0
  while (store.size > 0 && (store.size > limits.fluidHints || JSON.stringify([...store.values()]).length > limits.fluidHintStoreChars)) {
    store.delete(store.keys().next().value)
    evicted += 1
  }
  return evicted
}

function fluidHintsRecord(hints, limits) {
  const list = asList(hints).filter(anchor => isPlainObject(anchor) && factName(anchor.name) && factName(anchor.fluid_name)
    && Number.isSafeInteger(anchor.surface_index) && Number.isInteger(anchor.position?.x) && Number.isInteger(anchor.position?.y)).slice(0, limits.fluidHints)
  if (list.length === 0) return undefined
  const parts = list.map(anchor => `${anchor.fluid_name}:${anchor.name}@(${anchor.position.x},${anchor.position.y}) surface=${anchor.surface_index} observed ${tagText(anchor.as_of)}`)
  const kept = boundedKept(parts, ' | ', limits.fluidHintChars)
  const more = parts.length - kept.length
  return {
    key: 'fluid_source_hints',
    block: 'step',
    drop: 'fluid_source_hints',
    shown: kept.length,
    text: `fluid_source_hints (HISTORICAL: positions where native fluid tiles were observed earlier, newest first; NOT current, not nearest, not a reachable or legal placement; re-check with getFluidSourceTiles before placing anything): ${kept.join(' | ')}${more > 0 ? ` | (+${more} more)` : ''}`,
  }
}

function historicalRecord(entities, limits) {
  const list = asList(entities).filter(entry => factName(entry?.name) && Number.isSafeInteger(entry.count)).slice(0, limits.historicalKinds)
  if (list.length === 0) return undefined
  const parts = list.map(entry => `${entry.name} x${entry.count}${Number.isSafeInteger(entry.tick) ? ` (tick:${entry.tick})` : ''}`)
  return {
    key: 'historical_entities',
    block: 'step',
    drop: 'historical_entities',
    text: `historical_entities (earlier observations, NOT current exact targets; ids withheld): ${joinBounded(parts, ' | ', limits.historicalChars)}`,
  }
}

// Fields naming what is authoritative in this packet and what is only history. Mandatory (never dropped by size).
function authorityRecord(plan, step, limits) {
  const contract = step?.completion_contract
  const held = plan?.execution?.receipts?.[step?.step_id]
  const latest = Array.isArray(held) && held.length > 0 ? held[held.length - 1] : undefined
  return {
    key: 'executor_authority',
    block: 'step',
    text: oneLine(`authority: active_step=${step.step_id} (committed plan) contract=${contract?.mode ? `${contract.mode} (committed)` : step?.contract_status === 'pending' ? 'pending' : 'none'} latest_receipt=${latest ? `#${latest.seq ?? held.length} ${latest.kind} ${latest.ref} (this step)` : 'none'} entity_ids_in_receipts_and_snapshots=historical_observations`, limits.authorityChars),
  }
}

function executorFactRecords(facts, plan, step, limits) {
  if (!facts || typeof facts !== 'object') return []
  const records = []
  if (plan && step) records.push(authorityRecord(plan, step, limits))
  records.push(...researchRecords(facts.research))
  records.push(...countsRecords(facts.counts, limits))
  const machine = machineRecord(facts.machine, limits)
  if (machine) records.push(machine)
  const residual = residualRecord(facts.residual, limits)
  if (residual) records.push(residual)
  const acquisition = acquisitionRecord(facts.residual, limits)
  if (acquisition) records.push(acquisition)
  asList(facts.recipes).slice(0, limits.recipes).forEach((fact, index) => {
    records.push({ key: `recipe_fact_${index}`, block: 'step', drop: 'recipe_facts', rank: index, text: recipeFactLine(fact, limits.recipeChars) })
  })
  const historical = historicalRecord(facts.historical_entities, limits)
  if (historical) records.push(historical)
  const fluidHints = fluidHintsRecord(facts.fluid_source_hints, limits)
  if (fluidHints) records.push(fluidHints)
  return records
}

// What an executor-facts packet carried after size control, for the trace row.
function executorFactsSummary(facts, kept) {
  const keys = new Set(kept.map(record => record.key))
  const counts = asList(facts?.counts?.items)
  return {
    ...(facts?.research?.length ? {
      research_paths: facts.research.filter(path => path.state === 'fresh').length,
      missing_research: facts.research.filter(path => path.state !== 'fresh').map(path => path.target),
    } : {}),
    recipe_facts: kept.filter(record => record.key.startsWith('recipe_fact_')).length,
    fresh_items: keys.has('held_counts') ? counts.filter(entry => entry.state === 'fresh').length : 0,
    stale_items: keys.has('held_counts_stale') ? counts.filter(entry => entry.state === 'stale').length + asList(facts?.counts?.unavailable).length : 0,
    residual_needs: keys.has('residual_needs') ? asList(facts?.residual?.rows).length : 0,
    machine: keys.has('checkpoint_machine') ? (facts?.machine?.state ?? 'none') : 'none',
    historical_entity_kinds: keys.has('historical_entities') ? asList(facts?.historical_entities).length : 0,
    ...(asList(facts?.fluid_source_hints).length > 0
      ? { fluid_source_hints: keys.has('fluid_source_hints') ? kept.find(record => record.key === 'fluid_source_hints').shown : 0 }
      : {}),
    ...(keys.has('counts_deferred') ? { counts_deferred: 'batch_in_flight' } : {}),
  }
}

/**
 * The message a deferred handoff sends once the batch receipt landed: the counts, the checkpoint machine and the residual
 * needs read then, in the packet's own labels. '' when there is nothing to say.
 */
export function executorFactsRefreshMessage(facts, limits = EXECUTOR_FACT_LIMITS) {
  if (!facts || typeof facts !== 'object') return ''
  const records = [...countsRecords({ ...facts.counts, deferred: undefined }, limits)]
  records.push(...researchRecords(facts.research))
  const machine = machineRecord(facts.machine, limits)
  if (machine) records.push(machine)
  const residual = residualRecord(facts.residual, limits)
  if (residual) records.push(residual)
  const acquisition = acquisitionRecord(facts.residual, limits)
  if (acquisition) records.push(acquisition)
  if (records.length === 0) return ''
  return ['[HARNESS] Executor facts refreshed after the batch receipt landed (live reads taken now, same labels as the handoff packet; facts only):', ...records.map(record => record.text)].join('\n')
}

function stepRecords(state, plan, activeIndex, limits, { role, checkpoint, reason, budget, note, actor, runtime, amendment, jevFacts, jevHints, executorFacts }) {
  const records = [
    { key: 'restage', block: 'step', text: `restage: role=${role} checkpoint=${checkpoint}${reason ? ` reason=${oneLine(reason, limits.reasonChars)}` : ''}` },
  ]
  // Mandatory (no `drop` key): a pending user amendment must survive the restage that replaces the
  // conversation holding its text; size never drops it.
  const amendmentText = amendment ? sanitizeAmendmentText(amendment.text, limits.amendmentChars) : ''
  if (amendmentText) {
    records.push({ key: 'user_amendment', block: 'step', text: `user_amendment (from ${oneLine(amendment.sender, 60) || 'the player'}; user steering, NOT yet applied; apply it at this planner boundary, never as the executor): ${amendmentText}` })
  }
  // The actor snapshot the runtime captured for this restage (C7 carries the
  // new epoch). Volatile: it moves with every actor replacement.
  const actorLine = scalarLine(actor, ACTOR_KEYS, limits.runtimeChars)
  if (actorLine) records.push({ key: 'actor', block: 'step', text: `actor: ${actorLine}` })
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
      const contract = contractText(step, limits.contractChars)
      if (contract) records.push({ key: 'contract', block: 'step', drop: 'contract', text: `active_step_contract: ${contract}` })
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
      records.push(...executorFactRecords(executorFacts, plan, step, limits))
    }
    else {
      records.push({ key: 'active_step', block: 'step', text: 'active_step: none (all steps closed)' })
    }
  }
  const skills = skillIdsOf(state, plan)
  if (skills.length > 0) records.push({ key: 'skills', block: 'step', drop: 'skills', text: `loaded_skills: ${skills.join(', ')}` })
  const runtimeLine = scalarLine(runtime, RUNTIME_KEYS, limits.runtimeChars)
  if (runtimeLine) records.push({ key: 'runtime', block: 'step', drop: 'runtime', text: `runtime: ${runtimeLine}` })
  records.push(...jevFactRecords(jevFacts, jevHints, limits))
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
 * @param {object[]} [args.shelfCandidates] shelfRefinementCandidates(state) for a planner restage at a shelf pickup
 * @param {object} [args.actor] fresh actor snapshot (actor_id, actor_kind, epoch, connected_players); never dropped
 * @param {object} [args.runtime] compact runtime state (task_state, queue_length, idle)
 * @param {{sender:string,text:string}} [args.amendment] a staged user amendment not yet applied (mandatory, never dropped by size)
 * @param {{family:string,text:string}[]} [args.jevFacts] U11 advisory: bounded deterministic facts for the families Jev selected (dropped first when over size)
 * @param {object} [args.executorFacts] D2: harness-read facts for a fresh executor ({recipes, counts, machine, residual, historical_entities, fluid_source_hints}); each record is labelled fresh, stale or historical
 * @param {string[]} [args.jevHints] U11 advisory: families Jev selected that have no parameterless fact read (one hint line)
 */
export function buildHandoffPacket({ planningState, role, checkpoint, reason = '', note = '', budget = '', actor, runtime, shelfCandidates, amendment, jevFacts, jevHints, executorFacts, previousContextChars, now, limits: limitOverrides } = {}) {
  if (!CONTEXT_RESTAGE_ROLES.includes(role)) throw new RangeError(`handoff role must be one of ${CONTEXT_RESTAGE_ROLES.join(', ')}`)
  if (!CONTEXT_RESTAGE_CHECKPOINTS.includes(checkpoint)) throw new RangeError(`handoff checkpoint must be one of ${CONTEXT_RESTAGE_CHECKPOINTS.join(', ')}`)
  if (!planningState?.goal?.goal_id) throw new RangeError('handoff packet needs a planning state with a goal')
  const limits = { ...HANDOFF_PACKET_LIMITS, ...EXECUTOR_FACT_LIMITS, ...limitOverrides }

  const plan = getActivePlan(planningState)
  const activeIndex = plan && Number.isInteger(plan.active_step_index) ? plan.active_step_index : -1
  const roadmap = roadmapRecord(planningState, plan)
  const records = [
    ...goalRecords(planningState, limits),
    ...(roadmap ? [roadmap] : []),
    ...planRecords(plan, activeIndex, limits),
    ...stepRecords(planningState, plan, activeIndex, limits, { role, checkpoint, reason, budget, note, actor, runtime, amendment, jevFacts, jevHints, executorFacts }),
    ...shelfCandidateRecords(shelfCandidates, limits),
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
    handoffId,
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
    amendment_included: records.some(record => record.key === 'user_amendment'),
    // Present only when the caller supplied executor facts: what survived size control (the loop traces it).
    ...(executorFacts ? { executor_facts: executorFactsSummary(executorFacts, kept) } : {}),
    over_limit: text.length > limits.maxChars,
  }
}
