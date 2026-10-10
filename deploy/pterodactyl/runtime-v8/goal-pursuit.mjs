import { randomUUID } from 'node:crypto'
import { isObservationToolName, parseOperation, toolCommand } from './structured-policy.mjs'
import { actorChanged } from './supervisor-adapter.mjs'
import { batchWatermark, buildPendingOperation, reconcilePendingOperation, RECONCILE_VERDICT } from './operation-reconciliation.mjs'

// Cancellation seals the queue, but can leave partial physical effects. Hold
// its identity until those effects are reconciled; never authorize blind replay.
const TERMINAL = new Set([RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION])
const clone = value => structuredClone(value)
const check = (ok, reason) => { if (!ok) throw new Error(reason) }

// Separate protocol for the experiment: notes are revisable, dispatched actions
// are not. Adapters own native physical/permission admission, durable storage,
// and exact world predicate evaluation; they cannot be supplied by the model.
export function pursuitDecision(raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'decision_object_required')
  check(Object.keys(raw).every(key => ['notes', 'operations', 'observations', 'pauseReason'].includes(key)), 'decision_unknown_field')
  check(raw.notes === undefined || (typeof raw.notes === 'string' && raw.notes.length <= 2000), 'notes_limit')
  const operations = raw.operations ?? []
  const observations = raw.observations ?? []
  check(Array.isArray(operations) && operations.length <= 16, 'operations_limit')
  check(Array.isArray(observations) && observations.length <= 4, 'observations_limit')
  check(!(operations.length && observations.length), 'one_decision_kind_required')
  check(raw.pauseReason === undefined || (typeof raw.pauseReason === 'string' && raw.pauseReason.length <= 300 && raw.pauseReason.trim()), 'pause_reason_required')
  check(!raw.pauseReason || (!operations.length && !observations.length), 'pause_cannot_dispatch')
  return {
    notes: raw.notes,
    operations: operations.map(parseOperation),
    observations: observations.map(read => {
      check(read && typeof read === 'object' && !Array.isArray(read) && Object.keys(read).every(key => ['name', 'args'].includes(key)), 'observation_unknown_field')
      check(isObservationToolName(read.name), 'observation_tool_required')
      // The existing renderer validates every argument and restricts remote
      // calls to approved reads. The adapter receives no generated Lua.
      toolCommand(read.name, read.args ?? {})
      return { name: read.name, args: clone(read.args ?? {}) }
    }),
    pauseReason: raw.pauseReason,
  }
}

function validateBudget(budget) {
  check(Number.isSafeInteger(budget?.maxCalls) && budget.maxCalls > 0 && budget.maxCalls <= 30, 'call_limit')
  check(Number.isSafeInteger(budget.maxWallMs) && budget.maxWallMs > 0 && budget.maxWallMs <= 1200000, 'wall_limit')
  check(Number.isSafeInteger(budget.maxInputChars) && budget.maxInputChars > 0, 'input_limit')
  check(Number.isSafeInteger(budget.calls) && budget.calls >= 0 && budget.calls <= budget.maxCalls, 'persisted_call_budget_invalid')
  check(Number.isSafeInteger(budget.inputChars) && budget.inputChars >= 0 && budget.inputChars <= budget.maxInputChars, 'persisted_input_budget_invalid')
  check(budget.startedAt === null || (Number.isSafeInteger(budget.startedAt) && budget.startedAt >= 0), 'persisted_wall_budget_invalid')
  check(budget.calls === 0 || budget.startedAt !== null, 'persisted_budget_start_missing')
}

export function newPursuit({ objective, predicate, actor, maxCalls = 30, maxWallMs = 1200000, maxInputChars = 600000 }) {
  check(typeof objective === 'string' && objective.trim() && objective.length <= 4000, 'objective_required')
  check(predicate && typeof predicate === 'object', 'owner_predicate_required')
  check(Number.isSafeInteger(actor?.actor_id) && Number.isSafeInteger(actor?.epoch), 'actor_required')
  check(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= 30, 'call_limit')
  check(Number.isSafeInteger(maxWallMs) && maxWallMs > 0 && maxWallMs <= 1200000, 'wall_limit')
  check(Number.isSafeInteger(maxInputChars) && maxInputChars > 0, 'input_limit')
  return { version: 1, request_id: `pursuit_${randomUUID()}`, objective, predicate: clone(predicate), actor: clone(actor),
    status: 'active', notes: '', ordinal: 0, pending: null, history: [], observations: [],
    budget: { maxCalls, maxWallMs, maxInputChars, calls: 0, inputChars: 0, startedAt: null }, metrics: [] }
}

