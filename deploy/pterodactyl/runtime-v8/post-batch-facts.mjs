import { EXECUTOR_ROLE } from './agent-roles.mjs'
import { parseInventoryCounts } from './inventory-facts.mjs'

// Facts the executor is predicted to need right after a batch: its inventory, the default
// read of each observation family Jev selected for the next decision, and the recipes it
// already looked up for the active step. In Run Y (2026-10-17) 87 of 177
// model replies only asked for reads, and 50 of the 89 recipe/inventory reads repeated
// one made earlier in the same context, each costing a full model round. The harness
// reads this bundle live, in one go, when the batch receipt lands, and hands it over
// with the continuation, so the next round can act instead of asking. Facts only.
export const POST_BATCH_FACT_CHARS = 8000
export const POST_BATCH_RECIPE_LIMIT = 3
export const POST_BATCH_ROUTES = Object.freeze(new Set(['continue_current', 'targeted_observation']))
// A tail block (prompt-prefix.mjs): recomputed for every round of the decision that follows the batch, never
// stored in the working history, and looked past by round-type detection, so the [MOD] receipt stays the
// instruction the round answers.
export const POST_BATCH_FACTS_MARKER = '[POST_BATCH_FACTS]'
export const POST_BATCH_FACTS_PREFIX = `${POST_BATCH_FACTS_MARKER} Read live after the last batch receipt (the harness predicted these lookups; facts only):`

// The decision after a batch opens with its read-only phase closed when the bundle answers every observation
// family Jev selected for it (providerRoundPhase reason). In Run Z (2026-10-18) every one of 21 batches was
// followed by such a read round (37 rounds, 3.7 of 19.5 min); its reads were mostly facts this bundle can hold.
export const POST_BATCH_COVERAGE_REASON = 'post_batch_facts_cover_selected_families'

// The harness's own read for each observation family it can answer without the model choosing arguments:
// argument-free reads, and the status of the entity this batch placed (named by its receipt). runtime_status is
// the actor read: the receipt already carries the task status (and getTaskStatus alone is larger than the
// bundle). Recipes, placement, nearby world, construction and the rest have no safe default; they stay the
// model's reads and keep the read-only phase open.
const FAMILY_READS = Object.freeze({
  inventory_equipment: () => ({ name: 'getInventoryItems', args: {} }),
  research_state: () => ({ name: 'getResearchStatus', args: {} }),
  runtime_status: () => ({ name: 'getActorStatus', args: {} }),
  entity_status: ({ placedUnitNumber }) => Number.isSafeInteger(placedUnitNumber)
    ? { name: 'getEntityStatus', args: { unit_number: placedUnitNumber } }
    : undefined,
})

// The default read for each selected family that has one, tagged with the family it answers.
export function postBatchFamilyReads(families, context = {}) {
  if (!Array.isArray(families)) return []
  return families.flatMap((family) => {
    const read = Object.hasOwn(FAMILY_READS, family) ? FAMILY_READS[family](context) : undefined
    return read ? [{ ...read, family }] : []
  })
}

// Run AJ (2026-10-21): batch 32 placed offshore-pump unit 37, Jev selected only nearby_world, and the bundle held only the
// inventory, so the executor spent its one closed-round targeted read on getEntityStatus(37) to learn the pump's live identity and
// fluid port. After a batch whose receipt names exactly one placed entity, the harness reads that entity's status whatever Jev
// selected. It is facts only, with no authority. Unless Jev selected entity_status, it is tagged `harness` and not `family`, so it
// covers no family. It never closes the read-only phase on its own, and it cannot change which selected families count as answered.
export const POST_BATCH_PLACED_ENTITY_REASON = 'single_placement_receipt'
export function postBatchPlacedEntityRead(placedUnitNumber) {
  return Number.isSafeInteger(placedUnitNumber) && placedUnitNumber > 0
    ? { name: 'getEntityStatus', args: { unit_number: placedUnitNumber }, harness: 'placed_entity' }
    : undefined
}

