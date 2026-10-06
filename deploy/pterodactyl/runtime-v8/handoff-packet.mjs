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
  historicalKinds: 6,
  historicalChars: 280,
  authorityChars: 320,
  cachedRecipes: 32,
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
  const complete = ingredients.length === rawIngredients.length
    && products.length === rawProducts.length
    && ingredients.length <= limits.recipeIngredients
    && products.length <= limits.recipeProducts
  const energy = finiteNumber(raw.energy)
  return {
    name,
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
    const fact = normalizeRecipeFact({
      name: entry?.name,
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
  for (const requirement of requirements) {
    const item = factName(requirement?.item_name)
    if (!item) continue
    if (!items.includes(item)) items.push(item)
    if (contract.mode === 'all' && requirement.kind === 'inventory_count' && Number.isSafeInteger(requirement.minimum) && requirement.minimum > 0) {
      const existing = roots.find(root => root.item === item)
      if (existing) existing.count = Math.max(existing.count, requirement.minimum)
      else roots.push({ item, count: requirement.minimum })
    }
  }
  return { roots, items }
}

// The recipe the derivation may use to make `item`: one deterministic, complete recipe with a certain item output.
function expandableRecipe(item, recipes) {
  const candidates = recipes.filter(recipe => recipe.complete && recipe.products.some(product => product.name === item && product.type === 'item'))
  const chosen = candidates.length === 1 ? candidates[0] : candidates.find(recipe => recipe.name === item)
  if (!chosen) return undefined
  const product = chosen.products.find(entry => entry.name === item && entry.type === 'item')
  const output = product?.amount
  if (!(output > 0) || product.amount_min !== undefined || product.amount_max !== undefined) return undefined
  if (product.probability !== undefined && product.probability !== 1) return undefined
  if (chosen.ingredients.length === 0) return undefined
  const usable = chosen.ingredients.every(ingredient => ingredient.type === 'item' && ingredient.amount > 0 && ingredient.name !== item)
  if (!usable) return undefined
  return { recipe: chosen, output }
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

// Joins whole parts up to a character budget; the parts that do not fit are counted, never cut.
function joinBounded(parts, separator, max) {
  const kept = []
  let used = 0
  for (const part of parts) {
    const next = used + (kept.length > 0 ? separator.length : 0) + part.length
    if (next > max && kept.length > 0) break
    kept.push(part)
    used = next
  }
  const left = parts.length - kept.length
  return `${kept.join(separator)}${left > 0 ? `${separator}(+${left} more)` : ''}`
}

export function recipeFactLine(fact, max = EXECUTOR_FACT_LIMITS.recipeChars) {
  const head = `recipe_fact ${fact.name} (stable recipe data, source=${fact.source}, as_of=${tagText(fact.as_of)}${fact.complete ? '' : ', incomplete'})`
  const body = [
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
    text: oneLine(`authority: active_step=${step.step_id} (committed plan) contract=${contract?.mode ? `${contract.mode} (committed)` : 'none'} latest_receipt=${latest ? `#${latest.seq ?? held.length} ${latest.kind} ${latest.ref} (this step)` : 'none'} entity_ids_in_receipts_and_snapshots=historical_observations current_exact_targets=only_from_a_fresh_observation`, limits.authorityChars),
  }
}

function executorFactRecords(facts, plan, step, limits) {
  if (!facts || typeof facts !== 'object') return []
  const records = []
  if (plan && step) records.push(authorityRecord(plan, step, limits))
  records.push(...countsRecords(facts.counts, limits))
  const machine = machineRecord(facts.machine, limits)
  if (machine) records.push(machine)
  const residual = residualRecord(facts.residual, limits)
  if (residual) records.push(residual)
  asList(facts.recipes).slice(0, limits.recipes).forEach((fact, index) => {
    records.push({ key: `recipe_fact_${index}`, block: 'step', drop: 'recipe_facts', rank: index, text: recipeFactLine(fact, limits.recipeChars) })
  })
  const historical = historicalRecord(facts.historical_entities, limits)
  if (historical) records.push(historical)
  return records
}

// What an executor-facts packet carried after size control, for the trace row.
function executorFactsSummary(facts, kept) {
  const keys = new Set(kept.map(record => record.key))
  const counts = asList(facts?.counts?.items)
  return {
    recipe_facts: kept.filter(record => record.key.startsWith('recipe_fact_')).length,
    fresh_items: keys.has('held_counts') ? counts.filter(entry => entry.state === 'fresh').length : 0,
    stale_items: keys.has('held_counts_stale') ? counts.filter(entry => entry.state === 'stale').length + asList(facts?.counts?.unavailable).length : 0,
    residual_needs: keys.has('residual_needs') ? asList(facts?.residual?.rows).length : 0,
    machine: keys.has('checkpoint_machine') ? (facts?.machine?.state ?? 'none') : 'none',
    historical_entity_kinds: keys.has('historical_entities') ? asList(facts?.historical_entities).length : 0,
  }
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
 * @param {object} [args.executorFacts] D2: harness-read facts for a fresh executor ({recipes, counts, machine, residual, historical_entities}); each record is labelled fresh, stale or historical
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
