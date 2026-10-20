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

// The reads a step's executor has had delivered, by the conversation that got them.
// A harness swap (restage, planner resume) replaces the conversation, so the tool
// results the step already held are gone and B2 forgets UnchangedFactReads with
// them. The executor then re-reads what it had only because the harness dropped it,
// and that must not spend the per-decision observation budget. Budget accounting
// only: the read still runs live and the model gets the fresh answer.
//
// The record lives at step scope (it must outlive the conversation) and is keyed by
// the step identity, so a different step, plan version, actor, epoch or session
// never matches. Each signature is free once per swap: serving the re-read records
// it against the new conversation, so a repeat there is charged like any other.
const STEP_LIMIT = 8
const READ_LIMIT = 64

export function stepReadKey(epoch, plan, step) {
  const scope = unchangedFactScope(epoch)
  if (scope === undefined || typeof step?.step_id !== 'string' || step.step_id.length === 0) return undefined
  return [scope, epoch.session, plan?.plan_id, plan?.plan_version, step.step_id].map(part => String(part ?? '')).join('\u0000')
}

export class StepReadLedger {
  constructor({ stepLimit = STEP_LIMIT, readLimit = READ_LIMIT } = {}) {
    this.stepLimit = stepLimit
    this.readLimit = readLimit
    this.steps = new Map()
  }

  // True when this signature was delivered to this step by an earlier conversation
  // and has not been re-established since.
  isReestablishing(stepKey, signature, conversationSeq) {
    if (typeof stepKey !== 'string' || typeof signature !== 'string' || !Number.isSafeInteger(conversationSeq)) return false
    const seq = this.steps.get(stepKey)?.get(signature)
    return seq !== undefined && seq < conversationSeq
  }

  // Record only reads the conversation `conversationSeq` actually received.
  recordDelivered(stepKey, signature, conversationSeq) {
    if (typeof stepKey !== 'string' || typeof signature !== 'string' || !Number.isSafeInteger(conversationSeq)) return
    const reads = this.steps.get(stepKey) ?? new Map()
    reads.delete(signature)
    reads.set(signature, conversationSeq)
    while (reads.size > this.readLimit) reads.delete(reads.keys().next().value)
    this.steps.delete(stepKey)
    this.steps.set(stepKey, reads)
    while (this.steps.size > this.stepLimit) this.steps.delete(this.steps.keys().next().value)
  }

  clear() {
    this.steps.clear()
  }
}
