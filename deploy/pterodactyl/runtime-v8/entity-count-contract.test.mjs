import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'

// Unit 9 (G2a): a build step is closed by "N entities of prototype X exist", read natively from the live world, never by a
// placement receipt. One place_entity receipt must not close a step that asks for three boilers. A fake Factorio answers the
// mod's entity_count condition shape (tools.ts evaluate_entity_count); no provider is called.

function deployment() {
  return {
    revision: 'sgluna-deploy-v8-npc-staging',
    session: '0123456789abcdef0123456789abcdef',
    mode: 'npc',
    actor_id: 18,
    actor_kind: 'standalone_character',
    connected_players: 0,
    allowed: true,
    idle: false,
    epoch: 3,
    actor_interface: true,
    operations: true,
    tools: true,
  }
}

const BUILD_CONTRACT = {
  mode: 'all',
  source: 'main_planner',
  requirements: [
    { id: 'boilers', kind: 'entity_count', prototype: 'boiler', minimum: 3 },
    { id: 'engines', kind: 'entity_count', prototype: 'steam-engine', minimum: 1, radius: 30 },
  ],
}

function activeState(contract = BUILD_CONTRACT) {
  const evidence = [{
    id: 'evidence_1',
    kind: 'deterministic_verification',
    ref: 'batch_7',
    summary: JSON.stringify({ verdict: 'verified_complete', operations: ['place_entity'], task_types: ['placing'] }),
    step_id: 'step_1',
    at: Date.now(),
  }]
  return {
    goal_id: 'goal_build',
    owner: 'tester',
    objective: 'build a steam engine',
    status: 'active',
    blocker: '',
    pause_reason: '',
    plan: ['Place three boilers and an engine', 'Connect poles'],
    current_step: 0,
    revision: 2,
    last_chat_message: '',
    last_operations: ['place_entity {"entity_name":"boiler"}'],
    durable_last_operations: [],
    exact_target_audit: [],
    last_mutation_verified: true,
    last_verified_batch_id: 7,
    updated_at: Date.now(),
    history: [],
    task_board: {
      kind: 'task_board_lite',
      goal_id: 'goal_build',
      status: 'active',
      blocker: '',
      pause_reason: '',
      revision: 2,
      event_sequence: 0,
      evidence_sequence: evidence.length,
      completed_count: 0,
      total_steps: 2,
      active_index: 0,
      active_step_id: 'step_1',
      proposed_focus_index: 0,
      proposed_focus_step_id: 'step_1',
      steps: [
        { id: 'step_1', description: 'Place three boilers and an engine', status: 'active', completion_contract: contract },
        { id: 'step_2', description: 'Connect poles', status: 'pending' },
      ],
      evidence,
      events: [],
    },
  }
}

class Rcon {
  constructor() {
    this.placed = { boiler: 0, 'steam-engine': 0 }
    this.requests = []
    this.unreadable = undefined
  }

  async command(text) {
    if (text.includes('remote.call("sgluna_deployment","status")')) return JSON.stringify(deployment())
    if (text.includes('remote.call("autorio_follow","status")')) return JSON.stringify({ active: false, healthy: false, controller_live: false })
    if (text.includes('remote.call("autorio_operations","status")')) return JSON.stringify({ task_state: 'idle', queue_length: 0, queue_empty: true })
    if (text.includes('remote.call("autorio_tools","evaluate_condition"')) {
      const request = JSON.parse(text.match(/json_to_table\('(\{.*\})'\)/)[1])
      this.requests.push(request)
      if (this.unreadable === 'throw') throw new Error('rcon transport closed')
      if (request.kind !== 'entity_count') return JSON.stringify({ ok: false, error: 'unsupported_condition_kind' })
      // The mod's own refusal for a name that is not an entity prototype.
      if (!(request.prototype in this.placed)) return JSON.stringify({ ok: false, error: 'unknown_entity', prototype: request.prototype })
      const current = this.placed[request.prototype]
      return JSON.stringify({ ok: true, kind: 'entity_count', prototype: request.prototype, minimum: request.minimum, current, found: current, truncated: false,
        satisfied: current >= request.minimum, ...(request.radius ? { radius: request.radius } : {}), ...(request.state ? { state: request.state } : {}), tick: 900, progress_known: false })
    }
    return '{}'
  }
}

