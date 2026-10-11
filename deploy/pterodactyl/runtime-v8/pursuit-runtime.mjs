import fsp from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { GoalPursuit, newPursuit } from './goal-pursuit.mjs'
import { deploymentStatus, executeAuthorizedBatch, actorChanged } from './supervisor-adapter.mjs'
import { pursuitOperationListText, pursuitDeniedOperationNames, toolDefinitions, toolCommand, renderOperation, renderOperationPreflight, luaString, parseOperation, pursuitDecisionToolDefinition } from './structured-policy.mjs'
import { sanitizeGoalDefinition, evaluateGoalDefinition } from './goal-definition.mjs'
import { createEmptyAuthorization, evaluateOperationAdmission, entityProtection, recordReservation, releaseReservation, restoreAuthorization } from './authorization.mjs'

const copy = value => structuredClone(value)
const check = (ok, message) => { if (!ok) throw new Error(message) }
const json = raw => JSON.parse(String(raw).trim())
const actorView = actor => ({ actor_id: actor.actor_id, epoch: actor.epoch, mode: actor.mode, actor_kind: actor.actor_kind })
const AMBIGUOUS = new Set(pursuitDeniedOperationNames)
const EXACT_MUTATIONS = new Set(['mine_entity_exact', 'rotate_entity_exact', 'set_machine_recipe', 'move_items_exact', 'supply_entity'])

export const PURSUIT_PROMPT = `You control a standalone Factorio character through a bounded pursuit harness.
Native Factorio actions ARE available through the external harness. When submitPursuitDecision is available, call it with your decision; otherwise return the same decision envelope as JSON. The harness validates and executes the bounded requests and returns their native receipts.
Pursue the immutable user objective and trusted done-when predicate in the packet. Choose observations, the next native action batch, strategy and recovery yourself. Notes may evolve; a dispatched batch cannot change identity. Native actions and factory production continue while you think.
Reply with ONE JSON object containing exactly a decision field. The decision object uses only notes (optional strategic memory, max 2000 chars), operations (1-16), observations (1-4 approved read requests {name,args}), or pauseReason (max 300 chars). Choose only one of operations, observations, or pauseReason per decision. For example, a knowledge request is {"decision":{"observations":[{"name":"getInventoryItems","args":{}}]}}. Empty arrays cannot request anything. Do not emit a plan, stepId, tool_calls, generated Lua, shell, goal replacement or completion claim.
Only trusted game state proves success. Receipts distinguish admitted, running, completed, refused and uncertain effects. Never replay uncertain work, treat an admission as completion, or invent prototype names, entity IDs, recipes or game mechanics. Use approved tools to inspect what you need. Native preflight refusal is evidence for recovery, not proof the world cannot support the goal. Empty decisions pause. Use native wait for a bounded condition check when appropriate.
Missing materials or knowledge are reasons to choose observations or acquisition actions. Pause only for a concrete blocker requiring owner intervention or an observed unavailable capability; name the blocker and supporting observation in pauseReason. Use the decision submission interface to request observations or native actions. harvest_product is restricted to unowned neutral natural trees/rocks; buildings and player-touched sources cannot be harvested.
Choose the smallest executable progress action after verifying its essential facts. Do not gather a complete factory plan before acquiring an available input. Read results remain in bounded memory across observation turns; historical:true marks older reads whose mutable inventory, targets or machine state may be stale. Re-read those facts when needed for an exact action, and use retained prototype/recipe knowledge instead of repeatedly requesting unchanged rules. Validation feedback describes a refused request; correct its bounded arguments without claiming an action occurred.
The packet already supplies current inventory, task state and actor position when available; avoid redundant reads of those facts. Use remainingCalls and remainingWallMs to conserve the campaign allowance. remainingWallMs is the time left when this packet was built; thinking, walking, mining, crafting and machine production all consume it. It does not reset after actions or restart. Choose work that can finish within the remaining time using verified native facts; do not invent throughput estimates. Batch compatible approved actions in dependency order when their facts are verified, and consider concurrent machine production using equipment already held instead of doing all work sequentially by hand. Acquire enough inputs for both the goal and its prerequisites, based on native recipe knowledge. Keep concise recipe quantities and strategy in notes for the next action boundary.
recipeKnowledge retains compact native prototype quantities across actions; complete:false means quantities are incomplete and cannot support input calculations. It contains historical recipe rules, not current inventory, unlock status, target identity or admission. Use complete retained recipes without repeatedly re-reading unchanged ingredients. Inspect fresh mutable facts when required for execution.
Receipt requested_actions describes historical submitted quantities and targets. Use exact receipt verdicts together with current inventory to recognize completed work; never blindly repeat those actions or treat their targets as fresh.
Keep player-built structures and reserved supplies intact. Use exact targets for mutations/withdrawals; ambiguous destructive operations and player inventory withdrawal are refused. Inputs marked historical may be stale; re-observe exact targets. Resume/restarts share one cumulative call, wall-time and input allowance.
Place a held machine as its own action boundary when its future native identity is needed. After its exact placement receipt settles, observe the new entity and use the observed unit_number in a later supply/recipe action. Never guess a future unit_number or supply a machine in the batch that creates it. Use placement candidates or verified unobstructed positions; ambiguous clearing operations are unavailable. move_items may only supply entities (to_entity:true); move_items_with_player may only give items (to_player:true).
Approved operations and argument shapes: ${pursuitOperationListText()}
Approved observation request schemas (these are JSON requests to the external harness): ${JSON.stringify(toolDefinitions.map(tool => ({ name: tool.function.name, description: tool.function.description, args: tool.function.parameters })))}`

