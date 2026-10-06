import assert from 'node:assert/strict'
import test from 'node:test'

import { ACTION_SCOPE, authorizationOf, MANDATE_KIND } from './authorization.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { applyPlanningEvent, getActivePlan, PLAN_STATUS, PLANNING_EVENT } from './planning-state.mjs'

// MW1 wiring in the real agent loop: the memory facade's authorization events reach the behavior trace with their
// request_id, the placement receipt records an NPC placement, and the operation-admission gate refuses a player-built
// target before anything is sent to the game and tells the model what to do instead. A fake Factorio and scripted
// model replies; nothing here calls a provider.

const KEY = 'npc:sgluna'

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: true,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

const toolCall = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const planMessage = (operations, { plan = ['Do the current step'], currentStep = 0 } = {}) => ({ content: JSON.stringify({ chatMessage: '', plan, currentStep, operations }) })

class Rcon {
  constructor() {
    this.mutations = []
    this.preflightByUnit = new Map()
    this.nearby = { actor_position: { x: 0, y: 0 }, entities: [] }
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_tools","get_nearby_entities"')) return JSON.stringify(this.nearby)
    if (text.includes('remote.call("autorio_operations","status")')) {
      return JSON.stringify({ task_state: 'idle', queue_empty: true, queue_length: 0 })
    }
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false })
    if (text.includes('remote.call("autorio_preflight","operation"')) {
      const match = text.match(/unit_number[^0-9]*(\d+)/)
      const unit = match ? Number(match[1]) : undefined
      return JSON.stringify(unit !== undefined && this.preflightByUnit.has(unit) ? this.preflightByUnit.get(unit) : { ok: true })
    }
    if (text.includes('SGLUNA_RESULT_') && text.includes('autorio_operations')) {
      this.mutations.push(text)
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      const count = (text.match(/remote\.call\('autorio_operations'/g) ?? []).length
      return `${marker}${JSON.stringify({ ok: true, result: Array.from({ length: count }, () => [true, 'Task started']) })}`
    }
    return '{}'
  }
}

function makeAgent(rcon, provider) {
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({ rcon, memory, provider, systemPrompt: 'authorization wiring test', npcId: 'sgluna', stateFile: null, traceFile: null, decisionTraceFile: null })
  const rows = []
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  return { agent, memory, rows, named: name => rows.filter(row => row.event === name) }
}

test('MW1 wiring: the loop installs the authorization trace sink, so facade events become behavior-trace rows with their request_id', async () => {
  const { memory, named } = makeAgent(new Rcon(), async () => planMessage([]))
  assert.equal(typeof memory.traceSink, 'function')
  memory.planningByNpc.set(KEY, applyPlanningEvent(applyPlanningEvent(undefined, {
    type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1, goal_id: 'goal_w', owner: 'louis', objective: 'deliver 100 iron plates',
  }), {
    type: PLANNING_EVENT.AUTHORIZATION_GRANTED,
    source: 'runtime',
    now: 2,
    grant: { mandate_kind: MANDATE_KIND.STANDING_AUTO, mandate_id: 'goal_w', requested_result: { result_key: 'victory' }, permitted_scope: [ACTION_SCOPE.RECOVERY] },
  }))
  memory.revokeAuthorization(KEY, 'standing_auto:goal_w', { requestId: 'req_wire_1', reason: 'player cancelled auto' })
  await new Promise(resolve => setImmediate(resolve))
  const row = named('authorization.revoked').at(-1)
  assert.ok(row, 'the revoke reached the behavior trace')
  assert.equal(row.request_id, 'req_wire_1')
  assert.equal(row.data?.reason ?? row.reason, 'player cancelled auto')
})

test('MW1 wiring: a placement receipt records the entity as the NPC\'s own, once', async () => {
  const { agent, memory, named } = makeAgent(new Rcon(), async () => planMessage([]))
  agent.epoch = { actor_id: 18, epoch: 3 }
  const receipt = {
    actor: { position: { x: 0, y: 0 } },
    last_completed_batch: { task_types: ['placing'], tick: 100 },
    basic_operation: {
      last_result: {
        completed: true,
        code: 'completed',
        type: 'placing',
        tick: 100,
        actor_id: 18,
        placed_unit_number: 555,
        entity_name: 'stone-furnace',
        placed_entity_type: 'furnace',
        placed_position: { x: 3, y: 4 },
        placed_surface_index: 1,
      },
    },
  }
  agent.recordPlacementReceipt(receipt)
  agent.recordPlacementReceipt(receipt)
  const [placement, ...rest] = authorizationOf(memory.planningState(KEY)).world.npc_placements
  assert.equal(rest.length, 0)
  assert.deepEqual([placement.unit_number, placement.entity_name, placement.actor_id, placement.actor_epoch, placement.placed_last_user], [555, 'stone-furnace', 18, 3, null])
  assert.equal(memory.protectedEntityStatus(KEY, { unit_number: 555 }).protected, false)
  assert.equal(memory.protectedEntityStatus(KEY, { unit_number: 555, last_user: { name: 'louis' } }).protected, true)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(named('placement.npc_recorded').length, 1, 'one trace row for the one new fact')
  const row = named('placement.npc_recorded')[0]
  assert.equal((row.data ?? row).reason, 'placement_receipt')
  assert.equal((row.data ?? row).unit_number, 555)
})