// Inventory uses the native Serpent list (also supporting JSON arrays). Other families
// still require a non-error JSON object; an entity read must match its exact identity.
export function postBatchReadAnswers(read) {
  if (read?.name === 'getInventoryItems') return parseInventoryCounts(read.output) !== undefined
  let parsed
  try { parsed = JSON.parse(read?.output) }
  catch { return false }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok === false || parsed.error !== undefined) return false
  if (read.name === 'getEntityStatus') return parsed.found === true && parsed.entity?.unit_number === read.args?.unit_number
  return true
}

// A later delivered full native answer supersedes only the same lookup. Errors and native diff/unchanged
// references do not replace their full baseline. Dropping the old raw output cannot increase the 8000-char
// prefetch budget, and never credits a family or opens another observation allowance.
export function withoutSupersededPostBatchFact(held, read) {
  if (!Array.isArray(held?.reads) || typeof read?.signature !== 'string' || typeof read.output !== 'string') return undefined
  const prior = held.reads.find(item => item.signature === read.signature && item.name === read.name)
  if (!prior || prior.output === read.output) return undefined
  if (read.name === 'getInventoryItems') {
    if (parseInventoryCounts(read.output) === undefined) return undefined
  }
  else {
    let parsed
    try { parsed = JSON.parse(read.output) }
    catch { return undefined }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.ok === false || parsed.error !== undefined) return undefined
    if (parsed.observation_mode !== undefined && parsed.observation_mode !== 'full') return undefined
    if (read.name === 'getEntityStatus') {
      if (parsed.found !== false && !(parsed.found === true && parsed.entity?.unit_number === read.args?.unit_number)) return undefined
    }
    else if (!postBatchReadAnswers(read)) return undefined
  }
  const reads = held.reads.filter(item => item.signature !== read.signature)
  const covered = (held.covered ?? []).filter(family => reads.some(item => item.family === family && postBatchReadAnswers(item)))
  return { ...held, reads, covered }
}

const STEP_LIMIT = 8

export class StepFactWorkingSet {
  constructor({ recipeLimit = POST_BATCH_RECIPE_LIMIT } = {}) {
    this.recipeLimit = recipeLimit
    this.steps = new Map()
  }

  // A recipe the model read while this step was active; most recent first, bounded.
  noteRecipe(stepKey, args, signature) {
    if (typeof stepKey !== 'string' || typeof signature !== 'string' || !args || typeof args !== 'object') return
    const reads = (this.steps.get(stepKey) ?? []).filter(entry => entry.signature !== signature)
    reads.unshift({ name: 'getRecipeDetails', args: { ...args }, signature })
    this.steps.delete(stepKey)
    this.steps.set(stepKey, reads.slice(0, this.recipeLimit))
    while (this.steps.size > STEP_LIMIT) this.steps.delete(this.steps.keys().next().value)
  }

  recipes(stepKey) {
    return (this.steps.get(stepKey) ?? []).map(entry => ({ ...entry, args: { ...entry.args } }))
  }

  clear() {
    this.steps.clear()
  }
}

export function postBatchStepKey(scope, planId, stepId) {
  if (typeof scope !== 'string' || typeof stepId !== 'string' || stepId.length === 0) return undefined
  return `${scope}\u0000${planId ?? ''}\u0000${stepId}`
}

// The held bundle, while it still describes the world: same actor scope, step and executor role, and no world
// mutation (a batch sent or a receipt read) since it was read.
export function postBatchFactsContext(loop, { scope, stepKey, role, mutation } = {}) {
  const held = loop?.postBatchFacts
  if (!held || loop.batchInFlight === true || role !== EXECUTOR_ROLE) return ''
  if (held.scope === undefined || held.scope !== scope || held.stepKey !== stepKey || held.mutation !== mutation) return ''
  return postBatchFactsMessage(held.reads, held.covered)
}

export function postBatchFactsMessage(reads, covered = []) {
  if (!Array.isArray(reads) || reads.length === 0) return ''
  return [
    POST_BATCH_FACTS_PREFIX,
    ...reads.map(read => `${read.name} ${JSON.stringify(read.args ?? {})} => ${read.output}`),
    ...reads.filter(read => read.harness === 'placed_entity').map(read => `The entity the last batch placed (unit_number ${read.args?.unit_number}), read by the harness from its receipt: live identity and ports, facts only.`),
    ...(Array.isArray(covered) && covered.length ? [`Selected observation families these reads answer: ${covered.join(', ')}`] : []),
  ].join('\n')
}
