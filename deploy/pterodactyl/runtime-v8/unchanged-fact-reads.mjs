// Fact reads whose live result has not changed since it was last delivered to
// the model. They are still read live (the game stays the authority, so a
// research unlock or an inventory change shows up immediately), but repeating an
// unchanged answer is not new observation and must not consume the per-decision
// Jev observation budget. Run Y spent 62 of 89 fresh reads in its pump step on
// unchanged recipes and inventory, leaving no budget for placement reads.
export const UNCHANGED_FACT_TOOLS = Object.freeze(new Set(['getRecipeDetails', 'getInventoryItems']))

const DEFAULT_LIMIT = 64

export function unchangedFactScope(epoch) {
  if (!epoch || typeof epoch !== 'object') return undefined
  if (epoch.actor_id === undefined || epoch.actor_id === null || epoch.epoch === undefined || epoch.epoch === null) return undefined
  return [epoch.mode, epoch.actor_kind, epoch.actor_id, epoch.epoch].map(String).join(':')
}

export class UnchangedFactReads {
  constructor({ limit = DEFAULT_LIMIT } = {}) {
    this.limit = limit
    this.delivered = new Map()
  }

  // True only when `output` is identical to the last result delivered for the
  // same signature in the same actor scope. Without a scope nothing is reused.
  isUnchanged(scope, signature, output) {
    if (scope === undefined || typeof signature !== 'string' || typeof output !== 'string') return false
    return this.delivered.get(`${scope}\u0000${signature}`) === output
  }

  // Record only results the model actually received; a read that was deferred
  // or dropped never counts as delivered.
  recordDelivered(scope, signature, output) {
    if (scope === undefined || typeof signature !== 'string' || typeof output !== 'string') return
    const key = `${scope}\u0000${signature}`
    this.delivered.delete(key)
    this.delivered.set(key, output)
    while (this.delivered.size > this.limit) {
      const oldest = this.delivered.keys().next().value
      if (oldest === undefined) break
      this.delivered.delete(oldest)
    }
  }

  clear() {
    this.delivered.clear()
  }
}
