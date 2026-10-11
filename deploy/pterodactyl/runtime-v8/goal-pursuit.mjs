import { randomUUID } from 'node:crypto'
import { isObservationToolName, parseOperation, toolCommand, PolicyError } from './structured-policy.mjs'
import { actorChanged } from './supervisor-adapter.mjs'
import { batchWatermark, buildPendingOperation, reconcilePendingOperation, RECONCILE_VERDICT } from './operation-reconciliation.mjs'
import { recipeFactsFromDetails } from './handoff-packet.mjs'
import { rememberFluidSources } from './pursuit-knowledge.mjs'

// Cancellation seals the queue, but can leave partial physical effects. Hold
// its identity until those effects are reconciled; never authorize blind replay.
const TERMINAL = new Set([RECONCILE_VERDICT.ADMITTED_COMPLETED, RECONCILE_VERDICT.NOT_ADMITTED, RECONCILE_VERDICT.REFUSED_BEFORE_MUTATION])
const clone = value => structuredClone(value)
const check = (ok, reason) => { if (!ok) throw new Error(reason) }
export const PURSUIT_BUDGET_LIMITS = Object.freeze({ maxCalls: 500, maxWallMs: 3600000, maxInputChars: 50000000 })

const observationKey = row => `${row.name}:${JSON.stringify(Object.entries(row.args ?? {}).sort(([a], [b]) => a.localeCompare(b)))}`
function rememberObservations(previous, fresh) {
  const keys = new Set(fresh.map(observationKey))
  const rows = [...previous.filter(row => !keys.has(observationKey(row))).map(row => ({ ...row, historical: true })), ...fresh]
  while (rows.length > 12 || JSON.stringify(rows).length > 48000) rows.shift()
  return rows
}
function observationText(raw) {
  let text = String(raw)
  try { text = JSON.stringify(JSON.parse(text)) } catch { /* Native serpent text stays verbatim. */ }
  return text.length <= 8000 ? text : `${text.slice(0, 7900)}\n[Native observation truncated; request a narrower read for omitted facts.]`
}
// Search hints only: retain where native reads last saw an entity, never its
// inventory, working state, ownership or continued existence. Empty local
// scans cannot establish that an older, possibly distant entity disappeared.
function entityAnchors(rows) {
  const anchors = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!Number.isSafeInteger(row?.unit_number) || row.unit_number < 1
      || typeof row.name !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.name)
      || typeof row.type !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(row.type)
      || !Number.isFinite(row.position?.x) || !Number.isFinite(row.position?.y)
      || !Number.isSafeInteger(row.observed_at_ms) || row.observed_at_ms < 0) continue
    const anchor = { unit_number: row.unit_number, name: row.name, type: row.type,
      position: { x: row.position.x, y: row.position.y }, observed_at_ms: row.observed_at_ms, historical: true }
    const index = anchors.findIndex(old => old.unit_number === anchor.unit_number)
    if (index >= 0) anchors.splice(index, 1)
    anchors.push(anchor)
    while (anchors.length > 32 || JSON.stringify(anchors).length > 8000) anchors.shift()
  }
  return anchors
}
function rememberEntities(previous, read, raw, observedAt) {
  if (!['getEntityStatus', 'getNearbyEntities'].includes(read.name)) return previous
  let parsed
  try { parsed = JSON.parse(String(raw)) } catch { return previous }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return previous
  if (read.name === 'getEntityStatus' && parsed.found === false) {
    return previous.filter(row => row.unit_number !== read.args.unit_number)
  }
  if (read.name === 'getEntityStatus' && read.args.unit_number !== undefined
    && parsed.entity?.unit_number !== read.args.unit_number) return previous
  const fresh = read.name === 'getEntityStatus' ? (parsed.found === true ? [parsed.entity] : [])
    : (Array.isArray(parsed.entities) ? parsed.entities.slice(0, 64) : [])
  return entityAnchors([...previous, ...fresh.map(row => ({ ...row, observed_at_ms: observedAt }))])
}
function rememberRecipeKnowledge(previous, read, raw, observedAt) {
  if (read.name !== 'getRecipeDetails') return previous
  let parsed
  try { parsed = JSON.parse(String(raw)) } catch { return previous }
  // Extract prototype quantities only. Inventory, recipe enablement and exact
  // entity state never survive the action boundary through this cache.
  const quantity = value => Number.isFinite(value) && value >= 0
  const fresh = recipeFactsFromDetails(parsed).map(fact => {
    const rawRecipe = Array.isArray(parsed.recipes) ? parsed.recipes.find(row => row?.name === fact.name) : undefined
    // Normalization drops unreadable optional fields. Check explicit native
    // probability fields before that loss so unknown yield stays incomplete.
    const probabilitiesReadable = Array.isArray(rawRecipe?.products) && rawRecipe.products.every(item =>
      ['probability', 'independent_probability'].every(key => !Object.hasOwn(item ?? {}, key)
        || (quantity(item[key]) && item[key] <= 1)))
    return { ...fact,
      complete: fact.complete && probabilitiesReadable && fact.ingredients.every(item => quantity(item.amount))
        && fact.products.every(item => quantity(item.amount) || (quantity(item.amount_min) && quantity(item.amount_max) && item.amount_max >= item.amount_min)),
      observed_at_ms: observedAt, historical: true }
  })
  const names = new Set(fresh.map(fact => fact.name))
  const rows = [...previous.filter(fact => !names.has(fact.name)), ...fresh]
  while (rows.length > 32 || JSON.stringify(rows).length > 16000) rows.shift()
  return rows
}