function world(state = activeState()) {
  const memory = new CanonicalTaskBoardMemory()
  const key = 'npc:sgluna'
  memory.planByNpc.set(key, state)
  memory.ensurePlanningDraft(key, state, { now: 100, migrated: true })
  memory.commitPlanningPlan(key, { now: 110, migrated: true, runtime_validation: { passed: true } })
  const rcon = new Rcon()
  const rows = []
  const agent = new NpcAgentLoop({
    rcon, memory, npcId: 'sgluna', systemPrompt: 'entity count contract', provider: async () => { throw new Error('main planner not expected') },
    stateFile: null, traceFile: null, decisionTraceFile: null,
  })
  agent.behaviorTrace = { emit: async (record) => { rows.push(record) } }
  agent.traceRequest = { id: 'req_unit9_build', seq: 0 }
  agent.active = true
  agent.epoch = deployment()
  agent.lastMemoryKey = key
  agent.requestInfo = { memoryKey: key, turnId: 1, sender: 'tester', text: 'continue' }
  return { agent, memory, rcon, key, rows, named: name => rows.filter(row => row.event === name).map(row => row.data ?? row) }
}

const receipt = () => ({ view: { last_completed_batch: { batch_id: 7 } } })

test('G2a: a place_entity receipt alone never closes a build step; the step closes only when the live count reaches every minimum', async () => {
  const { agent, memory, rcon, key, named } = world()
  rcon.placed = { boiler: 1, 'steam-engine': 1 } // the receipt of one placement landed; two boilers are still missing

  const open = await agent.routeStepCompletionDecision(receipt())
  assert.equal(open.verified, false)
  assert.equal(open.reason, 'checkpoint_requirements_unsatisfied')
  assert.equal(memory.currentPlan(key).task_board.completed_count, 0)
  assert.equal(getActivePlan(memory.planningState(key)).active_step_index, 0)

  rcon.placed = { boiler: 3, 'steam-engine': 1 }
  const closed = await agent.routeStepCompletionDecision(receipt())
  assert.equal(closed.verified, true)
  assert.equal(memory.currentPlan(key).task_board.completed_count, 1)
  assert.equal(memory.currentPlan(key).task_board.active_step_id, 'step_2')

  // The read carries the requirement's own scope to the mod, and each check is traced with the count it saw and a reason.
  assert.deepEqual(rcon.requests.slice(0, 2), [
    { kind: 'entity_count', prototype: 'boiler', minimum: 3 },
    { kind: 'entity_count', prototype: 'steam-engine', minimum: 1, radius: 30 },
  ])
  const checks = named('step.entity_count_checked')
  assert.equal(checks.length, 4)
  for (const row of checks) {
    assert.equal(row.request_id, 'req_unit9_build')
    assert.equal(row.reason, 'live_world_count_decides_build_step_not_receipt')
    assert.equal(row.authoritative, true)
  }
  assert.deepEqual(checks.slice(0, 2).map(row => [row.requirement_id, row.prototype, row.minimum, row.current, row.satisfied]), [['boilers', 'boiler', 3, 1, false], ['engines', 'steam-engine', 1, 1, true]])
  assert.deepEqual(checks.slice(2).map(row => [row.requirement_id, row.current, row.satisfied]), [['boilers', 3, true], ['engines', 1, true]])
  assert.equal(checks[1].radius, 30)
})

test('G2a: a count the mod could not read, or a prototype it refuses, never closes the step and is traced with the reason', async () => {
  const unknown = world(activeState({ mode: 'all', requirements: [{ id: 'ghosts', kind: 'entity_count', prototype: 'not-an-entity', minimum: 1 }] }))
  const refused = await unknown.agent.routeStepCompletionDecision(receipt())
  assert.equal(refused.verified, false)
  assert.equal(unknown.memory.currentPlan(unknown.key).task_board.completed_count, 0)
  const [row] = unknown.named('step.entity_count_checked')
  assert.equal(row.request_id, 'req_unit9_build')
  assert.equal(row.authoritative, false)
  assert.equal(row.satisfied, false)
  assert.equal(row.reason, 'unknown_entity')

  const down = world()
  down.rcon.placed = { boiler: 9, 'steam-engine': 9 }
  down.rcon.unreadable = 'throw'
  const failed = await down.agent.routeStepCompletionDecision(receipt())
  assert.equal(failed.verified, false)
  assert.equal(down.memory.currentPlan(down.key).task_board.completed_count, 0)
  assert.match(down.named('step.entity_count_checked')[0].reason, /^read_failed:/)
})

test('G2a: an entity_count checkpoint is grounded against the live game when it is authored', async () => {
  const { agent, rcon } = world()
  rcon.placed = { boiler: 0, 'steam-engine': 0 }
  const known = await agent.validatePlannerCheckpointContract({ mode: 'all', requirements: [{ id: 'boilers', kind: 'entity_count', prototype: 'boiler', minimum: 2 }] }, [])
  assert.equal(known.accepted, true, JSON.stringify(known))
  const unknown = await agent.validatePlannerCheckpointContract({ mode: 'all', requirements: [{ id: 'bad', kind: 'entity_count', prototype: 'not-an-entity', minimum: 2 }] }, [])
  assert.equal(unknown.accepted, false)
  assert.equal(unknown.reason, 'unknown_entity')
  assert.equal(unknown.requirement_kind, 'entity_count')
})
