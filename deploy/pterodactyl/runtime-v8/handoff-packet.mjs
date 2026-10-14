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
  // Unit 8: the energy and fuel facts drop before the residual (the production target and its arithmetic) they annotate.
  'machine_energy',
  'fuel_needs',
  // Unit 14: a placed machine's own inventories (fuel, source, output). They outlast the machine_energy annotation because they
  // are the live state the step acts on, and drop before the residual arithmetic.
  'placed_machines',
  'residual_needs',
  // Intentionally after residual_needs (unit 6): acquisition is its own record so the raw-leaf mining sources and nearest
  // locations survive a long intermediate chain being dropped from the arithmetic.
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
  // Unit 9: the count-read cap sizes itself from the step's recipe closure (a steam-power build bill is about 15 items), up to this
  // bound; whatever a closure larger than the bound leaves unread is reported, never silently absent.
  countItemsMax: 32,
  countChars: 720,
  machineChars: 480,
  residualRows: 24,
  residualChars: 1400,
  acquisitionChars: 1200,
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
  // Unit 9: a build or science bill is a whole recipe closure (a steam-power build reaches 15 items), so a handoff for such a step may
  // spend more recipe reads; still bounded, and the cut is still reported.
  recipePrefetchReadsBill: 24,
  noRecipeItems: 32,
  // Unit 6: raw leaves (items a resource prototype mines) are remembered with their mining sources, and the harness reads the
  // nearest instance of at most `rawLeafResources` distinct resources per handoff, within `rawLeafRadius` tiles.
  rawLeafResources: 3,
  rawLeafRadius: 1024,
  rawLeafMinedFrom: 4,
  // Unit 8: machine energy sources and the fuel a burner needs. The fuel list is the mod's own bounded answer (6 items).
  machineEnergyChars: 560,
  fuelItems: 6,
  fuelChars: 780,
  placedKinds: 64,
  // Unit 14: placed crafting machines (furnaces, assemblers) whose own fuel/source/output inventories ride in the packet.
  placedMachines: 3,
  placedMachineChars: 900,
  fuelSourceCache: 16,
  // Unit 9: entity_count prototypes whose placing item the harness resolves per handoff, natural harvest sources carried per
  // raw leaf, and the lab prototypes a science residual names as its consumer.
  buildPrototypes: 8,
  rawLeafHarvestedFrom: 4,
  labCandidates: 4,
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
    const subject = requirement.item_name ?? requirement.entity_name ?? requirement.prototype ?? requirement.operation_name ?? ''
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

// The energy source kinds the mod reports for a machine prototype (production_rates.ts energy_facts). Anything else is unknown.
const MACHINE_ENERGY_SOURCES = new Set(['burner', 'electric', 'heat', 'fluid', 'void', 'other'])

