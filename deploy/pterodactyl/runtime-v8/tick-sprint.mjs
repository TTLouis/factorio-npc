import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getActivePlan, PLAN_STATUS } from './planning-state.mjs'
import { TICK_SPRINT } from '../staging/tick-sprint-policy.mjs'
import { deploymentStatus } from '../staging/supervisor-adapter.mjs'

export { sprintSpeedValid, summarizeTickSprints, TICK_SPRINT } from '../staging/tick-sprint-policy.mjs'

const lua = value => `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
export const sprintCommand = (method, ...args) => `/silent-command rcon.print(helpers.table_to_json(remote.call("sgluna_tick_sprint",${lua(method)}${args.map(arg => `,${typeof arg === 'object' ? `helpers.json_to_table(${lua(JSON.stringify(arg))})` : lua(arg)}`).join('')})))`

export async function pauseSprintStartup(rcon) {
  const status = JSON.parse(await rcon.command(`/silent-command game.tick_paused=true;rcon.print(helpers.table_to_json(remote.call("sgluna_tick_sprint","finish","startup_reconciliation")))`))
  if (status.speed !== 1 || status.lease || status.version !== TICK_SPRINT.version) throw new Error('Sprint startup restoration unconfirmed')
  return status
}

export async function resumeSprintStartup(rcon) {
  await rcon.command('/config set auto-pause false')
  const status = JSON.parse(await rcon.command('/silent-command game.tick_paused=false;rcon.print(helpers.table_to_json({speed=game.speed,paused=game.tick_paused}))'))
  if (status.speed !== 1 || status.paused !== false) throw new Error('Sprint startup resume unconfirmed')
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
  constructor({ session, watchdog, ledgerFile, binding, persist, emit, now = Date.now, monotonic = () => performance.now() }) {
    Object.assign(this, { session, watchdog, ledgerFile, binding, now, monotonic })
    this.raw = session.rcon.command.bind(session.rcon)
    this.tail = Promise.resolve()
    this.episodes = {}
    this.pollingInstance = randomUUID()
    this.reads = {}
    this.persist = persist ?? (async ledger => {
      await fs.mkdir(path.dirname(ledgerFile), { recursive: true })
      const temporary = `${ledgerFile}.tmp`
      const file = await fs.open(temporary, 'w', 0o600)
      try { await file.writeFile(`${JSON.stringify(ledger)}\n`); await file.sync() }
      finally { await file.close() }
      await fs.rename(temporary, ledgerFile)
    })
    const write = emit ?? ((event, data) => session.agent?.traceEvent(`sprint.${event}`, data))
    this.emit = (event, data) => write(event, { ...data, polling_instance_id: this.pollingInstance, native_reads_by_lane: { ...this.reads } })
  }
  control(text, lane, command = this.raw) {
    const bucket = Math.floor(this.monotonic() / 60000)
    if (this.readBucket !== bucket) { this.readBucket = bucket; this.bucketReads = 0 }
    if (++this.bucketReads > TICK_SPRINT.maxControlReadsPerMinute) throw new Error('Sprint harness polling budget exhausted')
    this.reads[lane] = (this.reads[lane] ?? 0) + 1
    return command(text)
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
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    const status = JSON.parse(await this.control(sprintCommand('configure', this.binding), 'configure'))
    if (!status.ok || status.version !== TICK_SPRINT.version || status.speed !== 1 || status.lease || status.fault) throw new Error('Native sprint guard did not configure at1x')
    for (const [episode, spent] of Object.entries(status.episodes ?? {})) {
      if (!/^batch-g\d+-\d+$/.test(episode) || !Number.isSafeInteger(spent) || spent <= 0 || spent > TICK_SPRINT.episodeTicks || spent % TICK_SPRINT.burstTicks !== 0) throw new Error('Native sprint ledger unreadable')
      this.episodes[episode] = Math.max(spent, this.episodes[episode] ?? 0)
    }
    await this.persist({ ...this.binding, episodes: this.episodes })
    this.session.rcon.command = (...args) => this.boundary('rcon', () => this.raw(...args))
    if (timers) {
      this.poll = setInterval(() => { this.trySprint().catch(error => this.fail(error)) }, TICK_SPRINT.pollMs)
      this.watch = setInterval(() => { this.watchdogTick().catch(error => this.fail(error)) }, TICK_SPRINT.watchdogMs)
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
    const status = JSON.parse(await this.control(sprintCommand('finish', reason), 'boundary_restore'))
    if (status.speed !== 1 || status.lease || status.version !== TICK_SPRINT.version) throw new Error('Sprint restoration unconfirmed')
    if (status.binding?.run_id !== this.binding.run_id || status.binding?.source_sha !== this.binding.source_sha
      || status.binding?.profile !== this.binding.profile) throw new Error('Sprint restoration binding changed')
    const lease = this.lease
    this.lease = undefined
    if (status.last && status.last.lease_id !== this.lastRestored) {
      this.lastRestored = status.last.lease_id
      this.session.agent?.noteWorldMutation()
      const agent = this.session.agent
      agent?.liveEntityObservations?.clear()
      agent?.handoffInventoryObservations?.clear()
      if (agent) { agent.postBatchFacts = undefined; agent.taskStatusDiffBaseline = undefined }
      const owner = agent?.captureCheckpointOwner()
      const identity = async () => {
        const current = await deploymentStatus({ command: text => this.control(text, 'identity_refresh') }, { requireAllowed: true })
        if (current.actor_id !== agent?.epoch?.actor_id || current.epoch !== agent?.epoch?.epoch || current.connected_players !== 0) throw new Error('Sprint restoration actor identity changed')
      }
      await identity()
      const inventory = await this.control('/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_tools","get_inventory_items")))', 'inventory_refresh')
      await identity()
      if (owner && agent.checkpointOwnerCurrent(owner)) agent.recordHandoffToolFacts('getInventoryItems', inventory)
      await this.emit('restored', { ...status.last, reason: status.last.reason, boundary: reason,
        speed: status.speed, freshness: 'dynamic_facts_invalidated_inventory_refreshed_existing_validators_required', harness_reads: 4,
        host_observed_lease_wall_ms: lease ? this.monotonic() - lease.monotonicStart : null })
    }
    if (this.monotonic() - (this.lastPollingAt ?? -Infinity) >= 5000) {
      this.lastPollingAt = this.monotonic()
      await this.emit('polling', { ...this.binding, reason: 'bounded_control_accounting' })
    }
    return status
  }
  boundary(reason, fn = () => undefined) {
    return this.serial(async () => {
      const safety = ['stop', 'shutdown', 'rcon', 'safety_control'].includes(reason)
      try {
        const status = await this.restore(reason)
        if (!safety && (status.phase !== 'construction' || status.fault)) throw new Error('Sprint construction authority closed')
      }
      catch (error) {
        if (reason !== 'safety_control') { await this.fail(error); throw error }
      }
      if (this.fault && !safety) throw new Error(`Sprint controller fault: ${this.fault}`)
      return fn()
    })
  }
  trySprint() {
    if (this.probe || this.fault || this.closed || this.lease) return Promise.resolve(false)
    this.probe = true
    return this.serial(async () => {
      const owner = sprintOwner(this.session)
      if (!owner || this.closed || this.fault || this.lease) return false
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
      await this.persist({ ...this.binding, episodes: this.episodes })
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
    }).finally(() => { this.probe = false })
  }
  async watchdogTick() {
    const lease = this.lease
    if (!lease || this.watchBusy || this.monotonic() - lease.monotonicStart < TICK_SPRINT.restoreAfterMs) return
    this.watchBusy = true
    try {
      const status = JSON.parse(await this.control(sprintCommand('finish', 'host_wall_watchdog', lease.lease_id), 'wall_watchdog', this.watchdog.command.bind(this.watchdog)))
      if (this.lease !== lease) return
      if (status.speed !== 1 || status.lease || this.monotonic() - lease.monotonicStart >= TICK_SPRINT.wallMs) throw new Error('Wall sprint restoration failed or exceeded3000ms')
      await this.boundary('watchdog_restored')
    } finally { this.watchBusy = false }
  }
  async fail(error) {
    if (this.fault) return
    this.fault = String(error.message).slice(0, 180)
    clearInterval(this.poll)
    clearInterval(this.watch)
    this.session.accelerationFault = this.fault
    this.reads.emergency_control = (this.reads.emergency_control ?? 0) + 1
    try { await this.watchdog.command(sprintCommand('fail', this.fault)) } catch {}
    this.lease = undefined
    this.session.cancelAutoResume?.()
    this.session.agent?.cancel('tick_sprint_fault')
    this.session.queueEvent?.(async () => {
      if (!this.session.stopping && !this.session.agent?.memory.pauseRecord?.(this.session.agent.activePlanKey())?.paused) {
        await this.session.agent?.pausePersistentPlan('tick_sprint_fault', { pause_class: 'guard' })
      }
    }, { safetyControl: true })
    try { await this.emit('fault', { ...this.binding, reason: this.fault, disposition: 'safe_stop_required' }) }
    catch { this.session.log?.('Sprint fault telemetry unavailable; safety control queued') }
  }
  async stop(reason = 'shutdown') {
    this.closed = true
    clearInterval(this.poll); clearInterval(this.watch)
    try { const result = await this.boundary(reason); await this.emit('polling', { ...this.binding, reason: 'controller_closed' }); return result }
    finally { this.watchdog.close?.() }
  }
}