export class GoalPursuit {
  constructor({ state, adapter, provider, now = Date.now }) {
    check(state?.version === 1, 'pursuit_state_version')
    validateBudget(state.budget)
    for (const method of ['world', 'verify', 'observe', 'admit', 'dispatch', 'save', 'trace']) check(typeof adapter?.[method] === 'function', `adapter_${method}_required`)
    check(typeof provider === 'function', 'provider_required')
    this.state = clone(state)
    // Reads from a previous process are historical evidence, not a current
    // observation. A restart must obtain fresh targets through bounded tools.
    this.state.observations = []
    this.adapter = adapter
    this.provider = provider
    this.now = now
    this.busy = false
    this.generation = 0
  }

  snapshot() { return clone(this.state) }
  async event(event, reason, data = {}) {
    await this.adapter.trace({ event, request_id: this.state.request_id, reason, ...clone(data) })
  }
  async save() { await this.adapter.save(this.snapshot()) }
  async fence(generation) {
    check(generation === this.generation, 'pursuit_cancelled')
    const world = await this.adapter.world()
    check(generation === this.generation, 'pursuit_cancelled')
    check(!actorChanged(this.state.actor, world.actor), 'pursuit_stale_actor')
    return world
  }
  async pause(reason) {
    this.state.status = 'paused'
    this.state.pauseReason = reason
    await this.save()
    await this.event('pursuit.paused', reason)
    return this.snapshot()
  }
  async cancel(reason = 'user_cancelled') {
    this.generation++
    this.controller?.abort()
    this.state.status = 'paused'
    this.state.pauseReason = reason
    // A running wake persists its fail-closed result after the generation
    // fence. An idle cancellation must itself survive a process restart.
    if (!this.busy) {
      await this.save()
      await this.event('pursuit.paused', reason)
    }
    return this.snapshot()
  }