export function pursuitMessages(packet) {
  return [{ role: 'system', content: PURSUIT_PROMPT }, { role: 'user', content: JSON.stringify(packet) }]
}

export function renderPursuitOperation(raw) {
  const operation = parseOperation(raw)
  if (operation.name !== 'harvest_product') return renderOperation(operation)
  // Parsing/identity still uses the approved bounded harvest operation. Only
  // this adapter routes it to the stricter native source-selection interface.
  const args = operation.args
  return `remote.call('autorio_operations','harvest_natural_product',${luaString(args.product_name)},${args.count},${args.search_radius})`
}

function pursuitPreflight(operation) {
  if (operation.name !== 'harvest_product') return renderOperationPreflight(operation)
  return `/silent-command rcon.print(helpers.table_to_json(remote.call('autorio_preflight','operation','harvest_natural_product',{product_name=${luaString(operation.args.product_name)}})))`
}

export function pursuitProvider(provider, reserve = async () => {}) {
  const call = async (packet, context) => {
    await reserve(context)
    check(!context.signal.aborted, 'pursuit_cancelled')
    const message = await provider(pursuitMessages(packet), { ...context, allowTools: false,
      controlProtocol: 'pursuit', role: 'planner', triggerSource: 'pursuit', requestBodyPatch: { max_tokens: 4000 } })
    const calls = message.tool_calls ?? []
    check(Array.isArray(calls) && (calls.length === 0 || (calls.length === 1 && calls[0]?.type === 'function' && calls[0].function?.name === 'submitPursuitDecision')), 'pursuit_wire_tools_refused')
    check(!['length', 'content_filter', 'safety', 'blocked'].includes(message._sglunaProvider?.finish_reason), 'pursuit_provider_incomplete')
    const parsed = json(calls.length ? calls[0].function.arguments : message.content)
    if (parsed?.decision !== undefined && Object.keys(parsed).length !== 1) {
      // Refuse the whole well-formed reply, including its action payload. This
      // is correctable format feedback, never authority to strip extra fields.
      return { refusal: { code: 'pursuit_wire_envelope_invalid',
        message: 'Submit exactly {"decision":{...}}. Put notes inside decision. No fields beside decision. The entire prior reply was refused; no observations or actions ran.' },
      usage: copy(message._sglunaProvider?.usage ?? null) }
    }
    return { decision: parsed.decision ?? parsed, usage: copy(message._sglunaProvider?.usage ?? null) }
  }
  // Includes the stable instruction/tool prefix, not just the observation packet.
  call.inputChars = packet => JSON.stringify(pursuitMessages(packet)).length + JSON.stringify(pursuitDecisionToolDefinition).length
  return call
}

export function ownerPursuitGoal(raw) {
  check(raw && typeof raw.objective === 'string' && raw.objective.trim() && raw.objective.length <= 4000, 'owner_objective_required')
  check(Object.keys(raw).every(key => ['objective', 'predicate'].includes(key)), 'owner_goal_unknown_field')
  return { objective: raw.objective, predicate: sanitizeGoalDefinition(raw.predicate) }
}

