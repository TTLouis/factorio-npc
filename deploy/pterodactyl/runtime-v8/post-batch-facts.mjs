// Facts the executor is predicted to need right after a batch: its inventory and the
// recipes it already looked up for the active step. In Run Y (2026-10-17) 87 of 177
// model replies only asked for reads, and 50 of the 89 recipe/inventory reads repeated
// one made earlier in the same context, each costing a full model round. The harness
// reads this bundle live, in one go, when the batch receipt lands, and hands it over
// with the continuation, so the next round can act instead of asking. Facts only.
export const POST_BATCH_FACT_CHARS = 8000
export const POST_BATCH_RECIPE_LIMIT = 3
export const POST_BATCH_ROUTES = Object.freeze(new Set(['continue_current', 'targeted_observation']))
export const POST_BATCH_FACTS_PREFIX = '[HARNESS] Facts read live after this batch (the harness predicted these lookups; facts only):'

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

export function postBatchFactsMessage(reads) {
  if (!Array.isArray(reads) || reads.length === 0) return ''
  return [POST_BATCH_FACTS_PREFIX, ...reads.map(read => `${read.name} ${JSON.stringify(read.args ?? {})} => ${read.output}`)].join('\n')
}
