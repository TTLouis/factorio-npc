import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { TICK_SPRINT } from '../staging/tick-sprint-policy.mjs'
import { deploymentStatus } from '../staging/supervisor-adapter.mjs'
import { taskBoardUiRconCommand } from './common.mjs'

export { sprintSpeedValid, summarizeTickSprints, TICK_SPRINT } from '../staging/tick-sprint-policy.mjs'

const lua = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
export const sprintCommand = (method, ...args) => `/silent-command rcon.print(helpers.table_to_json(remote.call("sgluna_tick_sprint",${lua(method)}${args.map(arg => `,${typeof arg === 'object' ? `helpers.json_to_table(${lua(JSON.stringify(arg))})` : lua(arg)}`).join('')})))`

export async function pauseSprintStartup(rcon) {
  const status = JSON.parse(await rcon.command(`/silent-command game.tick_paused=true;local s=remote.call("sgluna_tick_sprint","finish","startup_reconciliation");s.tick_paused=game.tick_paused;rcon.print(helpers.table_to_json(s))`))
  if (status.speed !== 1 || status.tick_paused !== true || status.lease || status.version !== TICK_SPRINT.version) throw new Error('Sprint startup restoration unconfirmed')
  return status
}

export const STARTUP_CLOCK_COMMAND = '/silent-command local w=remote.call("autorio_operations","status");rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players,idle=w.task_state=="idle" and w.queue_length==0,guard=remote.call("sgluna_tick_sprint","status")}))'

export async function probeSprintStartupClock(rcon, { sleep = delay, monotonic = () => performance.now() } = {}) {
  let before
  try {
    await rcon.command('/silent-command game.tick_paused=false')
    before = JSON.parse(await rcon.command(STARTUP_CLOCK_COMMAND))
    const valid = sample => sample.speed === 1 && sample.paused === false && sample.humans === 0 && sample.idle === true && Number.isSafeInteger(sample.tick)
    if (!valid(before)) throw new Error('Sprint startup clock native state is unsafe')
    const started = monotonic()
    // No observations/heartbeats during this interval. Console traffic itself
    // advances paused-server ticks, so a positive tick delta is insufficient.
    await sleep(1000)
    const after = JSON.parse(await rcon.command(STARTUP_CLOCK_COMMAND))
    const elapsed = monotonic() - started
    if (!valid(after) || elapsed < 1000 || elapsed > 5000) throw new Error('Sprint startup clock observation is unsafe or uncertain')
    if (after.tick - before.tick < elapsed * 30 / 1000) {
      throw Object.assign(new Error('Sprint startup clock is not independently advancing'), { code: 'sprint_startup_clock_stalled', before, after, elapsed_ms: elapsed })
    }
    return { before, after, elapsed_ms: elapsed, native_tick_delta: after.tick - before.tick, minimum_ticks_per_second: 30 }
  } finally { await pauseSprintStartup(rcon) }
}

export async function initializeSprintStartupClock({ rcon, restartAtNormalSpeed, binding, load, persist, record = () => {}, probeOptions }) {
  await pauseSprintStartup(rcon())
  if (binding?.profile !== 'accelerated' || !/^[a-f0-9]{40}$/.test(binding.source_sha)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(binding.run_id)) throw new Error('Invalid frozen startup binding')
  const saved = await load()
  if (saved && (saved.run_id !== binding.run_id || saved.source_sha !== binding.source_sha || saved.attempts !== 1
    || !['attempted', 'completed', 'exhausted'].includes(saved.state))) throw new Error('Invalid durable startup clock recovery ledger')
  if (saved && saved.state !== 'completed') throw new Error('Sprint startup clock recovery exhausted')
  // auto_pause cannot be changed with /config in Factorio2.0.77. Persist the
  // replicated paused1x world, then reload it with authoritative settingsfalse.
  await restartAtNormalSpeed()
  try {
    const proof = await probeSprintStartupClock(rcon(), probeOptions)
    await record({ reason: 'startup_clock_verified', recovery_attempts: 0, ...proof })
    return proof
  } catch (error) {
    if (error.code !== 'sprint_startup_clock_stalled') throw error
    if (saved?.attempts === 1) {
      await persist({ ...binding, attempts: 1, state: 'exhausted', reason: error.code })
      throw new Error('Sprint startup clock recovery exhausted')
    }
    await persist({ ...binding, attempts: 1, state: 'attempted', reason: error.code })
    await record({ reason: 'startup_clock_recovery_attempted', before: error.before, after: error.after, elapsed_ms: error.elapsed_ms })
    await restartAtNormalSpeed()
    try {
      const proof = await probeSprintStartupClock(rcon(), probeOptions)
      await persist({ ...binding, attempts: 1, state: 'completed', reason: 'startup_clock_recovery_completed' })
      await record({ reason: 'startup_clock_recovery_completed', recovery_attempts: 1, ...proof })
      return proof
    } catch (failure) {
      await persist({ ...binding, attempts: 1, state: 'exhausted', reason: 'startup_clock_recovery_exhausted' })
      await record({ reason: 'startup_clock_recovery_exhausted', recovery_attempts: 1 })
      throw new Error('Sprint startup clock recovery exhausted', { cause: failure })
    }
  }
}