function observedAssembler(rcon) {
  rcon.nearby = {
    actor_position: { x: 0, y: 0 },
    entities: [{ name: 'assembling-machine-1', type: 'assembling-machine', unit_number: 289, position: { x: 8, y: 1 }, distance: 8.1 }],
  }
  // The engine's last_user for the target rides in the exact-target preflight.
  rcon.preflightByUnit.set(289, { ok: true, target: { unit_number: 289, name: 'assembling-machine-1', last_user: { name: 'Alice', index: 2 } } })
}

// A standing Auto mandate for the live goal: what makes the work grant-backed (MW5 will issue these from the mode controller).
function grantLiveGoal(memory) {
  const goalId = memory.planningState(KEY).goal.goal_id
  return memory.grantAuthorization(KEY, {
    mandate_kind: MANDATE_KIND.STANDING_AUTO,
    mandate_id: goalId,
    requested_result: { result_key: 'victory:rocket_launch' },
    permitted_scope: [ACTION_SCOPE.RECOVERY],
    actor: { actor_id: 18, actor_epoch: 3 },
  })
}

test('MW1 wiring: grant-backed work - admission refuses a player-built exact target before anything reaches the game, the plan stays a DRAFT, and the retry admits', async () => {
  const rcon = new Rcon()
  observedAssembler(rcon)
  const calls = []
  let statusAtRetry
  const world = makeAgent(rcon, async (messages) => {
    calls.push(messages.map(message => ({ ...message })))
    if (calls.length === 1) {
      assert.equal(grantLiveGoal(world.memory).ok, true)
      return { content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'assembling-machine-1', limit: 4 })] }
    }
    if (calls.length === 2) return planMessage([{ name: 'mine_entity_exact', args: { unit_number: 289 } }])
    statusAtRetry = getActivePlan(world.memory.planningState(KEY))?.status
    return planMessage([{ name: 'wait', args: { ticks: 60 } }])
  })
  const { agent, memory, rows, named } = world

  const result = await agent.request('tear down that old assembler and rebuild it', { sender: 'tester' })

  // The refused batch never reached the game; the retry did.
  assert.equal(rcon.mutations.length, 1)
  assert.ok(!rcon.mutations[0].includes('mine_entity_exact'))
  assert.equal(result.operations[0].name, 'wait')
  // Refused before the commit: the plan was still an uncommitted draft when the model was asked to retry, as for every other deterministic refusal.
  assert.equal(statusAtRetry, PLAN_STATUS.DRAFT)
  assert.ok([PLAN_STATUS.COMMITTED, PLAN_STATUS.EXECUTING].includes(getActivePlan(memory.planningState(KEY)).status), 'the retry committed and was admitted')

  const refusal = named('admission.protected_refused').at(-1)
  assert.ok(refusal, 'admission.protected_refused was traced')
  const payload = refusal.data ?? refusal
  assert.equal(payload.reason, 'human_last_user')
  assert.equal(payload.unit_number, 289)
  assert.equal(payload.last_user, 'Alice')
  const requestId = payload.request_id
  assert.ok(requestId, 'the refusal carries the request_id')

  const recoverable = named('operations.preflight_recoverable').at(-1)
  assert.equal((recoverable.data ?? recoverable).failure_class, 'authorization_protected_entity_refused')
  assert.equal(recoverable.request_id ?? requestId, requestId)

  // The model was told what happened and what not to do, and the requested result was not rewritten.
  const message = calls[2].map(item => item.content).find(content => typeof content === 'string' && content.startsWith('[HARNESS] Admission refused')) ?? ''
  assert.match(message, /^\[HARNESS\] Admission refused operation 1 \(mine_entity_exact\) with code protected_entity_refused/)
  assert.match(message, /Do not retry it and do not change the requested result/)
  assert.ok(rows.length > 0)
})