// JSON goals come from the authenticated human intake, never from the provider.
// A configured goal matches the exact incoming objective. Other free-text goals
// need owner conditions instead of silently guessing what proves completion.
export function pursuitIntake(text, configuredGoal) {
  if (configuredGoal && text === configuredGoal.objective) return ownerPursuitGoal(configuredGoal)
  try { return ownerPursuitGoal(json(text)) }
  catch { throw new Error('Direct pursuit needs an owner goal: {"objective":"...","predicate":{"scope":"finite","summary":"...","doneWhen":[...]}}. No action or provider call was made.') }
}

async function durableWrite(filename, value) {
  await fsp.mkdir(path.dirname(filename), { recursive: true })
  const temp = `${filename}.tmp-${randomUUID()}`
  const handle = await fsp.open(temp, 'wx', 0o600)
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync() }
  finally { await handle.close() }
  await fsp.rename(temp, filename)
  // The deployed runtime is Linux. Sync the directory entry after rename.
  if (process.platform !== 'win32') {
    const directory = await fsp.open(path.dirname(filename), 'r')
    try { await directory.sync() } finally { await directory.close() }
  }
}

export class PursuitRuntime {
  constructor({ rcon, provider, reserve, stateFile, traceFile, ownerGoal, npcId = 'sgluna', onActivity = () => {}, now = Date.now }) {
    Object.assign(this, { rcon, stateFile, traceFile, ownerGoal, npcId, onActivity, now })
    this.provider = pursuitProvider(provider, reserve)
    this.authorization = createEmptyAuthorization()
    this.archives = []
    this.loop = null
    this.loaded = false
    this.driving = false
    this.saveQueue = Promise.resolve()
    this.memory = {
      currentPlan: () => this.currentState(),
      planningState: () => this.loop ? { goal: { goal_id: this.loop.state.request_id, status: this.loop.state.status,
        objective: this.loop.state.objective, definition: this.loop.state.predicate } } : undefined,
      recordReservation: (_key, raw, options) => this.reservation(recordReservation, raw, options),
      releaseReservation: (_key, raw, options) => this.reservation(releaseReservation, raw, options),
    }
  }

  get active() { return this.loop?.state.status === 'active' }
  activePlanKey() { return `npc:${this.npcId}` }
  currentState() {
    const state = this.loop?.snapshot()
    return state ? { goal_id: state.request_id, objective: state.objective, owner: state.owner ?? '',
      status: state.status, pause_reason: state.pauseReason ?? '', plan: [], current_step: 0,
      last_chat_message: state.notes, task_board: undefined } : undefined
  }