/** Per-machine native energy source facts out of a recipe's crafting_machines entries: bounded, name-checked, no guessing. */
function normalizeMachineEnergy(raw, limits) {
  return asList(raw).slice(0, limits.recipeMachines).flatMap((entry) => {
    const name = factName(entry?.name)
    // A machine whose answer carries no known energy source adds no record: the derivation then says `unknown`, never a guess.
    if (!name || !MACHINE_ENERGY_SOURCES.has(entry.energy_source)) return []
    const watts = finiteNumber(entry.energy_watts)
    const fuelCategories = [...new Set(asList(entry.fuel_categories).map(factName).filter(Boolean))].slice(0, 4)
    const item = factName(entry.item ?? entry.placed_by_item)
    return [{
      name,
      energy_source: entry.energy_source,
      ...(fuelCategories.length > 0 ? { fuel_categories: fuelCategories } : {}),
      ...(watts !== undefined && watts >= 0 ? { energy_watts: watts } : {}),
      ...(item ? { item } : {}),
    }]
  })
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
  const machineEnergy = normalizeMachineEnergy(raw.machine_energy, limits)
  return {
    name,
    ...(raw.applicability ? { applicability: recipeApplicability(raw.applicability) } : {}),
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(typeof raw.hidden_from_player_crafting === 'boolean' ? { hidden_from_player_crafting: raw.hidden_from_player_crafting } : {}),
    ...(typeof raw.hand_craftable_category === 'boolean' ? { hand_craftable_category: raw.hand_craftable_category } : {}),
    ...(typeof raw.allow_as_intermediate === 'boolean' ? { allow_as_intermediate: raw.allow_as_intermediate } : {}),
    ...(typeof raw.allow_intermediates === 'boolean' ? { allow_intermediates: raw.allow_intermediates } : {}),
    categories: [...new Set(asList(raw.categories).map(factName).filter(Boolean))].slice(0, 6),
    ...(energy !== undefined ? { energy } : {}),
    // The live game's own answer to "can the character hand-craft this recipe's category" (getRecipeDetails
    // hand_craftable_category). Absent when the read did not say: the batch stock ledger then does not assume either way.
    ...(typeof raw.hand_craftable === 'boolean' ? { hand_craftable: raw.hand_craftable } : {}),
    ingredients: ingredients.slice(0, limits.recipeIngredients),
    products: products.slice(0, limits.recipeProducts),
    machines: machines.slice(0, limits.recipeMachines),
    machines_truncated: machines.length > limits.recipeMachines || raw.machines_truncated === true,
    ...(machineEnergy.length > 0 ? { machine_energy: machineEnergy } : {}),
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
      allow_as_intermediate: entry?.allow_as_intermediate,
      allow_intermediates: entry?.allow_intermediates,
      energy: entry?.energy,
      categories: entry?.categories,
      hand_craftable: entry?.hand_craftable_category,
      ingredients: entry?.ingredients,
      products: entry?.products,
      machines: asList(entry?.crafting_machines),
      machine_energy: asList(entry?.crafting_machines),
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
    hand_craftable: facts?.hand_craftable === false ? false : undefined,
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
    ...(incoming.machine_energy === undefined && existing.machine_energy !== undefined ? { machine_energy: existing.machine_energy } : {}),
    ...(incoming.hand_craftable === undefined && existing.hand_craftable !== undefined ? { hand_craftable: existing.hand_craftable } : {}),
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
  const builds = []
  for (const requirement of requirements) {
    const technology = requirement.kind === 'research_completed' ? factName(requirement.technology) : undefined
    if (technology && !technologies.includes(technology)) technologies.push(technology)
    // Unit 9: a build step (entity_count) is met by placed entities. Its need is the prototype's placing item, times how many are
    // still missing; the harness resolves both. Only a mode `all` contract names definite builds.
    const prototype = requirement?.kind === 'entity_count' ? factName(requirement.prototype) : undefined
    if (prototype && contract.mode === 'all' && Number.isSafeInteger(requirement.minimum) && requirement.minimum > 0 && builds.length < EXECUTOR_FACT_LIMITS.buildPrototypes
      && !builds.some(build => build.id === requirement.id)) {
      builds.push({
        id: requirement.id, prototype, minimum: requirement.minimum,
        ...(Number.isSafeInteger(requirement.radius) ? { radius: requirement.radius } : {}),
        ...(requirement.anchor && Number.isFinite(requirement.anchor.x) && Number.isFinite(requirement.anchor.y) ? { anchor: { x: requirement.anchor.x, y: requirement.anchor.y } } : {}),
        ...(typeof requirement.state === 'string' ? { state: requirement.state } : {}),
      })
    }
    const item = factName(requirement?.item_name)
    if (!item) continue
    if (!items.includes(item)) items.push(item)
    if (contract.mode === 'all' && requirement.kind === 'inventory_count' && Number.isSafeInteger(requirement.minimum) && requirement.minimum > 0) {
      const existing = roots.find(root => root.item === item)
      if (existing) existing.count = Math.max(existing.count, requirement.minimum)
      else roots.push({ item, count: requirement.minimum })
    }
  }
  return { roots, items, ...(technologies.length ? { technologies } : {}), ...(builds.length ? { builds } : {}) }
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
    // Unit 9 (crafted_items.ts credit_craft_trigger_statistics): a completed craft is credited to a craft-item trigger only while the
    // technology is enabled and every prerequisite is researched. With any prerequisite unresolved, or the technology disabled, a craft
    // now counts for nothing. `enabled: false` is carried from the same getResearchPath node.
    const craftTrigger = node.mode === 'trigger' && node.researched === false && node.research_trigger?.type === 'craft-item'
    const notCredited = craftTrigger && asList(node.unresolved_prerequisites).length > 0
    const disabled = craftTrigger && node.enabled === false
    selected.push({ name: node.name, researched: node.researched, mode: node.mode, status: node.status,
      prerequisites: node.prerequisites, unresolved_prerequisites: node.unresolved_prerequisites,
      ...(node.research_trigger ? { research_trigger: node.research_trigger } : {}),
      ...(notCredited ? { credited_only_after_prerequisites: true } : {}),
      ...(disabled ? { enabled: false } : {}),
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
export function expandableRecipe(item, recipes) {
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

/**
 * The raw-leaf declaration of a parsed getRecipeDetails answer: `{ item, mined_from, harvested_from? }`, or undefined when it has
 * neither. `mined_from` names the resource prototypes that mine into the item; `harvested_from` (unit 9) names the natural trees and
 * rocks the harvest operation mines for it (wood from trees). `harvested_from` is present only when the answer listed some.
 */
export function rawLeafFromRecipeDetails(parsed, limits = EXECUTOR_FACT_LIMITS) {
  if (!parsed || typeof parsed !== 'object') return undefined
  if (!(parsed.found === true || (parsed.found === false && parsed.code === 'no_recipe'))) return undefined
  const item = factName(parsed.query)
  if (!item) return undefined
  const minedFrom = [...new Set(asList(parsed.mined_from).map(factName).filter(Boolean))].slice(0, limits.rawLeafMinedFrom)
  const harvestedFrom = [...new Set(asList(parsed.harvested_from).map(factName).filter(Boolean))].slice(0, limits.rawLeafHarvestedFrom)
  if (minedFrom.length === 0 && harvestedFrom.length === 0) return undefined
  return { item, mined_from: minedFrom, ...(harvestedFrom.length > 0 ? { harvested_from: harvestedFrom } : {}) }
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
export function rawLeafSourceFromRead(raw, resource, radius, { harvest = false } = {}) {
  let parsed
  try { parsed = typeof raw === 'string' ? JSON.parse(raw) : raw }
  catch { return { resource, state: 'failed' } }
  if (!parsed || typeof parsed !== 'object' || parsed.ok === false || parsed.error !== undefined) return { resource, state: 'failed' }
  if (parsed.name !== resource || parsed.max_radius !== radius || !Number.isFinite(parsed.searched_radius) || parsed.searched_radius < 1 || parsed.searched_radius > radius) return { resource, state: 'failed' }
  const nearest = Array.isArray(parsed.entities) ? parsed.entities[0] : undefined
  // A mining source is a resource entity; a harvest source (unit 9) is a natural non-resource entity (tree, rock).
  const typeOk = harvest ? typeof nearest?.type === 'string' && nearest.type !== 'resource' : nearest?.type === 'resource'
  if (parsed.found === true && parsed.returned_count === 1 && Array.isArray(parsed.entities) && parsed.entities.length === 1 && parsed.matched_count >= 1 && nearest?.name === resource && typeOk) {
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

/**
 * The acquisition clause of a residual row: how the raw leaf is natively acquired and where the nearest source was last read.
 * `raw: mined_from=...` for resources; `harvest: harvested_from=...` (unit 9) for the natural trees and rocks the harvest operation
 * mines. Both clauses appear when an item has both sources.
 */
export function rawLeafRowText(raw) {
  const sources = asList(raw?.sources)
  const harvestSources = asList(raw?.harvest_sources)
  const minedFrom = asList(raw?.mined_from)
  const harvestedFrom = asList(raw?.harvested_from)
  if (minedFrom.length === 0 && harvestedFrom.length === 0) return ''
  const read = [...sources, ...harvestSources].some(source => source.state !== 'not_read')
  return [
    ...(minedFrom.length > 0 ? [
      `raw: mined_from=${minedFrom.join(',')} (source observation; reach/path unverified)`,
      ...sources.map(source => rawSourceText(source, minedFrom.length > 1)),
    ] : []),
    ...(harvestedFrom.length > 0 ? [
      `harvest: harvested_from=${harvestedFrom.join(',')} (source observation; reach/path unverified)`,
      ...harvestSources.map(source => rawSourceText(source, harvestedFrom.length > 1)),
    ] : []),
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
  return { items: order.slice(0, limit), complete: order.length <= limit, omitted: order.slice(limit) }
}

/**
 * Residual needs of one step: per needed item the required amount, the held amount and what is still missing, with
 * shared stock (an item two consumers need is accumulated once and the held amount is taken once) and recipe output
 * quantities (a recipe yielding two per craft needs half the crafts). Returns `{ ok: true, rows }`, or
 * `{ ok: false, reason }` when an input is unknown: it never guesses. `held` is a Map of fresh counts.
 */
export function deriveResidualNeeds({ roots, recipes, held, production = [] }) {
  const rootList = Array.isArray(roots) ? roots : []
  const targets = Array.isArray(production) ? production : []
  if (rootList.length === 0 && targets.length === 0) return { ok: false, reason: 'no_contract_roots' }
  const facts = Array.isArray(recipes) ? recipes : []
  // Production targets (a research trigger's craft-item count) are met by NEW crafts only: held stock of the target item is
  // shown but never netted against it. The recipe that makes the target still asks for its ingredients, and those are
  // ordinary needs: they net against held stock like any other.
  const targetRows = []
  const targetDemand = new Map()
  const usedByTargets = new Set()
  for (const target of targets) {
    const count = held instanceof Map ? held.get(target.item) : undefined
    const row = { item: target.item, required: target.count, ...(Number.isSafeInteger(count) && count >= 0 ? { held: count } : {}), missing: target.count,
      trigger: { technology: target.technology, held_counted: false, ...(target.status ? { status: target.status } : {}),
        ...(target.credited_only_after_prerequisites === true ? { credited_only_after_prerequisites: true, unresolved_prerequisites: asList(target.unresolved_prerequisites) } : {}),
        ...(target.technology_disabled === true ? { technology_disabled: true } : {}) } }
    const expansion = expandableRecipe(target.item, facts)
    if (expansion) {
      if (usedByTargets.has(expansion.recipe.name)) return { ok: false, reason: `shared_recipe:${expansion.recipe.name}` }
      usedByTargets.add(expansion.recipe.name)
      row.crafts = Math.ceil(target.count / expansion.output)
      row.recipe = expansion.recipe.name
      for (const ingredient of expansion.recipe.ingredients) targetDemand.set(ingredient.name, (targetDemand.get(ingredient.name) ?? 0) + row.crafts * ingredient.amount)
    }
    targetRows.push(row)
  }
  // Reachable graph through expandable recipes, in dependency order (consumers before their ingredients).
  const edges = new Map()
  const expansions = new Map()
  const visit = [...rootList.map(root => root.item), ...targetDemand.keys()]
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
  const used = new Set(usedByTargets)
  for (const expansion of expansions.values()) {
    if (!expansion) continue
    if (used.has(expansion.recipe.name)) return { ok: false, reason: `shared_recipe:${expansion.recipe.name}` }
    used.add(expansion.recipe.name)
  }
  const demand = new Map(targetDemand)
  // Unit 9: a root may carry what it is for (a build step's placing item, a research's science packs). The row keeps it, so the
  // residual states the purpose next to the arithmetic.
  const purposes = new Map()
  for (const root of rootList) {
    demand.set(root.item, (demand.get(root.item) ?? 0) + root.count)
    if (root.build || root.science) purposes.set(root.item, { ...purposes.get(root.item), ...(root.build ? { build: root.build } : {}), ...(root.science ? { science: root.science } : {}) })
  }
  const rows = []
  for (const item of order) {
    const required = demand.get(item) ?? 0
    if (required <= 0) continue
    const count = held instanceof Map ? held.get(item) : undefined
    if (!Number.isSafeInteger(count) || count < 0) return { ok: false, reason: `held_unknown:${item}` }
    const missing = Math.max(0, required - count)
    const row = { item, required, held: count, missing, ...purposes.get(item) }
    const expansion = expansions.get(item)
    if (expansion && missing > 0) {
      const crafts = Math.ceil(missing / expansion.output)
      row.crafts = crafts
      row.recipe = expansion.recipe.name
      for (const ingredient of expansion.recipe.ingredients) demand.set(ingredient.name, (demand.get(ingredient.name) ?? 0) + crafts * ingredient.amount)
    }
    rows.push(row)
  }
  return { ok: true, rows: [...targetRows, ...rows] }
}

/**
 * The production roots of an active step whose contract is a research completion: for each fresh getResearchPath whose target
 * node is a not-yet-researched trigger technology with a craft-item trigger, the item and the count the engine counts.
 *
 * Engine semantics (Factorio 2.0.77, established from this repository's evidence, not assumed):
 *  - The craft-item trigger completes from the force item PRODUCTION STATISTICS flow of the item, not from inventory
 *    contents. A furnace's smelted output enters those statistics natively (trigger-ladder lane: the technology completed
 *    only after the furnace's products_finished reached the count); a standalone character's completed hand craft is
 *    credited by the mod's completion bridge (crafted_items.ts), and only while the technology is ready.
 *  - No historical backfill is performed, and no repository test or note shows stock that is merely held being credited.
 * So `held_counted` is false: held stock of the item is not netted against the count. If a future measurement shows
 * otherwise, this is the one place that changes.
 */
export function triggerProductionRoots(research, limits = EXECUTOR_FACT_LIMITS) {
  const roots = []
  for (const path of asList(research)) {
    if (path?.state !== 'fresh') continue
    const node = asList(path.nodes).find(entry => entry?.name === path.target)
    const trigger = node?.research_trigger
    if (!node || node.researched !== false || node.mode !== 'trigger' || trigger?.type !== 'craft-item') continue
    const item = factName(trigger.item)
    if (!item || !Number.isSafeInteger(trigger.count) || trigger.count < 1) continue
    if (trigger.item_quality !== undefined && trigger.item_quality !== 'normal') continue
    if (roots.some(root => root.item === item && root.technology === path.target)) continue
    roots.push({ item, count: trigger.count, technology: path.target, held_counted: false, ...(typeof node.status === 'string' && node.status ? { status: oneLine(node.status, 40) } : {}),
      // Unit 9: a craft is credited only while every prerequisite is researched; the root says so when some is not.
      ...(node.credited_only_after_prerequisites === true ? { credited_only_after_prerequisites: true, unresolved_prerequisites: asList(node.unresolved_prerequisites).map(factName).filter(Boolean).slice(0, 4) } : {}),
      ...(node.enabled === false ? { technology_disabled: true } : {}) })
  }
  return roots.slice(0, limits.researchTargets)
}

// --- Build bills and science residuals (unit 9) ------------------------------------------------------------------------
//
// A build step's contract is "N entities of prototype X exist" (entity_count). What it asks the actor to HAVE is the prototype's
// placing item, N minus what is already placed times the count one placement consumes; the mod's getPrototypeDetails names that
// item. A science research step's contract is research_completed for a technology whose unit cost is count x ingredients; what
// it asks the actor to have is the packs, less the progress the force already made. Both become ordinary roots of the recipe
// closure and the residual derivation. Nothing here names an item or an entity.

/** The placing item of an entity prototype out of a parsed getPrototypeDetails answer: `{ prototype, item, count }` or `{ prototype, unresolved }`. */
export function placingItemFromDetails(parsed, prototype) {
  const unresolved = reason => ({ prototype, unresolved: reason })
  if (!parsed || typeof parsed !== 'object' || parsed.found !== true) return unresolved('prototype_read_failed')
  const entity = parsed.entity
  if (!entity || typeof entity !== 'object' || entity.name !== prototype) return unresolved('not_an_entity_prototype')
  const items = asList(entity.place_items).map(entry => ({ name: factName(entry?.name), count: entry?.count })).filter(entry => entry.name)
  if (items.length === 0) return unresolved('no_placing_item')
  if (items.length > 1) return unresolved('several_placing_items')
  const count = Number.isSafeInteger(items[0].count) && items[0].count >= 1 ? items[0].count : undefined
  return count ? { prototype, item: items[0].name, count } : unresolved('placing_item_count_unreadable')
}

/** An observed placed count out of a parsed entity_count condition answer, or undefined (never zero for an unreadable answer). */
export function placedCountFromRead(parsed, prototype) {
  if (!parsed || parsed.ok !== true || parsed.kind !== 'entity_count' || parsed.prototype !== prototype) return undefined
  return Number.isSafeInteger(parsed.current) && parsed.current >= 0 ? parsed.current : undefined
}

/**
 * The bill of a build step: per entity_count requirement the placing item times the entities still missing. `placing` is a Map of
 * prototype to a placingItemFromDetails result, `placed` a Map of requirement id to the observed placed count (absent: unknown, and
 * then the whole minimum is the need). Returns `{ roots, rows, unresolved }`; a prototype whose placing item is unknown is listed
 * in `unresolved` with the reason, never guessed.
 */
export function deriveBuildBill({ builds, placing = new Map(), placed = new Map(), stateCounts = new Map() }) {
  const roots = []
  const rows = []
  const unresolved = []
  for (const build of asList(builds)) {
    const resolved = placing.get(build.prototype)
    if (!resolved || resolved.unresolved) {
      unresolved.push({ prototype: build.prototype, reason: resolved?.unresolved ?? 'placing_item_not_read' })
      continue
    }
    const have = placed.get(build.id)
    // An unread placed count is not guessed (the whole minimum would add items for entities that may already stand): the prototype is
    // left out of the bill and named, as every other unread count is not turned into a derived quantity.
    if (!Number.isSafeInteger(have) || have < 0) {
      unresolved.push({ prototype: build.prototype, reason: 'placed_count_unread' })
      continue
    }
    const remaining = Math.max(0, build.minimum - have)
    // `placed` counts the entities that stand, whatever their state; the state scope (working, powered) is a separate read fact.
    const stateCount = build.state && Number.isSafeInteger(stateCounts.get(build.id)) ? stateCounts.get(build.id) : undefined
    const stateNote = build.state ? { state: build.state, ...(stateCount !== undefined ? { state_count: stateCount } : {}) } : {}
    rows.push({ prototype: build.prototype, item: resolved.item, per_entity: resolved.count, minimum: build.minimum, placed: have, remaining, ...stateNote })
    if (remaining < 1) continue
    const count = remaining * resolved.count
    const existing = roots.find(root => root.item === resolved.item)
    const note = { prototype: build.prototype, minimum: build.minimum, remaining, placed: have, ...stateNote }
    if (existing) { existing.count += count; existing.build = { ...existing.build, remaining: existing.build.remaining + remaining } }
    else roots.push({ item: resolved.item, count, build: note })
  }
  return { roots, rows, unresolved }
}

/**
 * The science research targets of the active step: fresh getResearchPath facts whose target node is a not-yet-researched science
 * technology with a complete unit cost (a count and every ingredient amount). Bounded by `researchTargets`.
 */
export function scienceTargets(research, limits = EXECUTOR_FACT_LIMITS) {
  const targets = []
  for (const path of asList(research)) {
    if (path?.state !== 'fresh') continue
    const node = asList(path.nodes).find(entry => entry?.name === path.target)
    const science = node?.science
    if (!node || node.researched !== false || node.mode !== 'science' || !science || science.ingredients_truncated === true) continue
    const units = science.count
    if (!Number.isSafeInteger(units) || units < 1) continue
    const ingredients = asList(science.ingredients).map(entry => ({ item: factName(entry?.name), amount: entry?.amount }))
    if (ingredients.length === 0 || ingredients.some(entry => !entry.item || !Number.isSafeInteger(entry.amount) || entry.amount < 1)) continue
    if (targets.some(target => target.technology === path.target)) continue
    targets.push({ technology: path.target, units, ingredients,
      ...(asList(node.unresolved_prerequisites).length > 0 ? { unresolved_prerequisites: asList(node.unresolved_prerequisites).map(factName).filter(Boolean).slice(0, 4) } : {}) })
  }
  return targets.slice(0, limits.researchTargets)
}

/**
 * The research progress fraction (0..1) out of a parsed getTechnology answer for that technology, or undefined when it is not reported.
 * Uses the answer's `progress` (the mod reads LuaForce.research_progress for the current research and saved_progress for any other);
 * `saved_progress` alone is never used, because for the current research it is not the progress made.
 */
export function scienceProgressFromRead(parsed, technology) {
  if (!parsed || typeof parsed !== 'object' || parsed.found !== true || parsed.name !== technology || parsed.researched === true) return undefined
  const progress = parsed.progress
  return finiteNumber(progress) !== undefined && progress >= 0 && progress <= 1 ? progress : undefined
}

/**
 * The packs a science research still needs: units x each ingredient amount, less the progress already made. `progress` is a Map of
 * technology to the fraction read from the live game; a technology without an entry has unknown progress and is NOT netted (the
 * whole unit cost is the need). `consumers` names the lab prototypes the packs are consumed in. Returns `{ technology, ...,
 * roots }`, one root per ingredient with a count above zero.
 */
export function scienceProductionRoots(targets, progress = new Map(), consumers = []) {
  return asList(targets).map((target) => {
    const done = progress instanceof Map ? progress.get(target.technology) : undefined
    const known = finiteNumber(done) !== undefined
    const remaining = known ? Math.max(0, Math.ceil(target.units * (1 - done) - 1e-9)) : target.units
    const packs = target.ingredients.map(entry => ({ item: entry.item, amount: entry.amount, count: remaining * entry.amount }))
    const science = { technology: target.technology, units: target.units, remaining_units: remaining, progress_known: known,
      ...(known ? { progress: Math.round(done * 1000) / 1000 } : {}), consumers: asList(consumers).slice(0, 4) }
    return { technology: target.technology, units: target.units, remaining_units: remaining, progress_known: known,
      ...(known ? { progress: science.progress } : {}), packs, unresolved_prerequisites: target.unresolved_prerequisites,
      roots: packs.filter(pack => pack.count > 0).map(pack => ({ item: pack.item, count: pack.count, science: { ...science, amount: pack.amount } })) }
  })
}

/** The lab candidates out of a parsed discoverPrototypes (entity-type lab) answer, or undefined when the answer is not that read. */
export function labCandidatesFromRead(parsed, limits = EXECUTOR_FACT_LIMITS) {
  if (!parsed || parsed.ok !== true || parsed.query?.capability !== 'entity-type' || parsed.query?.entity_type !== 'lab' || !Array.isArray(parsed.candidates)) return undefined
  return parsed.candidates.slice(0, limits.labCandidates).flatMap((entry) => {
    const name = factName(entry?.name)
    if (!name || entry.type !== 'lab') return []
    const items = asList(entry.place_items).map(item => factName(item?.name)).filter(Boolean)
    const heldCount = Number.isSafeInteger(entry.held_count) && entry.held_count >= 0 ? entry.held_count : 0
    return [{ name, energy_source: MACHINE_ENERGY_SOURCES.has(entry.energy_source) ? entry.energy_source : 'unknown',
      ...(items.length === 1 ? { item: items[0] } : {}), enabled_recipe: typeof entry.enabled_recipe === 'string', held_count: heldCount }]
  })
}

/**
 * The labs, as machine_energy entries: native energy source, the item that places them, a fresh held count when the harness read
 * one, and whether an instance was observed placed. The consuming machine of research packs; `consumes` says so.
 */
export function labMachineEntries({ candidates, held = new Map(), placed = new Map() }) {
  return asList(candidates).map((entry) => {
    const count = entry.item && held instanceof Map ? held.get(entry.item) : undefined
    const seen = placed instanceof Map ? placed.get(entry.name) : undefined
    return { name: entry.name, energy_source: entry.energy_source, ...(entry.item ? { item: entry.item } : {}),
      status: entry.enabled_recipe ? 'craftable' : entry.held_count > 0 ? 'held' : 'available',
      held: Number.isSafeInteger(count) && count >= 0 ? count : undefined,
      placed: seen ? { observed: true, count: seen.count, via: seen.via } : { observed: false }, consumes: 'research_packs' }
  })
}

/** machine_energy with the labs appended (they are not crafting machines of any recipe, so the recipe derivation never lists them). */
export function withLabEnergy(machineEnergy, labs) {
  const entries = asList(labs)
  if (entries.length === 0) return machineEnergy
  if (!machineEnergy) return { machines: entries, omitted: { locked: 0, unverified: 0, unread: 0, truncated: 0 }, burner_count: 0, fuel_categories: [] }
  return { ...machineEnergy, machines: [...machineEnergy.machines, ...entries] }
}

/** The names of the recipes a derivation expands the given items with (the same single recipe `expandableRecipe` picks). */
export function expansionRecipeNames(items, recipes) {
  return [...new Set(asList(items).flatMap((item) => {
    const expansion = expandableRecipe(item, asList(recipes))
    return expansion ? [expansion.recipe.name] : []
  }))]
}

// --- Machine energy and burner fuel (unit 8) -------------------------------------------------------------------------
//
// Which energy source each candidate machine of a recipe has (electric, burner with fuel categories, void, ...) is read from
// the machine's own prototype by the mod. Here that is joined with what the harness knows about availability (a
// craftable/locked status from the requirements read, a fresh held count, an observed placed instance) and, for a burner,
// with the fuel items the mod reported for its categories. Nothing names an item, recipe or machine.

/** Fuel items out of a parsed getRecipeDetails answer: `[{ name, category, fuel_value, mined_from }]`, bounded, or []. */
export function burnerFuelsFromDetails(parsed, limits = EXECUTOR_FACT_LIMITS) {
  if (!parsed || typeof parsed !== 'object' || parsed.found !== true || !parsed.burner_fuels || typeof parsed.burner_fuels !== 'object') return []
  return asList(parsed.burner_fuels.items).slice(0, limits.fuelItems).flatMap((entry) => {
    const name = factName(entry?.name)
    const category = factName(entry?.category)
    const value = finiteNumber(entry?.fuel_value)
    if (!name || !category || value === undefined || !(value > 0)) return []
    const minedFrom = [...new Set(asList(entry.mined_from).map(factName).filter(Boolean))].slice(0, limits.rawLeafMinedFrom)
    const harvestedFrom = [...new Set(asList(entry.harvested_from).map(factName).filter(Boolean))].slice(0, limits.rawLeafHarvestedFrom)
    return [{ name, category, fuel_value: value, mined_from: minedFrom, ...(harvestedFrom.length > 0 ? { harvested_from: harvestedFrom } : {}) }]
  })
}

/** Machine statuses the requirements reads reported: Map of entity to { item, status }. A craftable report is never downgraded. */
export function machineStatusesFrom({ triggerReports = [], requirementMachines = new Map() } = {}) {
  const statuses = new Map()
  const note = (entity, item, status) => {
    const name = factName(entity)
    if (!name || !['craftable', 'locked', 'no_recipe'].includes(status)) return
    const known = statuses.get(name)
    if (known?.status === 'craftable' && status !== 'craftable') return
    statuses.set(name, { item: factName(item) ?? known?.item, status })
  }
  for (const report of asList(triggerReports)) {
    for (const recipe of asList(report?.recipes)) for (const machine of asList(recipe?.machines)) note(machine?.entity, machine?.item, machine?.status)
  }
  for (const entry of requirementMachines instanceof Map ? requirementMachines.values() : []) {
    for (const option of asList(entry?.options)) note(option?.entity, option?.item, option?.status)
  }
  return statuses
}

/**
 * The candidate machines of the given recipes that are available to the actor, with their native energy source.
 * A machine is listed when the requirements read called it craftable, or the actor holds one, or an instance was observed
 * placed; locked and unverified machines are only counted. `held` is a Map of fresh counts (a machine item without a fresh
 * count has held undefined, never zero); `placed` is a Map of entity name to { count, via }.
 */
export function deriveMachineEnergy({ recipes, recipeNames, statuses = new Map(), held = new Map(), placed = new Map(), limits = EXECUTOR_FACT_LIMITS }) {
  const entries = new Map()
  for (const recipeName of asList(recipeNames)) {
    const fact = asList(recipes).find(recipe => recipe.name === recipeName)
    if (!fact) continue
    const energy = new Map(asList(fact.machine_energy).map(entry => [entry.name, entry]))
    for (const machine of asList(fact.machines)) {
      if (!entries.has(machine)) entries.set(machine, { name: machine, ...(energy.get(machine) ?? { energy_source: 'unknown' }) })
    }
  }
  const listed = []
  let locked = 0
  let unverified = 0
  let unread = 0
  for (const entry of entries.values()) {
    const status = statuses.get(entry.name)
    const item = status?.item ?? entry.item
    const count = item && held instanceof Map ? held.get(item) : undefined
    const seen = placed instanceof Map ? placed.get(entry.name) : undefined
    const craftable = status?.status === 'craftable'
    if (!craftable && !(count > 0) && !seen) {
      if (status?.status === 'locked') locked += 1
      // The machine item is known but its count was not read (the count-read list is capped): reported, never silently absent.
      else if (item && count === undefined) unread += 1
      else unverified += 1
      continue
    }
    listed.push({ ...entry, ...(item ? { item } : {}), status: status?.status ?? 'unknown',
      held: Number.isSafeInteger(count) && count >= 0 ? count : undefined,
      placed: seen ? { observed: true, count: seen.count, via: seen.via } : { observed: false } })
  }
  listed.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  // Nothing available to the actor means nothing to carry; the recipe fact still names the candidate machines.
  if (listed.length === 0) return undefined
  const machines = listed.slice(0, limits.recipeMachines)
  const burners = machines.filter(entry => entry.energy_source === 'burner')
  return { machines, omitted: { locked, unverified, unread, truncated: listed.length - machines.length },
    burner_count: burners.length,
    fuel_categories: [...new Set(burners.flatMap(entry => asList(entry.fuel_categories)))].sort() }
}

/** The fuel a set of burner machines needs: candidates from the mod's fuel list for their categories, with fresh held counts. */
export function deriveFuelNeeds({ machineEnergy, fuels, held = new Map(), limits = EXECUTOR_FACT_LIMITS }) {
  const burners = asList(machineEnergy?.machines).filter(entry => entry.energy_source === 'burner')
  if (burners.length === 0) return undefined
  const categories = machineEnergy.fuel_categories
  // A fuel with a natural source (mined or harvested) outranks one with none, then name order.
  const sourced = fuel => fuel.mined_from?.length > 0 || fuel.harvested_from?.length > 0
  const ordered = asList(fuels).filter(fuel => categories.includes(fuel.category))
    .sort((left, right) => (sourced(right) - sourced(left)) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  const items = ordered.slice(0, limits.fuelItems).map((fuel) => {
    const count = held instanceof Map ? held.get(fuel.name) : undefined
    return { name: fuel.name, category: fuel.category, fuel_value: fuel.fuel_value, mined_from: fuel.mined_from,
      ...(fuel.harvested_from?.length > 0 ? { harvested_from: fuel.harvested_from } : {}),
      held: Number.isSafeInteger(count) && count >= 0 ? count : undefined }
  })
  const heldTotal = items.reduce((sum, item) => sum + (item.held ?? 0), 0)
  const unknownHeld = items.filter(item => item.held === undefined).length
  // A source search is only warranted when every candidate count was read and the total is zero: any unread count means
  // the actor may hold fuel, which is stated as unknown and never turned into a search.
  const search = items.length === 0 ? 'no_candidates' : heldTotal > 0 ? 'held' : unknownHeld > 0 ? 'unknown_counts' : 'needed'
  return { machines: burners.map(entry => entry.name), categories, items, held_total: heldTotal, unknown_held: unknownHeld, search }
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
  const items = asList(counts?.items).filter(entry => factName(entry?.item) && Number.isSafeInteger(entry.count)).slice(0, limits.countItemsMax)
  const fresh = items.filter(entry => entry.state === 'fresh')
  const stale = items.filter(entry => entry.state === 'stale')
  const unavailable = asList(counts?.unavailable).map(factName).filter(Boolean).slice(0, limits.countItemsMax)
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

const MACHINE_INVENTORY_LABELS = Object.freeze({ fuel: 'machine_fuel', input: 'machine_source', output: 'machine_output' })

function inventoryCountsText(counts) {
  const entries = Object.entries(counts && typeof counts === 'object' && !Array.isArray(counts) ? counts : {})
    .filter(([name, count]) => factName(name) && Number.isFinite(count))
  return entries.length > 0 ? `{${entries.map(([name, count]) => `${name}:${count}`).join(',')}}` : 'empty'
}

// The machines this harness saw placed, with their OWN fuel, source and output inventories (unit 14). The labels say whose inventory
// each is: held_counts and fuel_needs describe the ACTOR's stock, never a machine's. An empty inventory is stated as empty, an
// unread one is not listed, and the number of distinct item types in the source slot is a counted fact (no slot-size claim).
function placedMachinesRecord(placed, limits) {
  const entries = asList(placed).filter(entry => factName(entry?.name) && Number.isSafeInteger(entry.unit_number)).slice(0, limits.placedMachines)
  if (entries.length === 0) return undefined
  const parts = entries.map((entry) => {
    const inventories = entry.inventories && typeof entry.inventories === 'object' ? entry.inventories : {}
    const roles = ['fuel', 'input', 'output'].filter(role => inventories[role] !== undefined)
      .map(role => `${MACHINE_INVENTORY_LABELS[role]}=${inventoryCountsText(inventories[role])}`)
    const sourceTypes = inventories.input !== undefined ? ` source_item_types=${Object.keys(inventories.input).length}` : ''
    const state = entry.state === 'fresh' ? `FRESH as_of=${tagText(entry.as_of)}` : `STALE observed ${tagText(entry.as_of)}, NOT current${entry.reason ? `; ${entry.reason}` : ''}`
    return `${entry.name} unit=${entry.unit_number} [${state}] working=${entry.working === true}${roles.length > 0 ? ` ${roles.join(' ')}` : ''}${sourceTypes}`
  })
  return {
    key: 'placed_machines',
    block: 'step',
    drop: 'placed_machines',
    text: `placed_machines (machines this harness saw placed; machine_fuel, machine_source and machine_output are the MACHINE's own inventories, NOT the actor's held items in held_counts and fuel_needs; FRESH = live read now, STALE = earlier observation): ${joinBounded(parts, ' | ', limits.placedMachineChars)}`,
  }
}

// What a root is for, next to its arithmetic (unit 9): the build it places, or the research whose packs it is.
function rowPurposeText(row) {
  const parts = []
  if (row.build) {
    const state = row.build.state ? ` ${row.build.state}=${row.build.state_count ?? 'unknown'}` : ''
    parts.push(`[build ${row.build.prototype}: placed=${row.build.placed}${state} of ${row.build.minimum}, ${row.build.remaining} more to place]`)
  }
  if (row.science) {
    const consumers = asList(row.science.consumers)
    const progress = row.science.progress_known ? `research progress ${Math.round(row.science.progress * 100)}% netted` : 'research progress unknown, not netted'
    parts.push(`[science ${row.science.technology}: ${row.science.remaining_units} of ${row.science.units} units x${row.science.amount} per unit, ${progress}; consumed by ${consumers.length > 0 ? consumers.join(',') : 'labs (none listed)'}]`)
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : ''
}

// A trigger the craft is only credited to once its prerequisites are researched (crafted_items.ts) says so instead of presenting the craft as productive.
function triggerRowText(row) {
  const trigger = row.trigger
  const names = asList(trigger.unresolved_prerequisites).filter(Boolean)
  const why = [
    ...(trigger.credited_only_after_prerequisites === true ? [names.length > 0 ? `prerequisites ${names.join(',')} unresolved` : 'a prerequisite is unresolved'] : []),
    ...(trigger.technology_disabled === true ? ['technology disabled'] : []),
  ]
  const credit = why.length > 0
    ? `not ready: ${why.join(', ')}; crafts now are not credited; held stock not counted`
    // A research trigger counts NEW crafts: held stock of the item is shown for context, never netted against the count.
    : 'counts new crafts; held stock not counted'
  return `trigger craft-item ${row.item} count=${row.required} for ${trigger.technology} (${credit})${row.held !== undefined ? ` held=${row.held}` : ''}${trigger.status && trigger.status !== 'ready' ? ` tech_status=${trigger.status}` : ''}${row.crafts !== undefined ? ` crafts=${row.crafts} via ${row.recipe}` : ''}`
}

// Build prototypes whose placing item could not be resolved are named with the reason, not dropped from the bill silently.
function residualUnresolvedText(residual) {
  const unresolved = asList(residual?.unresolved_builds)
  return unresolved.length > 0 ? ` | build_unresolved (no placing item derived, not in this bill): ${unresolved.map(entry => `${entry.prototype}:${entry.reason}`).join(',')}` : ''
}

function residualRecord(residual, limits) {
  // A residual that could not be derived because the closure outgrew the count-read bound is stated with what is unread, never silently absent.
  if (residual?.omitted) {
    const omitted = residual.omitted
    const why = `${omitted.reason}: the step closure has ${omitted.closure_items} items, more than the ${omitted.cap} counts the harness reads`
    return { key: 'residual_needs', block: 'step', drop: 'residual_needs',
      text: `residual_needs (NOT derived, ${why}; unread: ${joinBounded(asList(omitted.unread), ',', limits.residualChars) || 'none listed'})` }
  }
  // Builds with a state scope (working, powered) that need nothing more placed: the entities stand, the state count is a read fact.
  const stateFacts = asList(residual?.build_states).map(row => `${row.prototype} placed=${row.placed} ${row.state}=${row.state_count ?? 'unknown'} of ${row.minimum}, ${row.remaining} more to place`)
  const stateText = stateFacts.length > 0 ? ` | build_state (read fact, not netted): ${stateFacts.join('; ')}` : ''
  if ((!residual?.rows || residual.rows.length === 0) && stateFacts.length > 0) {
    return { key: 'residual_needs', block: 'step', drop: 'residual_needs',
      text: `residual_needs (nothing left to acquire for the step contract builds; entities standing, state counts read now)${stateText}${residualUnresolvedText(residual)}` }
  }
  if (!residual?.rows || residual.rows.length === 0) return undefined
  const rows = residual.rows.slice(0, limits.residualRows).map(row => row.trigger
    ? triggerRowText(row)
    : `${row.item} required=${row.required} held=${row.held} missing=${row.missing}${row.crafts !== undefined ? ` crafts=${row.crafts} via ${row.recipe}` : ''}${rowPurposeText(row)}`)
  const rootLabel = root => root.build ? `build:${root.build.prototype}x${root.build.remaining}` : root.science ? `science:${root.item}x${root.count}` : `${root.item}>=${root.count}`
  const roots = [...asList(residual.roots).map(rootLabel), ...asList(residual.production).map(root => `trigger:${root.item}x${root.count}`)].join(',')
  return {
    key: 'residual_needs',
    block: 'step',
    drop: 'residual_needs',
    text: `residual_needs (derived from recipe_fact and fresh held_counts for the step contract ${roots}; shared stock counted once): ${joinBounded(rows, ' | ', limits.residualChars)}${stateText}${residualUnresolvedText(residual)}`,
  }
}

// Acquisition is separate from recipe arithmetic so long intermediate chains cannot truncate the raw leaves.
function acquisitionRecord(residual, limits) {
  const rows = asList(residual?.rows).filter(row => row.raw).map(row => `${row.item} missing=${row.missing} ${rawLeafRowText(row.raw)}`)
  if (!rows.length) return undefined
  return { key: 'raw_leaf_acquisition', block: 'step', drop: 'raw_leaf_acquisition',
    text: `raw_leaf_acquisition: ${joinBounded(rows, ' | ', limits.acquisitionChars)}` }
}

const kilowatts = watts => `${Math.round(watts / 100) / 10}kW`
const megajoules = joules => `${Math.round(joules / 10000) / 100}MJ`

function machineSourceText(entry) {
  const parts = []
  if (entry.energy_source === 'burner') parts.push(`fuel_categories=${asList(entry.fuel_categories).join('+') || 'unknown'}`)
  if (entry.energy_watts !== undefined) parts.push(kilowatts(entry.energy_watts))
  return `${entry.energy_source}${parts.length > 0 ? `(${parts.join(', ')})` : ''}`
}

// Native energy source and placement of the machines the step's recipes can run in (unit 8). Facts only: which machine to use,
// where to put it and how much fuel it needs stay the executor's decisions.
function machineEnergyRecord(machineEnergy, limits) {
  if (!machineEnergy) return undefined
  const machines = asList(machineEnergy.machines).map(entry => `${entry.name} energy=${machineSourceText(entry)} status=${entry.status} held=${entry.held ?? 'unknown'} placed=${entry.placed?.observed ? `observed(x${entry.placed.count} via ${entry.placed.via})` : 'not_observed'}${entry.consumes ? ` consumes=${entry.consumes}` : ''}`)
  const omitted = machineEnergy.omitted ?? {}
  const unlisted = [omitted.locked > 0 ? `locked=${omitted.locked}` : '', omitted.unverified > 0 ? `unverified=${omitted.unverified}` : '', omitted.unread > 0 ? `unread=${omitted.unread}` : '', omitted.truncated > 0 ? `truncated=${omitted.truncated}` : ''].filter(Boolean)
  return {
    key: 'machine_energy',
    block: 'step',
    drop: 'machine_energy',
    text: `machine_energy (native prototype energy source; held = fresh live count of the machine item; placed = whether this harness observed an instance via historical_entities or checkpoint_machine, history and not a current exact target): ${machines.length > 0 ? joinBounded(machines, ' | ', limits.machineEnergyChars) : 'no available machine listed'}${unlisted.length > 0 ? ` | not_listed: ${unlisted.join(' ')}` : ''}`,
  }
}

// The fuel burner machines need (unit 8): the item candidates their fuel categories accept, what the actor holds of them, and, when none is
// held, how each is natively acquired and where the nearest source instance was last read: a resource that mines into it
// (mined_from) or a natural tree or rock the harvest operation mines for it (harvested_from).
function fuelNeedsRecord(fuel, limits) {
  if (!fuel) return undefined
  const items = asList(fuel.items)
  const heldFuel = items.filter(item => item.held > 0).map(item => `${item.name}=${item.held}`)
  const heldText = heldFuel.length > 0 ? heldFuel.join(',') : fuel.unknown_held > 0 ? `unknown (${fuel.unknown_held} of ${items.length} counts unread)` : 'none'
  const searched = fuel.search === 'needed'
  const parts = items.map((item) => {
    const base = `${item.name} fuel_value=${megajoules(item.fuel_value)} held=${item.held ?? 'unknown'}`
    if (!searched) return base
    if (item.raw) return `${base} ${rawLeafRowText(item.raw)}`
    const mined = asList(item.mined_from)
    const harvested = asList(item.harvested_from)
    if (mined.length === 0 && harvested.length === 0) return `${base} no_derived_source`
    return [base, mined.length > 0 ? `raw: mined_from=${mined.join(',')} nearest=not_read` : '', harvested.length > 0 ? `harvest: harvested_from=${harvested.join(',')} nearest=not_read` : ''].filter(Boolean).join(' ')
  })
  const head = `fuel_needs (burner ${asList(fuel.machines).join(',')} burn fuel_categories=${asList(fuel.categories).join('+') || 'unknown'}; candidates from item prototypes, held from the fresh read; amount needed not derived; sources derived from prototypes: resources that mine into the item (mined_from) and the natural trees and rocks the harvest operation mines for it (harvested_from), no_derived_source = neither yields it)`
  const body = `held_fuel=${heldText}${!searched && items.length > 0 ? ' (acquisition not searched)' : ''}${parts.length > 0 ? ` | ${joinBounded(parts, ' | ', limits.fuelChars)}` : ' | candidates=not_reported (the recipe read carried no fuel list)'}`
  return { key: 'fuel_needs', block: 'step', drop: 'fuel_needs', text: `${head}: ${body}` }
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
      // A read over partly ungenerated chunks says so; the rendered hint carries it (absent on older reads).
      ...(typeof result.coverage_complete === 'boolean' ? { coverage_complete: result.coverage_complete } : {}),
      ...(result.coverage_complete === false && Number.isSafeInteger(result.ungenerated_chunk_count) && result.ungenerated_chunk_count > 0 ? { ungenerated_chunk_count: result.ungenerated_chunk_count } : {}),
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
  const parts = list.map(anchor => `${anchor.fluid_name}:${anchor.name}@(${anchor.position.x},${anchor.position.y}) surface=${anchor.surface_index} observed ${tagText(anchor.as_of)}${anchor.coverage_complete === false ? ` coverage=INCOMPLETE${Number.isSafeInteger(anchor.ungenerated_chunk_count) ? `(${anchor.ungenerated_chunk_count} chunks ungenerated; nearer water may exist)` : '(nearer water may exist)'}` : ''}`)
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
  const machineEnergy = machineEnergyRecord(facts.machine_energy, limits)
  if (machineEnergy) records.push(machineEnergy)
  const fuelNeeds = fuelNeedsRecord(facts.fuel_needs, limits)
  if (fuelNeeds) records.push(fuelNeeds)
  const placedMachines = placedMachinesRecord(facts.placed_machines, limits)
  if (placedMachines) records.push(placedMachines)
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
    ...(facts?.machine_energy ? {
      machine_energy: keys.has('machine_energy') ? asList(facts.machine_energy.machines).length : 0,
      burner_machines: keys.has('machine_energy') ? facts.machine_energy.burner_count : 0,
      fuel_needs: keys.has('fuel_needs') ? asList(facts.fuel_needs?.items).length : 0,
    } : {}),
    machine: keys.has('checkpoint_machine') ? (facts?.machine?.state ?? 'none') : 'none',
    ...(asList(facts?.placed_machines).length > 0 ? { placed_machines: keys.has('placed_machines') ? Math.min(asList(facts.placed_machines).length, EXECUTOR_FACT_LIMITS.placedMachines) : 0 } : {}),
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
  const machineEnergy = machineEnergyRecord(facts.machine_energy, limits)
  if (machineEnergy) records.push(machineEnergy)
  const fuelNeeds = fuelNeedsRecord(facts.fuel_needs, limits)
  if (fuelNeeds) records.push(fuelNeeds)
  const placedMachines = placedMachinesRecord(facts.placed_machines, limits)
  if (placedMachines) records.push(placedMachines)
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
 * @param {number} [args.sequence] caller's monotonic conversation counter; keeps same-millisecond restages of unchanged state distinct
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
export function buildHandoffPacket({ planningState, role, checkpoint, reason = '', note = '', budget = '', actor, runtime, shelfCandidates, amendment, jevFacts, jevHints, executorFacts, previousContextChars, now, sequence, limits: limitOverrides } = {}) {
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
  // `sequence` is the caller's monotonic conversation counter. Without it two restages of unchanged state at the same checkpoint in the
  // same millisecond hash to one id, and the second is refused as a reused handoff id (restage_error).
  const handoffId = `ho_${sha256(`${goalId}|${plan?.plan_id ?? ''}|${role}|${checkpoint}|${now ?? ''}|${hash}${Number.isSafeInteger(sequence) ? `|${sequence}` : ''}`).slice(0, 12)}`
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