  // Call at owner intake, an exact native receipt, a condition transition, or
  // recovery. Polling a running batch does not make another provider request.
  async wake(reason) {
    if (this.busy || this.state.status !== 'active') return this.snapshot()
    this.busy = true
    const generation = this.generation
    try {
      let world = await this.fence(generation)
      if (this.state.pending) {
        const settled = reconcilePendingOperation(this.state.pending, { actor: world.actor, status: world.runtime })
        await this.event('pursuit.reconciled', settled.reason, { operation_key: this.state.pending.operation_key, verdict: settled.verdict })
        await this.fence(generation)
        if (settled.verdict === RECONCILE_VERDICT.ADMITTED_IN_FLIGHT) return this.snapshot()
        if (!TERMINAL.has(settled.verdict)) return this.pause(`uncertain_operation:${settled.reason}`)
        this.state.history.push({ ...this.state.pending, ...settled })
        this.state.history = this.state.history.slice(-16)
        this.state.pending = null
        // Every mutable observation predates the effect just settled. Do not
        // carry exact targets across the boundary as current game truth.
        this.state.observations = []
        await this.save()
      }
      // This loop does not own a queue lacking its exact pending identity.
      // Unreadable native status is never permission to append to that queue.
      if (!batchWatermark(world.runtime) || !Number.isSafeInteger(world.runtime?.batch_generation)
        || !Number.isSafeInteger(world.runtime?.queue_length) || typeof world.runtime?.task_state !== 'string') {
        return this.pause('native_status_unreadable')
      }
      if (world.runtime.task_state !== 'idle' || world.runtime.queue_length !== 0) return this.pause('unowned_native_work')
      const verification = await this.adapter.verify(clone(this.state.predicate), clone(world.actor))
      world = await this.fence(generation)
      if (verification?.read === true && verification.satisfied === true) {
        this.state.status = 'completed'
        await this.save()
        await this.event('pursuit.completed', 'owner_predicate_verified', { verification })
        return this.snapshot()
      }
      const budget = this.state.budget
      if (budget.startedAt !== null && this.now() < budget.startedAt) return this.pause('wall_clock_regressed')
      if (budget.startedAt !== null && this.now() - budget.startedAt >= budget.maxWallMs) return this.pause('wall_budget_exhausted')
      if (budget.calls >= budget.maxCalls) return this.pause('call_budget_exhausted')
      // Compact from durable facts each time, never a model-generated summary
      // of receipt history. Strategy is explicitly non-authoritative.
      const packet = { objective: this.state.objective, predicate: this.state.predicate,
        notes: this.state.notes, actor: this.state.actor, world: world.observation,
        receipts: this.state.history, observations: this.state.observations, verification,
        remainingCalls: budget.maxCalls - budget.calls }
      const inputChars = JSON.stringify(packet).length
      if (budget.inputChars + inputChars > budget.maxInputChars) return this.pause('input_budget_exhausted')
      const started = this.now()
      budget.startedAt ??= started
      budget.calls++ // Failed, planning and correction attempts cost a slot.
      budget.inputChars += inputChars
      await this.save() // Crash/restart cannot reset reservations.
      await this.event('pursuit.provider_reserved', reason, { call: budget.calls, input_chars: inputChars })
      await this.fence(generation)
      const remainingMs = budget.maxWallMs - (this.now() - budget.startedAt)
      if (remainingMs <= 0) return this.pause('wall_budget_exhausted')
      this.controller = new AbortController()
      const controller = this.controller
      let rejectTimeout
      const deadline = new Promise((_, reject) => { rejectTimeout = reject })
      const abort = () => rejectTimeout(new Error(controller.signal.reason?.message ?? 'pursuit_cancelled'))
      controller.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(() => controller.abort(new Error('wall_budget_exhausted')), remainingMs)
      let answer
      try { answer = await Promise.race([this.provider(clone(packet), { signal: controller.signal, requestId: this.state.request_id }), deadline]) }
      finally { clearTimeout(timer); controller.signal.removeEventListener('abort', abort); this.controller = null }
      world = await this.fence(generation)
      if (this.now() - budget.startedAt >= budget.maxWallMs) return this.pause('wall_budget_exhausted')
      const decision = pursuitDecision(answer)
      this.state.metrics.push({ call: budget.calls, latency_ms: this.now() - started, input_chars: inputChars })
      this.state.metrics = this.state.metrics.slice(-30)
      if (decision.notes !== undefined) this.state.notes = decision.notes
      await this.save()
      await this.event('pursuit.decision', 'bounded_model_decision', { call: budget.calls, operations: decision.operations.length, observations: decision.observations.length })
      if (decision.pauseReason) return this.pause(`provider_reported:${decision.pauseReason}`)
      if (decision.observations.length) {
        const observations = []
        for (const read of decision.observations) {
          await this.fence(generation)
          const result = String(await this.adapter.observe(clone(read))).slice(0, 8000)
          await this.fence(generation)
          observations.push({ ...read, result })
        }
        this.state.observations = observations
        await this.save()
        return this.snapshot() // Driver wakes on these newly completed reads.
      }
      if (!decision.operations.length) return this.pause('provider_no_progress')
      // Physical and grant checks are a required adapter contract, performed
      // immediately before reserving immutable dispatch identity.
      const admission = await this.adapter.admit(clone(decision.operations), clone(world.actor))
      world = await this.fence(generation)
      if (admission?.ok !== true) {
        this.state.observations = [{ name: 'admission', result: JSON.stringify(admission).slice(0, 8000) }]
        await this.save()
        await this.event('pursuit.admission_refused', 'native_or_permission_refusal', { admission })
        return this.snapshot()
      }
      const ordinal = ++this.state.ordinal
      this.state.pending = buildPendingOperation({ requestId: this.state.request_id,
        operationKey: `${this.state.request_id}/batch_${ordinal}`, ordinal, protocolVersion: 2,
        operations: decision.operations, goalId: this.state.request_id, actor: world.actor,
        baseline: batchWatermark(world.runtime), now: this.now() })
      await this.save()
      await this.event('pursuit.dispatch', 'native_admission_passed', { operation_key: this.state.pending.operation_key, signature: this.state.pending.signature })
      await this.fence(generation)
      const deadlineAt = budget.startedAt + budget.maxWallMs
      if (this.now() >= deadlineAt) return this.pause('wall_budget_exhausted')
      // Pending is retained on every transport exception. Only exact native
      // reconciliation can make another dispatch possible after this point.
      await this.adapter.dispatch(clone(decision.operations), clone(this.state.pending), { deadlineAt })
      await this.fence(generation)
      return this.snapshot()
    }
    catch (error) {
      await this.event('pursuit.failure', 'fail_closed', { code: String(error.message).slice(0, 300) })
      return this.pause(String(error.message).slice(0, 300))
    }
    finally { this.busy = false }
  }
}
