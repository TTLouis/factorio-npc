import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AIRI_CONFIG_DEFAULTS,
  configuration,
  migrateConfig,
  recoverInterruptedAgentPlan,
  Session,
  shouldRecoverInterruptedPlan,
} from './supervisor.mjs'

const env = {
  AIRI_ACTOR_MODE: 'npc',
  OPENAI_API_KEY: 'test-key-1234',
  OPENAI_API_BASEURL: 'https://api.example.test/v1',
}

test('provider timeout is a migrated non-secret config with a Pterodactyl env override', () => {
  assert.equal(AIRI_CONFIG_DEFAULTS.providerTimeoutMs, 300000)
  assert.equal(migrateConfig({}, {}).providerTimeoutMs, 300000)
  assert.equal(configuration({}, env).providerTimeoutMs, 300000)
  assert.equal(configuration({}, { ...env, PROVIDER_TIMEOUT_MS: '90000' }).providerTimeoutMs, 90000)
})

function sessionFixture() {
  const logs = []
  const commands = []
  const session = new Session({
    root: '/tmp',
    app: '/tmp',
    game: '/tmp',
    config: { chatPlayers: { mode: 'all', names: [] } },
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: message => logs.push(message),
  })
  session.ready = true
  session.rcon = {
    command: async text => {
      commands.push(text)
      return 'ok'
    },
  }
  session.ensureAuthorization = async () => ({ actor_id: 18, epoch: 3 })
  return { session, logs, commands }
}

test('chat provider failure is reported in game and the event queue remains usable', async () => {
  const { session, logs, commands } = sessionFixture()
  let requests = 0
  session.agent = {
    active: false,
    request: async () => {
      requests++
      if (requests === 1) throw new Error('Provider timed out after 120000 ms')
      return { chatMessage: 'Recovered.' }
    },
    completed: async () => null,
    cancel: () => {},
  }

  session.onGameLine('2026-09-14 20:00:00 [CHAT] Louis: !airi first')
  await session.eventQueue
  assert.ok(logs.includes('Provider timed out after 120000 ms'))
  assert.ok(commands.some(command => command.includes('Request failed: Provider timed out after 120000 ms')))

  session.onGameLine('2026-09-14 20:00:01 [CHAT] Louis: !airi second')
  await session.eventQueue
  assert.ok(commands.some(command => command.includes('Recovered.')))
})

test('!airi stop cancels an in-flight model turn immediately and reports that the plan is paused', async () => {
  const { session, commands } = sessionFixture()
  let cancelled = 0
  let releaseQueue
  session.eventQueue = new Promise(resolve => { releaseQueue = resolve })
  session.agent = {
    active: true,
    request: async () => null,
    completed: async () => null,
    cancel: () => { cancelled++ },
  }

  session.onGameLine('2026-09-14 20:00:00 [CHAT] Louis: !airi stop')
  assert.equal(cancelled, 1)
  releaseQueue()
  await session.eventQueue
  assert.ok(commands.some(command => command.includes('airi_deployment')))
  assert.ok(commands.some(command => command.includes('Paused the current AIRI plan')))
})

test('only active or infrastructure-interrupted plans are eligible for automatic recovery', () => {
  assert.equal(shouldRecoverInterruptedPlan({ status: 'active' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'npc_identity_or_session_changed' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'actor_replaced' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'server_stop_signal' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'server_stop_requested' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'server_stop_console' }), true)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'user_stop' }), false)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'ui_pause' }), false)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'paused', pause_reason: 'ui_follow' }), false)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'blocked' }), false)
  assert.equal(shouldRecoverInterruptedPlan({ status: 'completed' }), false)
})

test('interrupted-plan recovery creates a continuation turn that requires live re-observation instead of replaying old operations', async () => {
  const state = {
    status: 'active',
    owner: 'Louis',
    objective: 'build a furnace and start iron production',
    last_operations: ['place_entity {"entity_name":"stone-furnace","x":4,"y":5}'],
  }
  let observed
  const agent = {
    npcId: 'airi',
    systemPrompt: 'NPC recovery prompt',
    active: true,
    turnSequence: 4,
    traceRequest: null,
    memory: {
      currentPlan: key => key === 'npc:airi' ? state : undefined,
      context: () => '[PLAN_STATE] {"status":"active","current_step_text":"Place furnace"}',
    },
    loadPersistentState: async () => {},
    cancel(reason) {
      this.cancelReason = reason
      this.active = false
    },
    captureEpoch: async () => ({ actor_id: 99, epoch: 8 }),
    traceEvent: async () => {},
    async runGuarded() {
      observed = {
        messages: this.messages,
        requestInfo: this.requestInfo,
        continuations: this.continuations,
        active: this.active,
        epoch: this.epoch,
      }
      return { chatMessage: '', operations: [{ name: 'wait', args: { ticks: 1 } }] }
    },
  }

  const recovery = await recoverInterruptedAgentPlan(agent, 'runtime_restart', { actor_id: 99 })

  assert.equal(recovery.recovered, true)
  assert.equal(agent.cancelReason, 'runtime_recovery_prepare:runtime_restart')
  assert.equal(observed.continuations, 1)
  assert.equal(observed.active, true)
  assert.deepEqual(observed.epoch, { actor_id: 99, epoch: 8 })
  assert.equal(observed.requestInfo.sender, 'Louis')
  assert.equal(observed.requestInfo.text, state.objective)
  const context = observed.messages.map(message => message.content ?? '').join('\n')
  assert.match(context, /\[PLAN_STATE\]/)
  assert.match(context, /previous finite Autorio task queue was discarded/)
  assert.match(context, /MUST NOT be assumed complete/)
  assert.match(context, /Never blindly replay last_operations/)
})

test('NPC body replacement cancels the stale turn, rebinds authorization, and automatically recovers an active durable plan', async () => {
  const { session } = sessionFixture()
  const sequence = []
  const state = { status: 'active', objective: 'mine iron', owner: 'Louis' }
  session.currentPlanState = () => state
  session.agent = {
    active: true,
    cancel: reason => sequence.push(`cancel:${reason}`),
  }
  session.ensureAuthorization = async () => {
    sequence.push('authorize')
    return { actor_id: 99, epoch: 4 }
  }
  session.recoverInterruptedPlan = async (reason, details) => {
    sequence.push(`recover:${reason}:${details.previous_actor_id}->${details.replacement_actor_id}`)
    return { chatMessage: '', operations: [{ name: 'wait', args: { ticks: 1 } }] }
  }

  session.onGameLine('[AUTORIO] Recovered standalone NPC actor_id=42 -> 99 without inventory transfer')
  await session.eventQueue

  assert.deepEqual(sequence, [
    'cancel:actor_replaced_stale_turn',
    'authorize',
    'recover:actor_replaced:42->99',
  ])
})