// Separate protocol for the experiment: notes are revisable, dispatched actions
// are not. Adapters own native physical/permission admission, durable storage,
// and exact world predicate evaluation; they cannot be supplied by the model.
export function pursuitDecision(raw) {
  check(raw && typeof raw === 'object' && !Array.isArray(raw), 'decision_object_required')
  check(Object.keys(raw).every(key => ['notes', 'operations', 'observations', 'pauseReason'].includes(key)), 'decision_unknown_field')
  check(raw.notes === undefined || (typeof raw.notes === 'string' && raw.notes.length <= 2000), 'notes_limit')
  const operations = raw.operations ?? []
  const observations = raw.observations ?? []
  // Model array shape/count mistakes refuse the entire reply before reads or
  // actions run. They can be corrected within the same charged allowance.
  if (!Array.isArray(operations) || operations.length > 16) throw new PolicyError('operations_limit: operations must be an array of at most 16 approved actions. No requests ran.')
  if (!Array.isArray(observations) || observations.length > 4) throw new PolicyError('observations_limit: observations must be an array of at most 4 approved reads. No requests ran.')
  if (operations.length && observations.length) throw new PolicyError('one_decision_kind_required: choose exactly one field: operations for native actions OR observations for reads. No request ran. Submit reads first when facts are missing; submit actions in a later decision after inspecting those facts.')
  if (operations.length > 1 && operations.some(operation => ['place_entity', 'place_candidate'].includes(operation?.name))) {
    throw new PolicyError('placement_action_boundary_required: submit one placement as the sole operation. No request ran. After its exact receipt, observe the resulting identity and collision geometry before choosing navigation, supply or other actions.')
  }
  if (operations.length > 1 && operations.some(operation => operation?.name === 'craft_item')) {
    throw new PolicyError('crafting_action_boundary_required: submit one craft_item as the sole operation. No request ran. Each craft must settle before another action can claim its current ingredients. Use resulting inventory after its exact receipt; do not rely on duplicate or mixed preflights against the same stock.')
  }
  check(raw.pauseReason === undefined || (typeof raw.pauseReason === 'string' && raw.pauseReason.length <= 300 && raw.pauseReason.trim()), 'pause_reason_required')
  check(!raw.pauseReason || (!operations.length && !observations.length), 'pause_cannot_dispatch')
  return {
    notes: raw.notes,
    operations: operations.map(operation => {
      if (isObservationToolName(operation?.name)) throw new PolicyError(`read_request_in_operations: ${operation.name} is a read. No request ran. Submit it under decision.observations using its approved args and omit decision.operations.`)
      return parseOperation(operation)
    }),
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
  check(Number.isSafeInteger(budget?.maxCalls) && budget.maxCalls > 0 && budget.maxCalls <= PURSUIT_BUDGET_LIMITS.maxCalls, 'call_limit')
  check(Number.isSafeInteger(budget.maxWallMs) && budget.maxWallMs > 0 && budget.maxWallMs <= PURSUIT_BUDGET_LIMITS.maxWallMs, 'wall_limit')
  check(Number.isSafeInteger(budget.maxInputChars) && budget.maxInputChars > 0, 'input_limit')
  check(Number.isSafeInteger(budget.calls) && budget.calls >= 0 && budget.calls <= budget.maxCalls, 'persisted_call_budget_invalid')
  check(Number.isSafeInteger(budget.inputChars) && budget.inputChars >= 0 && budget.inputChars <= budget.maxInputChars, 'persisted_input_budget_invalid')
  check(budget.startedAt === null || (Number.isSafeInteger(budget.startedAt) && budget.startedAt >= 0), 'persisted_wall_budget_invalid')
  check(budget.calls === 0 || budget.startedAt !== null, 'persisted_budget_start_missing')
}

export function newPursuit({ objective, predicate, actor, maxCalls = 30, maxWallMs = 1200000, maxInputChars = 2000000 }) {
  check(typeof objective === 'string' && objective.trim() && objective.length <= 4000, 'objective_required')
  check(predicate && typeof predicate === 'object', 'owner_predicate_required')
  check(Number.isSafeInteger(actor?.actor_id) && Number.isSafeInteger(actor?.epoch), 'actor_required')
  check(Number.isSafeInteger(maxCalls) && maxCalls > 0 && maxCalls <= PURSUIT_BUDGET_LIMITS.maxCalls, 'call_limit')
  check(Number.isSafeInteger(maxWallMs) && maxWallMs > 0 && maxWallMs <= PURSUIT_BUDGET_LIMITS.maxWallMs, 'wall_limit')
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
    this.state.recipeKnowledge = [] // A new process must read its deployed prototypes.
    this.state.fluidSourceKnowledge = [] // Surface indices alone do not survive world reload safely.
    this.state.entityKnowledge = entityAnchors(this.state.entityKnowledge)
    delete this.state.knowledgeSeed
    this.adapter = adapter
    this.provider = provider
    this.now = now
    this.busy = false
    this.generation = 0
    this.knowledgeSeeded = false
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
      let packetAt = this.now()
      if (budget.startedAt !== null && packetAt < budget.startedAt) return this.pause('wall_clock_regressed')
      if (budget.startedAt !== null && packetAt - budget.startedAt >= budget.maxWallMs) return this.pause('wall_budget_exhausted')
      if (budget.calls >= budget.maxCalls) return this.pause('call_budget_exhausted')
      if (!this.knowledgeSeeded && typeof this.adapter.seedKnowledge === 'function') {
        // Native seed reads consume the original wall allowance, including on
        // restart. Every read is fenced; none can run while a batch is pending.
        budget.startedAt ??= this.now()
        await this.save()
        const report = await this.adapter.seedKnowledge(clone(this.state.predicate), async read => {
          await this.fence(generation)
          if (this.now() < budget.startedAt) throw new Error('wall_clock_regressed')
          if (this.now() - budget.startedAt >= budget.maxWallMs) throw new Error('wall_budget_exhausted')
          const raw = await this.adapter.observe(clone(read))
          await this.fence(generation)
          if (this.now() < budget.startedAt) throw new Error('wall_clock_regressed')
          if (this.now() - budget.startedAt >= budget.maxWallMs) throw new Error('wall_budget_exhausted')
          if (read.name === 'getRecipeDetails') {
            this.state.recipeKnowledge = rememberRecipeKnowledge(this.state.recipeKnowledge, read, raw, this.now())
          } else {
            this.state.observations = rememberObservations(this.state.observations, [{ ...clone(read),
              result: observationText(raw), observed_at_ms: this.now(), historical: false }])
          }
          await this.save()
          return raw
        })
        this.knowledgeSeeded = true
        this.state.knowledgeSeed = { ...clone(report), observed_at_ms: this.now(), historical: true }
        await this.save()
        await this.event('pursuit.knowledge_seeded', 'trusted_predicate_native_dependencies', report)
      }
      let planningObservation, planningAt
      if (typeof this.adapter.planningObservation === 'function') {
        budget.startedAt ??= this.now()
        await this.save()
        const known = new Set(this.state.entityKnowledge.map(row => row.unit_number))
        const readUnits = new Set()
        let lastReadAt = this.now()
        const planningFence = async () => {
          const current = await this.fence(generation)
          check(batchWatermark(current.runtime) && Number.isSafeInteger(current.runtime?.batch_generation)
            && Number.isSafeInteger(current.runtime?.queue_length) && typeof current.runtime?.task_state === 'string', 'native_status_unreadable')
          check(current.runtime.task_state === 'idle' && current.runtime.queue_length === 0, 'unowned_native_work')
          const at = this.now()
          check(at >= budget.startedAt && at >= lastReadAt, 'wall_clock_regressed')
          check(at - budget.startedAt < budget.maxWallMs, 'wall_budget_exhausted')
          lastReadAt = at
          return current
        }
        await planningFence()
        planningObservation = await this.adapter.planningObservation(clone(this.state.entityKnowledge), async read => {
          check(read?.name === 'getEntityStatus' && Object.keys(read.args ?? {}).length === 1
            && known.has(read.args.unit_number) && !readUnits.has(read.args.unit_number) && readUnits.size < 4, 'planning_read_scope_invalid')
          toolCommand(read.name, read.args)
          readUnits.add(read.args.unit_number)
          await planningFence()
          const raw = await this.adapter.observe(clone(read))
          await planningFence()
          return { raw, observed_at_ms: this.now() }
        })
        check(Array.isArray(planningObservation) && planningObservation.length <= 4
          && JSON.stringify(planningObservation).length <= 16000, 'planning_observation_limit')
        world = await planningFence()
        planningAt = this.now()
        await this.event('pursuit.planning_entities_refreshed', 'bounded_current_known_machine_reads',
          { reads: readUnits.size, unreadable: planningObservation.filter(row => row.read === false).length })
        const power = planningObservation.filter(row => row.read === true && row.found === true && row.entity?.energy_source === 'electric')
          .map(row => ({ unit_number: row.entity.unit_number, observed_at_ms: row.observed_at_ms,
            status_name: row.entity.status_name, energy_source: row.entity.energy_source,
            energy: row.entity.energy, electric_network_id: row.entity.electric_network_id }))
        if (power.length) await this.event('pursuit.planning_power_observed', 'native_machine_power_facts', { machines: power })
      }
      world = await this.fence(generation)
      packetAt = this.now()
      if (budget.startedAt !== null && (packetAt < budget.startedAt || (planningAt !== undefined && packetAt < planningAt))) return this.pause('wall_clock_regressed')
      if (budget.startedAt !== null && packetAt - budget.startedAt >= budget.maxWallMs) return this.pause('wall_budget_exhausted')
      if (world.runtime.task_state !== 'idle' || world.runtime.queue_length !== 0) return this.pause('unowned_native_work')
      // Compact from durable facts each time, never a model-generated summary
      // of receipt history. Strategy is explicitly non-authoritative.
      const packet = { objective: this.state.objective, predicate: this.state.predicate,
        notes: this.state.notes, actor: this.state.actor, world: { ...world.observation, snapshot_read_completed_at_ms: packetAt,
          ...(planningObservation ? { known_entities: planningObservation } : {}) },
        receipts: this.state.history, observations: this.state.observations, recipeKnowledge: this.state.recipeKnowledge,
        entityKnowledge: this.state.entityKnowledge, fluidSourceKnowledge: this.state.fluidSourceKnowledge,
        knowledgeSeed: this.state.knowledgeSeed, verification,
        remainingCalls: budget.maxCalls - budget.calls,
        remainingWallMs: budget.startedAt === null ? budget.maxWallMs : budget.maxWallMs - (packetAt - budget.startedAt) }
      const inputChars = this.provider.inputChars ? this.provider.inputChars(clone(packet)) : JSON.stringify(packet).length
      check(Number.isSafeInteger(inputChars) && inputChars > 0, 'provider_input_accounting_invalid')
      if (budget.inputChars + inputChars > budget.maxInputChars) return this.pause('input_budget_exhausted')
      const started = this.now()
      budget.startedAt ??= started
      budget.calls++ // Failed, planning and correction attempts cost a slot.
      budget.inputChars += inputChars
      await this.save() // Crash/restart cannot reset reservations.
      await this.event('pursuit.provider_reserved', reason, { call: budget.calls, input_chars: inputChars,
        packet_at_ms: packetAt, packet_remaining_wall_ms: packet.remainingWallMs })
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
      const metric = { call: budget.calls, latency_ms: this.now() - started, input_chars: inputChars,
        ...(answer?.decision || answer?.refusal ? { usage: clone(answer.usage ?? null) } : {}) }
      this.state.metrics.push(metric)
      this.state.metrics = this.state.metrics.slice(-30)
      await this.save()
      await this.event('pursuit.provider_received', 'provider_response_accounted', metric)
      if (answer?.refusal !== undefined) {
        const refusal = answer.refusal
        check(refusal?.code === 'pursuit_wire_envelope_invalid' && typeof refusal.message === 'string'
          && refusal.message.length <= 300 && Object.keys(refusal).every(key => ['code', 'message'].includes(key)), 'provider_refusal_invalid')
        this.state.observations = rememberObservations(this.state.observations, [{ name: 'decision_validation',
          result: JSON.stringify({ ok: false, ...refusal }), observed_at_ms: this.now(), historical: false }])
        await this.save()
        await this.event('pursuit.decision_refused', 'invalid_decision_envelope', { code: refusal.code })
        return this.snapshot()
      }
      let decision
      try { decision = pursuitDecision(answer?.decision ?? answer) }
      catch (error) {
        // A deterministic operation/argument policy rejection is correctable
        // evidence, never permission to execute it. Other structural violations
        // and provider failures still pause.
        if (!(error instanceof PolicyError)) throw error
        this.state.observations = rememberObservations(this.state.observations, [{ name: 'decision_validation',
          result: JSON.stringify({ ok: false, code: 'invalid_decision_argument', message: error.message.slice(0, 300) }),
          observed_at_ms: this.now(), historical: false }])
        await this.save()
        await this.event('pursuit.decision_refused', 'invalid_bounded_argument', { message: error.message.slice(0, 300) })
        return this.snapshot()
      }
      if (decision.notes !== undefined) this.state.notes = decision.notes
      await this.event('pursuit.decision', 'bounded_model_decision', { call: budget.calls, operations: decision.operations.length, observations: decision.observations.length })
      if (decision.pauseReason) return this.pause(`provider_reported:${decision.pauseReason}`)
      if (decision.observations.length) {
        const observations = []
        let fluidPositiveReads = 0
        for (const read of decision.observations) {
          await this.fence(generation)
          const raw = await this.adapter.observe(clone(read))
          await this.fence(generation)
          const observedAt = this.now()
          this.state.recipeKnowledge = rememberRecipeKnowledge(this.state.recipeKnowledge, read, raw, observedAt)
          this.state.entityKnowledge = rememberEntities(this.state.entityKnowledge, read, raw, observedAt)
          const fluidSources = rememberFluidSources(this.state.fluidSourceKnowledge, read, raw, observedAt)
          if (fluidSources !== this.state.fluidSourceKnowledge) fluidPositiveReads++
          this.state.fluidSourceKnowledge = fluidSources
          observations.push({ ...read, result: observationText(raw), observed_at_ms: observedAt, historical: false })
        }
        this.state.observations = rememberObservations(this.state.observations, observations)
        await this.save()
        await this.event('pursuit.observations_retained', 'bounded_native_read_memory', { fresh: observations.length, retained: this.state.observations.length })
        if (decision.observations.some(read => read.name === 'getFluidSourceTiles')) {
          await this.event('pursuit.fluid_source_knowledge_retained', 'historical_native_tile_locations_only', { positive_reads: fluidPositiveReads, retained: this.state.fluidSourceKnowledge.length })
        }
        if (decision.observations.some(read => read.name === 'getRecipeDetails')) {
          await this.event('pursuit.recipe_knowledge_retained', 'native_prototype_quantities_only', { retained: this.state.recipeKnowledge.length })
        }
        return this.snapshot() // Driver wakes on these newly completed reads.
      }
      if (!decision.operations.length) return this.pause('provider_no_progress')
      // Physical and grant checks are a required adapter contract, performed
      // immediately before reserving immutable dispatch identity.
      const admission = await this.adapter.admit(clone(decision.operations), clone(world.actor))
      world = await this.fence(generation)
      if (admission?.ok !== true) {
        // Pre-dispatch refusal ran no actions. Keep bounded read evidence as
        // historical, without presenting mutable facts as current authority.
        this.state.observations = rememberObservations(this.state.observations, [{ name: 'admission',
          result: observationText(JSON.stringify(admission)), observed_at_ms: this.now(), historical: false }])
        await this.save()
        await this.event('pursuit.admission_refused', 'native_or_permission_refusal', { admission })
        return this.snapshot()
      }
      if (Number.isSafeInteger(world.runtime.admission_high_water)) this.state.ordinal = Math.max(this.state.ordinal, world.runtime.admission_high_water)
      const ordinal = ++this.state.ordinal
      this.state.pending = buildPendingOperation({ requestId: this.state.request_id,
        operationKey: `${this.state.request_id}/batch_${ordinal}`, ordinal, protocolVersion: 2,
        operations: decision.operations, goalId: this.state.request_id, actor: world.actor,
        baseline: batchWatermark(world.runtime), now: this.now() })
      // Historical action arguments explain what exact receipts settled. They
      // are never a replay source; only the fresh validated decision dispatches.
      this.state.pending.requested_actions = clone(decision.operations)
      await this.save()
      await this.event('pursuit.dispatch_reserved', 'native_admission_passed', { operation_key: this.state.pending.operation_key, signature: this.state.pending.signature })
      await this.fence(generation)
      const deadlineAt = budget.startedAt + budget.maxWallMs
      if (this.now() >= deadlineAt) return this.pause('wall_budget_exhausted')
      // Pending is retained on every transport exception. Only exact native
      // reconciliation can make another dispatch possible after this point.
      const acknowledgement = await this.adapter.dispatch(clone(decision.operations), clone(this.state.pending), { deadlineAt })
      await this.event('pursuit.dispatch_acknowledged', 'native_acknowledgement_received', { operation_key: this.state.pending.operation_key, acknowledgement })
      await this.fence(generation)
      return this.snapshot()
    }
    catch (error) {
      if (this.state.pending && (error.notSent === true || error.notAdmitted === true)) {
        // Only the trusted transport/native begin refusal can prove this.
        // Provider exceptions and lost acknowledgements never carry this proof.
        this.state.history = [...this.state.history, { ...this.state.pending,
          verdict: RECONCILE_VERDICT.NOT_ADMITTED, effect: 'not_happened', reason: 'trusted_transport_proved_not_admitted' }].slice(-16)
        this.state.pending = null
        await this.save()
        await this.event('pursuit.not_admitted', 'trusted_transport_proved_not_admitted')
      }
      await this.event('pursuit.failure', 'fail_closed', { code: String(error.message).slice(0, 300) })
      return this.pause(String(error.message).slice(0, 300))
    }
    finally { this.busy = false }
  }
}