test('MW1 wiring (interim): an ordinary user-requested goal can still mine a human-built entity and take items from a player', async () => {
  const rcon = new Rcon()
  observedAssembler(rcon)
  let calls = 0
  const { agent } = makeAgent(rcon, async () => {
    calls++
    if (calls === 1) return { content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'assembling-machine-1', limit: 4 })] }
    return planMessage([
      { name: 'mine_entity_exact', args: { unit_number: 289 } },
      { name: 'move_items_with_player', args: { item_name: 'iron-plate', player_name: 'Alice', max_count: 5, to_player: false } },
    ])
  })
  const result = await agent.request('take that old assembler apart and grab the plates Alice is holding', { sender: 'Alice' })
  assert.equal(rcon.mutations.length, 1)
  assert.ok(rcon.mutations[0].includes('mine_entity_exact'))
  assert.ok(rcon.mutations[0].includes('move_items_with_player'))
  assert.deepEqual(result.operations.map(operation => operation.name), ['mine_entity_exact', 'move_items_with_player'])
})

test('MW1 wiring: a reserved container is refused for an ordinary goal and the reservation survives the new_goal router path and completed-task cleanup', async () => {
  const rcon = new Rcon()
  rcon.preflightByUnit.set(900, { ok: true, target: { unit_number: 900, name: 'wooden-chest' } })
  rcon.nearby = { actor_position: { x: 0, y: 0 }, entities: [{ name: 'wooden-chest', type: 'container', unit_number: 900, position: { x: 4, y: 1 }, distance: 4.1 }] }
  const script = []
  const memory = new CanonicalTaskBoardMemory()
  const rows = []
  let cleared = 0
  const clearTaskContext = memory.clearTaskContext.bind(memory)
  memory.clearTaskContext = (key) => { cleared++; return clearTaskContext(key) }
  const agent = new NpcAgentLoop({
    rcon,
    memory,
    provider: async (messages, context) => {
      const next = script.shift()
      assert.ok(next, 'unscripted provider call')
      return typeof next === 'function' ? next(messages, context) : next
    },
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    systemPrompt: 'authorization wiring test',
    npcId: 'sgluna',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }

  // A reservation made by the player (chat command) before any goal.
  memory.recordReservation(KEY, { unit_number: 900, entity_name: 'wooden-chest', reserved_by: 'louis' }, { now: Date.now() })
  const reserved = () => authorizationOf(memory.planningState(KEY)).world.reservations.filter(item => item.status === 'active').map(item => item.unit_number)

  // First goal: the model tries to take from the reserved chest and is refused; the retry is admitted.
  script.push(
    { content: null, tool_calls: [toolCall('observe', 'getNearbyEntities', { radius: 64, name: 'wooden-chest', limit: 4 })] },
    planMessage([{ name: 'move_items_exact', args: { item_name: 'iron-plate', unit_number: 900, max_count: 20, to_entity: false } }], { plan: ['Fetch iron plates'] }),
    planMessage([{ name: 'wait', args: { ticks: 60 } }], { plan: ['Fetch iron plates'] }),
  )
  const first = await agent.request('fetch me some iron plates', { sender: 'tester' })
  assert.equal(first.operations[0].name, 'wait')
  assert.equal(rows.filter(row => row.event === 'admission.reserved_refused').length, 1)
  assert.deepEqual(reserved(), [900])

  // A second, unrelated goal: the router sends it down the new_goal path (clearTaskContext). The reservation stays.
  script.push(planMessage([{ name: 'wait', args: { ticks: 30 } }], { plan: ['Wait a moment'] }))
  await agent.request('build me a completely different thing somewhere else', { sender: 'tester' })
  assert.deepEqual(reserved(), [900], 'the new_goal path kept the reserved container')
  assert.ok(cleared >= 1, 'the new_goal router path cleared the task context')

  // An unverified cleanup request cannot clear the current goal or world facts.
  const activeGoalId = memory.planningState(KEY).goal.goal_id
  assert.equal((await agent.finalizeCompletedTaskContext()).finalized, false)
  assert.equal(memory.planningState(KEY).goal.goal_id, activeGoalId)
  // Seed authoritative completion for this cleanup-only fixture; no gameplay is inferred from a wait.
  memory.recordGoalSatisfaction(KEY, { source: 'runtime', evidenceRefs: ['fixture/world-completed'], rationale: 'Scripted authoritative completion fixture.' })
  assert.equal(await agent.finalizeCompletedTaskContext({ goalId: activeGoalId, goalStatus: 'completed' }), true)
  assert.deepEqual(reserved(), [900], 'finalizeCompletedTaskContext kept the reserved container')
  assert.ok(cleared >= 2)
  assert.equal(memory.planningState(KEY)?.goal ?? null, null)
})