export async function persistSprintLedger(filename, ledger) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.tmp`
  const file = await fs.open(temporary, 'w', 0o600)
  try { await file.writeFile(`${JSON.stringify(ledger)}\n`); await file.sync() }
  finally { await file.close() }
  await fs.rename(temporary, filename)
}

export async function resumeSprintStartup(rcon) {
  const proof = await probeSprintStartupClock(rcon)
  const status = JSON.parse(await rcon.command('/silent-command game.tick_paused=false;rcon.print(helpers.table_to_json({speed=game.speed,paused=game.tick_paused}))'))
  if (status.speed !== 1 || status.paused !== false) throw new Error('Sprint startup resume unconfirmed')
  return proof
}

export function sprintOwner(session) {
  const agent = session.agent
  if (!agent || !session.ready || session.stopping || session.controllerEventRunning
    || session.controllerQueuedEvents || agent.controllerBusyCount || agent.turnDepth
    || agent.stepContractsInFlight?.size || agent.contractPrediction && !agent.contractPrediction.settled
    || agent.currentPendingAmendment?.()) return undefined
  const key = agent.activePlanKey()
  const planning = agent.memory.planningState(key)
  const plan = getActivePlan(planning)
  const pending = agent.memory.pendingOperation(key)
  const board = agent.memory.currentPlan(key)?.task_board
  if (planning?.goal?.status !== 'active' || planning.run?.paused || agent.memory.pauseRecord(key)?.paused
    || !plan || ![PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(plan.status) || !agent.batchInFlight
    || pending?.state !== 'acknowledged' || pending.actor?.actor_id !== agent.epoch?.actor_id
    || pending.actor?.epoch !== agent.epoch?.epoch || pending.signature === undefined
    || pending.goal_id !== planning.goal.goal_id || pending.plan_id !== plan.plan_id
    || pending.step_id !== plan.steps[plan.active_step_index]?.step_id
    || !agent.traceRequest?.id || !board?.active_step_id) return undefined
  return { checkpoint: agent.captureCheckpointOwner(), operation_key: pending.operation_key, signature: pending.signature,
    request_id: agent.traceRequest.id, actor_id: agent.epoch.actor_id, epoch: agent.epoch.epoch,
    goal_id: planning.goal.goal_id, plan_id: plan.plan_id, plan_version: plan.plan_version,
    step_id: plan.steps[plan.active_step_index].step_id, board_step_id: plan.steps[plan.active_step_index].step_id }
}

// One public RCON barrier also covers its auxiliary UI lane. Queued supervisor
// events and guarded callbacks exclude arming across their entire async scope.
export class TickSprintController {
  constructor({ session, watchdog, ledgerFile, binding, persist, emit, now = Date.now, monotonic = () => performance.now(), sleep = delay }) {
    Object.assign(this, { session, watchdog, ledgerFile, binding, now, monotonic, sleep })
    this.raw = session.rcon.command.bind(session.rcon)
    this.tail = Promise.resolve()
    this.episodes = {}
    this.pollingInstance = randomUUID()
    this.reads = {}
    this.budgetRefusals = 0
    this.recovery = undefined
    this.persist = persist ?? (ledger => persistSprintLedger(ledgerFile, ledger))
    const write = emit ?? ((event, data) => session.agent?.traceEvent(`sprint.${event}`, data))
    this.emit = (event, data) => write(event, { ...data, polling_instance_id: this.pollingInstance, native_reads_by_lane: { ...this.reads },
      control_minute_bucket: this.readBucket, additional_control_reads_in_bucket: this.bucketReads ?? 0, control_budget_refusals: this.budgetRefusals })
  }
  control(text, lane, command = this.raw) {
    const bucket = Math.floor(this.monotonic() / 60000)
    if (this.readBucket !== bucket) { this.readBucket = bucket; this.bucketReads = 0 }
    if (this.bucketReads >= TICK_SPRINT.maxControlReadsPerMinute) {
      this.budgetRefusals++
      throw Object.assign(new Error('Sprint harness polling budget exhausted'), { code: 'sprint_polling_budget' })
    }
    this.bucketReads++
    this.reads[lane] = (this.reads[lane] ?? 0) + 1
    return command(text)
  }
  ledger() { return { ...this.binding, episodes: this.episodes, ...(this.recovery ? { polling_recovery: this.recovery } : {}) } }
  validStatus(status) {
    return status?.version === TICK_SPRINT.version && status.binding?.run_id === this.binding.run_id
      && status.binding?.source_sha === this.binding.source_sha && status.binding?.profile === this.binding.profile
  }
  assertOwner(owner) {
    if (owner && !this.session.agent?.checkpointOwnerCurrent(owner)) throw new Error('Sprint boundary owner superseded')
  }
  // A world command already needs a round trip. Confirm the native guard in that
  // same Lua invocation instead of adding a standalone finish RPC for every read.
  // The payload is withheld when restoration/freshness work is still required.
  command(text, ...args) {
    if (!/^\/silent-command\s/.test(text)) return this.boundary('rcon', () => this.raw(text, ...args))
    const owner = this.session.agent?.captureCheckpointOwner()
    const send = !this.session.rcon.auxiliary && taskBoardUiRconCommand(text) && this.session.rcon.taskBoardCommand
      ? wrapper => this.session.rcon.taskBoardCommand(wrapper) : this.raw
    return this.serial(async () => {
      this.assertOwner(owner)
      if (this.lease) await this.restore('rcon')
      for (let attempt = 0; attempt < 2; attempt++) {
        this.assertOwner(owner)
        const marker = `SPRINT_BOUNDARY_${randomUUID()}:`
        const source = text.replace(/^\/silent-command\s+/, '')
        const ready = `s.version==${lua(TICK_SPRINT.version)} and s.binding and s.binding.run_id==${lua(this.binding.run_id)} and s.binding.source_sha==${lua(this.binding.source_sha)} and s.binding.profile==${lua(this.binding.profile)} and s.speed==1 and not s.lease and (not s.last or s.last.lease_id==${lua(this.lastRestored ?? '')})`
        this.reads.boundary_inline = (this.reads.boundary_inline ?? 0) + 1
        const response = String(await send(`/silent-command do local s=remote.call("sgluna_tick_sprint","status");local ok=${ready};rcon.print(${lua(marker)}..helpers.table_to_json({guard=s,executed=ok}));if ok then do ${source}\n end end end`, ...args))
        this.assertOwner(owner)
        const lineEnd = response.indexOf('\n')
        const first = (lineEnd < 0 ? response : response.slice(0, lineEnd)).trim()
        if (!first.startsWith(marker)) throw new Error('Sprint inline boundary proof unreadable; command effect uncertain')
        const proof = JSON.parse(first.slice(marker.length))
        if (!this.validStatus(proof.guard)) throw new Error('Sprint inline boundary binding changed')
        if (proof.executed === true && proof.guard.speed === 1 && !proof.guard.lease) return lineEnd < 0 ? '' : response.slice(lineEnd + 1)
        if (proof.executed !== false) throw new Error('Sprint inline execution proof unreadable')
        if (attempt === 0) { await this.restore('inline_residual'); continue }
        throw new Error('Sprint inline boundary recovery exhausted')
      }
    }).catch(async error => { await this.fail(error, owner); throw error })
  }
  async start({ timers = true } = {}) {
    if (!this.binding || this.binding.profile !== 'accelerated' || !/^[a-f0-9]{40}$/.test(this.binding.source_sha)
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(this.binding.run_id)) throw new Error('Invalid frozen sprint binding')
    if (this.ledgerFile) {
      try {
        const saved = JSON.parse(await fs.readFile(this.ledgerFile, 'utf8'))
        if (saved.run_id !== this.binding.run_id || saved.source_sha !== this.binding.source_sha || saved.profile !== 'accelerated'
          || !saved.episodes || Array.isArray(saved.episodes) || Object.keys(saved.episodes).length > TICK_SPRINT.maxEpisodes
          || !Object.entries(saved.episodes).every(([key, value]) => /^batch-g\d+-\d+$/.test(key)
            && Number.isSafeInteger(value) && value > 0 && value <= TICK_SPRINT.episodeTicks && value % TICK_SPRINT.burstTicks === 0)) throw new Error('Invalid durable sprint ledger')
        this.episodes = saved.episodes
        if (saved.polling_recovery !== undefined) {
          const recovery = saved.polling_recovery
          if (recovery.attempts !== 1 || !Number.isSafeInteger(recovery.bucket) || recovery.bucket < 0
            || !['attempted', 'completed', 'exhausted', 'superseded'].includes(recovery.state)
            || recovery.reason !== 'sprint_polling_budget') throw new Error('Invalid durable sprint polling recovery')
          this.recovery = recovery
          if (!['completed', 'superseded'].includes(recovery.state)) throw new Error('Sprint polling recovery exhausted after restart')
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const status = JSON.parse(await this.control(sprintCommand('configure', this.binding), 'configure'))
    if (!status.ok || status.version !== TICK_SPRINT.version || status.speed !== 1 || status.lease || status.fault) throw new Error('Native sprint guard did not configure at1x')
    for (const [episode, spent] of Object.entries(status.episodes ?? {})) {
      if (!/^batch-g\d+-\d+$/.test(episode) || !Number.isSafeInteger(spent) || spent <= 0 || spent > TICK_SPRINT.episodeTicks || spent % TICK_SPRINT.burstTicks !== 0) throw new Error('Native sprint ledger unreadable')
      this.episodes[episode] = Math.max(spent, this.episodes[episode] ?? 0)
    }
    await this.persist(this.ledger())
    this.session.rcon.command = (...args) => this.command(...args)
    if (timers) {
      // Each entry point handles failure with its captured owner. Re-dispatching
      // fail here would capture a replacement and cancel the wrong request.
      this.poll = setInterval(() => { this.trySprint().catch(() => {}) }, TICK_SPRINT.pollMs)
      this.watch = setInterval(() => { this.watchdogTick().catch(() => {}) }, TICK_SPRINT.watchdogMs)
      this.poll.unref?.(); this.watch.unref?.()
    }
    await this.emit('configured', { ...this.binding, reason: 'frozen_finite_batch_profile', limits: TICK_SPRINT })
    return this
  }
  serial(fn) {
    const work = this.tail.then(fn)
    this.tail = work.catch(() => {})
    return work
  }
  async restore(reason) {
    if (this.recovery?.state === 'superseded' && ['safety_control', 'stop', 'shutdown'].includes(reason)) {
      this.reads.retired_safety_control = (this.reads.retired_safety_control ?? 0) + 1
      const status = JSON.parse(await this.watchdog.command(sprintCommand('finish', reason)))
      if (!this.validStatus(status) || status.speed !== 1 || status.lease) throw new Error('Superseded safety restoration unconfirmed')
      return status
    }
    if (this.recovery?.state === 'superseded' && this.readBucket === this.recovery.bucket) {
      const owner = this.session.agent?.captureCheckpointOwner()
      await this.waitControlWindow(this.recovery.bucket, () => !owner || this.session.agent?.checkpointOwnerCurrent(owner))
      return this.restoreConfirmed(reason, (text, lane) => this.control(text, lane), { refresh: true })
    }
    try { return await this.restoreConfirmed(reason, (text, lane) => this.control(text, lane)) }
    catch (error) {
      if (error.code !== 'sprint_polling_budget') throw error
      return this.recoverPollingBudget(reason)
    }
  }
  async waitControlWindow(bucket, current) {
    const waitMs = Math.max(1, (bucket + 1) * 60000 - this.monotonic())
    if (waitMs > 60000) throw new Error('Sprint polling recovery clock invalid')
    for (let remaining = waitMs; remaining > 0; remaining -= 100) {
      await this.sleep(Math.min(100, remaining))
      if (!current()) throw new Error('Sprint polling recovery wait superseded')
    }
    if (!current() || Math.floor(this.monotonic() / 60000) <= bucket) throw new Error('Sprint polling recovery wait exhausted or superseded')
    return waitMs
  }
  async recoverPollingBudget(reason) {
    if (this.recovery) {
      const owner = this.session.agent?.captureCheckpointOwner()
      await this.emit('polling_recovery_exhausted', { reason: 'durable_polling_recovery_used', disposition: 'safe_stop_required',
        request_id: owner?.requestTrace?.id, goal_id: owner?.goalId, plan_id: owner?.planId, plan_version: owner?.planVersion, step_id: owner?.stepId })
      throw new Error('Sprint polling recovery exhausted')
    }
    const agent = this.session.agent
    const owner = agent?.captureCheckpointOwner()
    const actor = { ...agent?.epoch }
    const current = () => owner && agent === this.session.agent && agent.checkpointOwnerCurrent(owner)
      && agent.epoch?.actor_id === actor.actor_id && agent.epoch?.epoch === actor.epoch
      && !this.session.stopping && !agent.currentPendingAmendment?.()
      && !agent.memory.pauseRecord(owner.key)?.paused
      && agent.memory.planningState(owner.key)?.goal?.status === 'active'
      && ['acknowledged', undefined].includes(agent.memory.pendingOperation(owner.key)?.state)
    if (!current()) throw new Error('Sprint polling recovery owner or native effects unsafe')
    const identity = { request_id: owner.requestTrace?.id, actor_id: actor.actor_id, epoch: actor.epoch,
      goal_id: owner.goalId, plan_id: owner.planId, plan_version: owner.planVersion, step_id: owner.stepId }
    this.recovery = { attempts: 1, state: 'attempted', reason: 'sprint_polling_budget', bucket: this.readBucket, ...identity }
    clearInterval(this.poll)
    await this.persist(this.ledger())
    try {
      if (!current()) throw new Error('Sprint polling recovery superseded')
      await this.emit('polling_recovery_attempted', { ...identity, reason: 'sprint_polling_budget', disposition: 'restore_and_disable_acceleration', boundary: reason })
      if (!current()) throw new Error('Sprint polling recovery superseded')
      // Fixed emergency allowance, never a reset/refill of ordinary control reads.
      // This independent lane can restore even when the normal minute is spent.
      let reads = 0
      let status = await this.restoreConfirmed('polling_recovery', async (text, lane) => {
        if (!current()) throw new Error('Sprint polling recovery superseded')
        if (++reads > 4) throw new Error('Sprint polling recovery emergency allowance exhausted')
        this.reads[`recovery_${lane}`] = (this.reads[`recovery_${lane}`] ?? 0) + 1
        const result = await this.watchdog.command(text)
        if (!current()) throw new Error('Sprint polling recovery superseded')
        return result
      }, { refresh: true })
      if (!current() || status.phase !== 'construction' || status.fault) throw new Error('Sprint polling recovery authority closed')
      const bucket = this.readBucket
      // Short wakes let a synchronous stop/request cancellation release the
      // serialized barrier promptly; no native work or model call is replayed.
      const waitMs = await this.waitControlWindow(bucket, current)
      // Native production can progress during the wait. Refresh after it as well
      // as restoring before it; pre-wait inventory is never continuation proof.
      status = await this.restoreConfirmed('polling_recovery_refresh', async (text, lane) => {
        if (!current()) throw new Error('Sprint polling recovery superseded')
        const result = await this.control(text, lane)
        if (!current()) throw new Error('Sprint polling recovery superseded')
        return result
      }, { refresh: true })
      if (!current() || status.phase !== 'construction' || status.fault) throw new Error('Sprint polling recovery authority closed')
      this.recovery = { ...this.recovery, state: 'completed' }
      await this.persist(this.ledger())
      if (!current()) throw new Error('Sprint polling recovery superseded')
      await this.emit('polling_recovery_completed', { ...identity, reason: 'sprint_polling_budget', disposition: 'continue_at_1x', emergency_reads: reads, wait_ms: waitMs })
      if (!current()) throw new Error('Sprint polling recovery superseded')
      return status
    } catch (error) {
      this.recovery = { ...this.recovery, state: current() ? 'exhausted' : 'superseded' }
      await this.persist(this.ledger())
      try { await this.emit(`polling_recovery_${this.recovery.state}`, { ...identity, reason: String(error.message), disposition: this.recovery.state === 'superseded' ? 'retire_old_owner' : 'safe_stop_required' }) } catch {}
      throw error
    }
  }
  async restoreConfirmed(reason, read, { refresh = false } = {}) {
    const status = JSON.parse(await read(sprintCommand('finish', reason), 'boundary_restore'))
    if (status.speed !== 1 || status.lease || status.version !== TICK_SPRINT.version) throw new Error('Sprint restoration unconfirmed')
    if (status.binding?.run_id !== this.binding.run_id || status.binding?.source_sha !== this.binding.source_sha
      || status.binding?.profile !== this.binding.profile) throw new Error('Sprint restoration binding changed')
    const lease = this.lease
    this.lease = undefined
    if (status.fault || status.phase !== 'construction') return status
    const newlyRestored = status.last && status.last.lease_id !== this.lastRestored
    if (newlyRestored || refresh) {
      this.session.agent?.noteWorldMutation()
      const agent = this.session.agent
      agent?.liveEntityObservations?.clear()
      agent?.handoffInventoryObservations?.clear()
      if (agent) { agent.postBatchFacts = undefined; agent.taskStatusDiffBaseline = undefined }
      const owner = agent?.captureCheckpointOwner()
      const identity = async () => {
        const current = await deploymentStatus({ command: text => read(text, 'identity_refresh') }, { requireAllowed: true })
        if (current.actor_id !== agent?.epoch?.actor_id || current.epoch !== agent?.epoch?.epoch || current.connected_players !== 0) throw new Error('Sprint restoration actor identity changed')
      }
      await identity()
      const inventory = await read('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_inventory_items")))', 'inventory_refresh')
      await identity()
      if (owner && agent.checkpointOwnerCurrent(owner)) agent.recordHandoffToolFacts('getInventoryItems', inventory)
      if (newlyRestored) {
        this.lastRestored = status.last.lease_id
        await this.emit('restored', { ...status.last, reason: status.last.reason, boundary: reason,
        speed: status.speed, freshness: 'dynamic_facts_invalidated_inventory_refreshed_existing_validators_required', harness_reads: 4,
          host_observed_lease_wall_ms: lease ? this.monotonic() - lease.monotonicStart : null })
      }
    }
    if (this.monotonic() - (this.lastPollingAt ?? -Infinity) >= 5000) {
      this.lastPollingAt = this.monotonic()
      await this.emit('polling', { ...this.binding, reason: 'bounded_control_accounting' })
    }
    return status
  }
  boundary(reason, fn = () => undefined) {
    const owner = this.session.agent?.captureCheckpointOwner()
    return this.serial(async () => {
      const safety = ['stop', 'shutdown', 'rcon', 'safety_control'].includes(reason)
      try {
        if (!['stop', 'shutdown', 'safety_control'].includes(reason)) this.assertOwner(owner)
        const status = await this.restore(reason)
        if (!['stop', 'shutdown', 'safety_control'].includes(reason)) this.assertOwner(owner)
        if (!safety && (status.phase !== 'construction' || status.fault)) throw new Error('Sprint construction authority closed')
      }
      catch (error) {
        if (reason !== 'safety_control') { await this.fail(error, owner); throw error }
      }
      if (this.fault && !safety) throw new Error(`Sprint controller fault: ${this.fault}`)
      return fn()
    })
  }
  trySprint() {
    if (this.probe || this.fault || this.closed || this.lease || this.recovery) return Promise.resolve(false)
    this.probe = true
    const checkpoint = this.session.agent?.captureCheckpointOwner()
    return this.serial(async () => {
      const owner = sprintOwner(this.session)
      if (!owner || this.closed || this.fault || this.lease || this.recovery) return false
      const status = JSON.parse(await this.control('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_operations","status")))', 'eligibility'))
      const current = sprintOwner(this.session)
      if (!current || !this.session.agent.checkpointOwnerCurrent(owner.checkpoint)
        || current.operation_key !== owner.operation_key || current.signature !== owner.signature) return false
      const episode = status.active_batch?.batch_ref
      if (!/^batch-g\d+-\d+$/.test(episode ?? '')) return false
      const spent = this.episodes[episode] ?? 0
      if (spent >= TICK_SPRINT.episodeTicks || Object.keys(this.episodes).length >= TICK_SPRINT.maxEpisodes && spent === 0) {
        await this.emit('refused', { ...owner, checkpoint: undefined, reason: 'durable_episode_exhausted', episode_id: episode })
        return false
      }
      this.episodes[episode] = spent + TICK_SPRINT.burstTicks
      await this.persist(this.ledger())
      const fresh = sprintOwner(this.session)
      if (!fresh || !this.session.agent.checkpointOwnerCurrent(owner.checkpoint) || fresh.operation_key !== owner.operation_key) return false
      const start = this.now()
      const lease = { ...this.binding, ...owner, checkpoint: undefined, lease_id: randomUUID(),
        batch_ref: episode, episode_id: episode, wall_started_ms: start, wall_deadline_ms: start + TICK_SPRINT.wallMs }
      // Arm the independent wall lane before awaiting the primary RCON reply.
      this.lease = { ...lease, monotonicStart: this.monotonic() }
      const armed = JSON.parse(await this.control(sprintCommand('arm', lease), 'arm'))
      if (!armed.ok) {
        this.lease = undefined
        if (armed.reason === 'construction_closed') { this.closed = true; clearInterval(this.poll) }
        await this.emit('refused', { ...lease, reason: armed.reason }); return false
      }
      if (armed.speed !== TICK_SPRINT.speed || armed.lease?.lease_id !== lease.lease_id) throw new Error('Native sprint lease mismatch')
      await this.emit('started', { ...armed.lease, reason: 'confirmed_native_batch', speed: armed.speed,
        episode_spent_ticks: this.episodes[episode], harness_reads: 2 })
      if (!sprintOwner(this.session) || !this.session.agent.checkpointOwnerCurrent(owner.checkpoint)) {
        await this.restore('owner_or_boundary_changed_after_arm')
        return false
      }
      return true
    }).catch(async error => {
      try {
        if (error.code !== 'sprint_polling_budget') throw error
        await this.serial(() => { this.assertOwner(checkpoint); return this.recoverPollingBudget('sprint_probe') })
        return false
      } catch (failure) { await this.fail(failure, checkpoint); throw failure }
    }).finally(() => { this.probe = false })
  }
  async watchdogTick() {
    const lease = this.lease
    if (!lease || this.watchBusy || this.monotonic() - lease.monotonicStart < TICK_SPRINT.restoreAfterMs) return
    this.watchBusy = true
    const checkpoint = this.session.agent?.captureCheckpointOwner()
    try {
      const status = JSON.parse(await this.control(sprintCommand('finish', 'host_wall_watchdog', lease.lease_id), 'wall_watchdog', this.watchdog.command.bind(this.watchdog)))
      if (this.lease !== lease) return
      if (status.speed !== 1 || status.lease || this.monotonic() - lease.monotonicStart >= TICK_SPRINT.wallMs) throw new Error('Wall sprint restoration failed or exceeded3000ms')
      await this.boundary('watchdog_restored')
    } catch (error) {
      try {
        if (error.code !== 'sprint_polling_budget') throw error
        // Wall restoration cannot queue behind a blocked primary lane. One
        // lease-scoped emergency finish precedes serialized host reconciliation.
        this.reads.wall_budget_emergency = (this.reads.wall_budget_emergency ?? 0) + 1
        const restored = JSON.parse(await this.watchdog.command(sprintCommand('finish', 'watchdog_budget_emergency', lease.lease_id)))
        if (this.lease !== lease) return
        if (!this.validStatus(restored) || restored.speed !== 1 || restored.lease
          || this.monotonic() - lease.monotonicStart >= TICK_SPRINT.wallMs) throw new Error('Emergency wall sprint restoration unconfirmed')
        this.assertOwner(checkpoint)
        await this.boundary('watchdog_polling_budget')
      } catch (failure) { await this.fail(failure, checkpoint); throw failure }
    } finally { this.watchBusy = false }
  }
  async fail(error, owner = this.session.agent?.captureCheckpointOwner()) {
    if (this.fault) return
    const identity = { request_id: owner?.requestTrace?.id, goal_id: owner?.goalId, plan_id: owner?.planId,
      plan_version: owner?.planVersion, step_id: owner?.stepId }
    if (owner && (!this.session.agent?.checkpointOwnerCurrent(owner)
      || this.recovery?.state === 'superseded' && this.session.stopping)) {
      // Retire stale work without poisoning the replacement's controller. Speed
      // restoration is global safety; cancellation/plan changes remain owned.
      try {
        this.reads.superseded_restore = (this.reads.superseded_restore ?? 0) + 1
        const status = JSON.parse(await this.watchdog.command(`/silent-command local s=remote.call("sgluna_tick_sprint","status");if not s.lease or s.lease.request_id==${lua(owner.requestTrace?.id ?? '')} then s=remote.call("sgluna_tick_sprint","finish","superseded_boundary") end;rcon.print(helpers.table_to_json(s))`))
        if (this.validStatus(status) && status.phase === 'construction' && !status.fault && status.speed === TICK_SPRINT.speed
          && status.lease && status.lease.request_id !== owner.requestTrace?.id && status.lease.lease_id === this.lease?.lease_id) return
        // External stop seals construction before delivering cancellation. A
        // verified closed1x guard is a successful safety boundary for retired
        // work, not a new acceleration fault or permission to run its callback.
        if (!this.validStatus(status) || status.speed !== 1 || status.lease || status.fault
          || !['construction', 'closed'].includes(status.phase)) throw new Error('Superseded boundary restoration unconfirmed')
        this.lease = undefined
        if (status.phase === 'closed') { this.closed = true; clearInterval(this.poll); clearInterval(this.watch) }
        try {
          await this.emit('boundary_retired', { ...this.binding, ...identity, reason: 'owner_superseded',
            disposition: 'retire_without_callback', native_phase: status.phase, speed: status.speed })
        } catch { this.session.log?.('Retired boundary telemetry unavailable; native1x restoration verified') }
        return
      } catch { /* An unconfirmed physical restoration remains a global fault. */ }
    }
    this.fault = String(error.message).slice(0, 180)
    clearInterval(this.poll)
    clearInterval(this.watch)
    this.session.accelerationFault = this.fault
    this.reads.emergency_control = (this.reads.emergency_control ?? 0) + 1
    try { await this.watchdog.command(sprintCommand('fail', this.fault)) } catch {}
    this.lease = undefined
    const agent = this.session.agent
    if (!owner || agent?.checkpointOwnerCurrent(owner)) {
      this.session.cancelAutoResume?.()
      agent?.cancel('tick_sprint_fault')
      const cancelledOwner = agent?.captureCheckpointOwner()
      this.session.queueEvent?.(async () => {
        if (!this.session.stopping && agent === this.session.agent && (!cancelledOwner || agent.checkpointOwnerCurrent(cancelledOwner))
          && !agent?.memory.pauseRecord?.(agent.activePlanKey())?.paused) {
          await agent?.pausePersistentPlan('tick_sprint_fault', { pause_class: 'guard' })
        }
      }, { safetyControl: true })
    }
    try { await this.emit('fault', { ...this.binding, ...identity, reason: this.fault, disposition: 'safe_stop_required' }) }
    catch { this.session.log?.('Sprint fault telemetry unavailable; safety control queued') }
  }
  async stop(reason = 'shutdown') {
    this.closed = true
    clearInterval(this.poll); clearInterval(this.watch)
    try { const result = await this.boundary(reason); await this.emit('polling', { ...this.binding, reason: 'controller_closed' }); return result }
    finally { this.watchdog.close?.() }
  }
}