  async traceEvent(event, data = {}) {
    const row = { at: this.now(), event, request_id: this.loop?.state.request_id ?? 'pursuit_intake',
      reason: data.reason ?? 'pursuit_runtime', ...copy(data) }
    if (this.traceFile) {
      await fsp.mkdir(path.dirname(this.traceFile), { recursive: true })
      await fsp.appendFile(this.traceFile, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    }
    this.onActivity(event, row)
  }

  async persistState(current = this.loop?.snapshot()) {
    const envelope = { version: 1, current: current ?? null, budget: current?.budget ?? this.budget ?? null,
      authorization: copy(this.authorization), archives: copy(this.archives) }
    const write = this.saveQueue.then(() => durableWrite(this.stateFile, envelope))
    this.saveQueue = write // A storage failure poisons later writes; no provider dispatch follows.
    await write
    this.budget = copy(envelope.budget)
  }

  reservation(reducer, raw, options = {}) {
    const result = reducer(this.authorization, raw, options.now ?? this.now())
    if (result.auth) this.authorization = result.auth
    return { ...result, ok: Boolean(result.auth) }
  }

  install(state) {
    this.loop = new GoalPursuit({ state, provider: this.provider, now: this.now, adapter: {
      world: () => this.world(), verify: predicate => this.verify(predicate),
      observe: async read => this.rcon.command(toolCommand(read.name, read.args)),
      admit: (operations, actor) => this.admit(operations, actor),
      dispatch: (operations, pending, options) => this.dispatch(operations, pending, options),
      save: state => this.persistState(state), trace: row => this.traceEvent(row.event, row),
    } })
  }

  async loadPersistentState() {
    if (this.loaded) return
    let envelope
    try { envelope = json(await fsp.readFile(this.stateFile, 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (envelope) {
      check(envelope.version === 1 && Array.isArray(envelope.archives), 'pursuit_storage_invalid')
      check(envelope.authorization?.world && Array.isArray(envelope.authorization.world.reservations)
        && Array.isArray(envelope.authorization.world.npc_placements), 'pursuit_authorization_invalid')
      this.authorization = restoreAuthorization(envelope.authorization) ?? createEmptyAuthorization()
      check(this.authorization.world.reservations.length === envelope.authorization.world.reservations.length,
        'pursuit_reservations_corrupt')
      this.archives = envelope.archives
      this.budget = envelope.budget
      check(!envelope.budget || envelope.current, 'pursuit_campaign_without_current_state')
      if (envelope.current) {
        check(JSON.stringify(envelope.budget) === JSON.stringify(envelope.current.budget), 'pursuit_campaign_budget_mismatch')
        this.install(envelope.current) // Validates restored budget; never falls back to a new allowance.
        check(sanitizeGoalDefinition(envelope.current.predicate, { trusted: true }).done_when.length > 0, 'pursuit_predicate_invalid')
      }
    }
    this.loaded = true
  }

  async world() {
    const actor = actorView(await deploymentStatus(this.rcon, { requireAllowed: true }))
    const runtime = json(await this.rcon.command(toolCommand('getTaskStatus', {})))
    const admissions = json(await this.rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operation_admission","status")))'))
    check(Number.isSafeInteger(admissions.high_water) && admissions.high_water >= 0, 'pursuit_native_ordinal_unreadable')
    runtime.admission_high_water = admissions.high_water
    // This approved tool prints serpent text, not JSON. Keep its bounded native
    // observation verbatim rather than interpreting it as authoritative state.
    const inventory = String(await this.rcon.command(toolCommand('getInventoryItems', {})))
    const after = actorView(await deploymentStatus(this.rcon, { requireAllowed: true }))
    check(!actorChanged(actor, after), 'pursuit_stale_actor')
    return { actor, runtime, observation: { inventory, actor_position: copy(runtime.actor?.position), task_state: runtime.task_state, queue_length: runtime.queue_length,
      reservations: this.authorization.world.reservations.filter(row => row.status === 'active') } }
  }

  async verify(predicate) {
    const result = await evaluateGoalDefinition(predicate, command => this.rcon.command(command))
    return { read: result.results.every(row => !row.error), satisfied: result.satisfied, results: result.results }
  }

  async admit(operations, actor) {
    const preflight = []
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]
      if (AMBIGUOUS.has(operation.name) || (operation.name === 'move_items' && operation.args.to_entity === false)
        || (operation.name === 'move_items_with_player' && operation.args.to_player === false)) {
        return { ok: false, code: 'pursuit_ambiguous_or_player_mutation', operation: operation.name, operation_index: index }
      }
      if (operation.name === 'harvest_product' && this.authorization.world.reservations.some(row => row.status === 'active')) {
        return { ok: false, code: 'pursuit_harvest_reserved_world', operation_index: index }
      }
      const before = actorView(await deploymentStatus(this.rcon, { requireAllowed: true }))
      check(!actorChanged(actor, before), 'pursuit_stale_actor')
      const command = pursuitPreflight(operation)
      const result = command ? json(await this.rcon.command(command)) : { ok: true }
      const after = actorView(await deploymentStatus(this.rcon, { requireAllowed: true }))
      check(!actorChanged(actor, after), 'pursuit_stale_actor')
      preflight.push(result)
      if (result.ok !== true) return { ...result, operation_index: index }
      if (operation.name === 'harvest_product' && result.natural_only !== true) return { ok: false, code: 'pursuit_natural_guard_unavailable', operation_index: index }
      if (operation.name === 'harvest_product') await this.traceEvent('pursuit.natural_harvest_admitted', { reason: 'native_natural_source_guard_verified', product_name: operation.args.product_name })
      if (EXACT_MUTATIONS.has(operation.name)) {
        // Exact preflight must positively provide target identity/ownership.
        if (!result.target) return { ok: false, code: 'pursuit_target_ownership_unreadable', operation_index: index }
        const protection = entityProtection(this.authorization, { unit_number: operation.args.unit_number,
          last_user: result.target.last_user }, { goalId: this.loop.state.request_id })
        if (protection.protected) return { ok: false, code: 'protected_entity', operation_index: index, ...protection }
      }
    }
    return evaluateOperationAdmission({ authorization: this.authorization, goal: { goal_id: this.loop.state.request_id } },
      { operations, preflight, actor: { actor_id: actor.actor_id, actor_epoch: actor.epoch } })
  }

  async dispatch(operations, pending, { deadlineAt }) {
    const loop = this.loop
    const generation = loop.generation
    // All await barriers end before the final expiry check/native command.
    const admission = await this.admit(operations, pending.actor.mode ? pending.actor : this.loop.state.actor)
    check(admission.ok === true, `pursuit_final_admission_refused:${admission.code}`)
    check(this.active && loop.generation === generation && this.now() < deadlineAt, 'wall_budget_exhausted')
    return executeAuthorizedBatch(this.rcon, pending.actor.epoch, operations.map(renderPursuitOperation), undefined, pending,
      { requireIdle: true, deadlineAt, isCurrent: () => this.loop === loop && loop.generation === generation && this.active })
  }

  async request(text, { sender = 'owner' } = {}) {
    await this.loadPersistentState()
    if (/^\s*(?:resume|continue)\s*[.!]?\s*$/i.test(text)) {
      check(this.loop, 'pursuit_no_goal_to_resume')
      this.loop.state.status = 'active'
      delete this.loop.state.pauseReason
      await this.persistState()
      return this.drive('owner_resume')
    }
    const goal = pursuitIntake(text, this.ownerGoal)
    // Owner replacement cannot erase an unresolved operation or reset budgets.
    check(!this.loop?.state.pending, 'pursuit_pending_effect_blocks_new_goal')
    if (this.loop) {
      await this.loop.cancel('owner_new_goal')
      this.archives = [...this.archives, this.loop.snapshot()].slice(-16)
    }
    const world = await this.world()
    let predicate = goal.predicate
    const evaluation = await evaluateGoalDefinition(predicate, command => this.rcon.command(command), { samples: 1 })
    predicate = { ...predicate, done_when: predicate.done_when.map(row => ({ ...row,
      ...(evaluation.baselines[row.id] !== undefined ? { baseline: evaluation.baselines[row.id] } : {}) })) }
    check(predicate.done_when.every(row => !['items_produced', 'items_consumed', 'rockets_launched'].includes(row.kind)
      || row.count_from === 'save_start' || Number.isSafeInteger(row.baseline)), 'pursuit_goal_baseline_unreadable')
    const state = newPursuit({ objective: goal.objective, predicate, actor: world.actor })
    if (this.budget) state.budget = copy(this.budget)
    state.ordinal = Math.max(this.loop?.state.ordinal ?? 0, world.runtime.admission_high_water)
    state.owner = sender
    this.install(state)
    await this.persistState()
    await this.traceEvent('pursuit.goal_accepted', { reason: 'owner_predicate_bound', objective: state.objective, predicate })
    return this.drive('owner_intake')
  }

  async drive(reason) {
    if (this.driving || !this.active) return this.result()
    this.driving = true
    try {
      // Only read completion/refusal transitions trigger immediate decisions.
      // Running native work returns to the receipt/condition poll, with no call.
      while (this.active) {
        await this.loop.wake(reason)
        if (!this.active || this.loop.state.pending) break
        reason = 'observation_or_refusal_ready'
      }
      return this.result()
    }
    finally { this.driving = false }
  }

  result() {
    const state = this.currentState()
    return state ? { goalStatus: state.status, goalId: state.goal_id,
      chatMessage: state.status === 'completed' ? 'The owner goal predicate is verified complete.'
        : state.status === 'paused' ? `Pursuit paused: ${state.pause_reason}. Say Resume to reconcile and continue within the same allowance.` : '' } : {}
  }
  completed() { return this.drive('native_receipt') }
  failed() { return this.drive('native_failure') }
  pollPursuit() { return this.drive('native_condition_poll') }
  async cancel(reason) { await this.loop?.cancel(reason) }
  async pausePersistentPlan(reason) { await this.cancel(reason); return this.currentState() }
}
