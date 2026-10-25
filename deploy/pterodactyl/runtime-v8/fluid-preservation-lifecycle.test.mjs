import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { reconcilePreservationProof } from './contract-obligation-runtime.mjs'
import { captureObligationProof, compileObligations, effectivePreservationProof, obligationProofOrigin,
  normalizeFluidAdmission, preservedProofMatches } from './contract-obligations.mjs'
import { fluidGeometry, fluidFixture } from './fluid-preservation-fixtures.mjs'
import { answersStepContract, FakeFactorio, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:fluid-fixture'
function world({ trace, persist, read } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio({ inventory: { boiler: 1, coal: 2 } })
  game.status.actor_id = 10
  game.status.connected_players = 0
  game.nearby = [fluidGeometry().entity]
  const native = game.command.bind(game)
  const recordAdmission = memory.recordPreservationAdmission.bind(memory)
  memory.recordPreservationAdmission = (key, envelope) => {
    const state = memory.planningState(key); const plan = getActivePlan(state); const step = plan.steps[plan.active_step_index]
    const held = effectivePreservationProof(plan, step)
    const result = recordAdmission(key, envelope)
    if (!result) throw new Error(JSON.stringify({ fixture_admission_diagnostic: true, goal: state.goal.status, plan: plan.status,
      origin: obligationProofOrigin(state, step), normalized: !!normalizeFluidAdmission(envelope, plan, step), held: !!held,
      matches: !!held && preservedProofMatches(held, envelope.baseline), timestamps: [held?.captured_at, envelope.baseline.captured_at, envelope.created_at, Date.now()],
      pending: state.operation_ledger.records, envelope_owner: envelope.owner, generation: envelope.native_generation, max_batch: envelope.native_max_batch_id }))
    return result
  }
  const rows = []; const calls = []
  let agent
  game.command = async text => {
    await read?.({ text, game, memory, agent })
    if (text.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(text)?.[1])
      return JSON.stringify(fluidGeometry(id, game.connected === true))
    }
    if (text.includes('autorio_preflight') && text.includes('place_candidate')) {
      return JSON.stringify({ ok: true, operation: 'place_candidate', preservation_join: fluidFixture().admission.candidate })
    }
    if (text.includes('autorio_crafting') && text.includes('status')) return JSON.stringify({ task_active: false, native_queue: [] })
    if (text.includes('evaluate_condition') && text.includes('entity_count')) return JSON.stringify({ ok: true, kind: 'entity_count',
      prototype: 'boiler', current: game.connected ? 1 : 0, found: game.connected ? 1 : 0, satisfied: game.connected === true, truncated: false })
    if (text.includes('autorio_operations","status')) {
      const status = JSON.parse(await native(text))
      if (status.last_completed_batch) {
        Object.assign(status.last_completed_batch, { batch_generation: 1, batch_ref: `batch-g1-${game.batchId}` })
        status.receipt_journal = [{ ...status.last_completed_batch, state: 'completed' }]
      }
      return JSON.stringify(status)
    }
    return native(text)
  }
  game.onMutation = text => {
    if (text.includes("'place_candidate'")) {
      game.lastTaskTypes = ['placing']; game.connected = true; game.inventory.boiler = 0
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 10,
        type: 'placing', accepted: true, completed: true, code: 'completed', entity_name: 'boiler',
        placed_unit_number: 2, placed_entity_type: 'boiler', placed_position: { x: 0, y: 3 }, placed_surface_index: 1, placed_direction: 0 }
    } else if (text.includes("'supply_entity'")) {
      game.lastTaskTypes = ['moving_items']; game.inventory.coal--
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 10,
        type: 'moving_items', accepted: true, completed: true, code: 'completed', target_unit_number: 2, to_entity: true, moved_count: 1 }
    }
  }
  const first = fluidFixture().step.obligations
  const second = { outcome: { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name: 'supply_entity' }] }, preserve: [1] }
  agent = new NpcAgentLoop({ memory, rcon: game, npcId: 'fluid-fixture', completionProtocolVersion: 3,
    requireTypedObligations: true, replacementWake: true, stateFile: null, traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Scripted offline native-substitution fixture; retain pump and existing edges.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      calls.push(context.role)
      if (context.role === 'planner') return planReply({ plan: ['Install one boiler connected to the existing pump.', 'Fuel the installed boiler with one coal.'],
        currentStep: 0, operations: [], goal: { scope: 'long_horizon', summary: 'Build fixture steam production without changing the goal.',
          doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 99 }] }, roadmap: [{ id: 'steam', intent: 'Run native steam production.' }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: compileObligations(first), obligations: first }, { kind: 'deterministic', obligations: second }],
        executionGuidance: ['Join the existing pump with one boiler.', 'Supply one coal to the installed boiler.'].map(approach =>
          ({ approach, rationale: 'Preserve pump identity and all prior edges.', constraints: [], skillIds: [], materialSupply: null })) })
      const held = getActivePlan(memory.planningState(KEY)); const step = held.steps[held.active_step_index]
      if (held.active_step_index === 0) return planReply({ stepId: step.step_id,
        operations: [{ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }] })
      return planReply({ stepId: step.step_id, operations: [{ name: 'supply_entity', args: { unit_number: 2, items: [{ item_name: 'coal', count: 1 }] } }] })
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row); await trace?.({ row, agent, memory, game }) } }
  const realPersist = agent.persistState.bind(agent)
  agent.persistState = async options => { await realPersist(options); await persist?.({ options, agent, memory, game }) }
  // Production before-send hook is exercised directly; no provisional wrapper.
  return { agent, memory, game, rows, calls, held: () => getActivePlan(memory.planningState(KEY)),
    start: () => agent.request('Build fixture steam production without changing the goal.', { sender: 'Louis' }) }
}

test('real prepared ledger -> exact single boiler receipt -> certified addition -> unchanged next semantic step', async () => {
  const w = world()
  const started = await w.start()
  assert.equal(w.game.mutations.length, 1, JSON.stringify({ started, events: w.rows.filter(row => /failed|refused|classified|paused/.test(row.event)).slice(-4) }))
  assert.equal(Object.keys(w.held().execution.preservation_admissions).length, 1)
  const baseline = structuredClone(w.held().steps.map(row => row.obligation_proof))
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 1, JSON.stringify({ board: w.memory.currentPlan(KEY)?.task_board, execution: w.held().execution, events: w.rows.slice(-12) }))
  assert.equal(w.game.mutations.filter(text => text.includes("'place_candidate'")).length, 1)
  assert.equal(w.game.mutations.length, 2)
  assert.ok(w.game.mutations[1].includes("'supply_entity'"))
  assert.equal(w.held().execution.preservation_certificates.length, 1)
  assert.deepEqual(w.held().steps.map(row => row.obligation_proof), baseline)
  assert.equal(w.rows.filter(row => row.event === 'contract.fluid_addition_certified').length, 1)
  assert.equal(w.memory.planningState(KEY).goal.replacements_accepted ?? 0, 0)
})

test('missed first normalization self-reconciles from durable admission plus exact receipt without replay', async () => {
  const w = world(); await w.start()
  await w.agent.taskStatusReceipt() // Simulate lost completion normalization/callback.
  assert.equal(w.held().execution.preservation_certificates, undefined)
  const step = w.held().steps[0]
  const owner = w.agent.captureCheckpointOwner()
  const fresh = await captureObligationProof(w.agent, step.obligations, () => w.agent.assertCheckpointOwnerCurrent(owner))
  assert.equal(await reconcilePreservationProof(w.agent, step, fresh, () => w.agent.assertCheckpointOwnerCurrent(owner)), true, JSON.stringify({ board: w.memory.currentPlan(KEY)?.task_board, execution: w.held().execution }))
  assert.equal(w.game.mutations.length, 1)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot()); w.agent.memory = restored
  const plan = getActivePlan(restored.planningState(KEY))
  assert.equal(effectivePreservationProof(plan, plan.steps[0]).preserved[0].fluid.storages[0].ports[0].target.entity.unit_number, 2)
  assert.equal(plan.steps[0].obligation_proof.preserved[0].fluid.storages[0].ports[0].connected, false)
})

test('typed proof admission failure durably guard-pauses without replacement authority or native send', async () => {
  const w = world({ read: ({ text, game, memory }) => {
    if (text.includes('autorio_operations","status') && memory.pendingOperations(KEY).length) game.queueLength = 1
  } })
  await assert.rejects(w.start(), /preservation_admission_native_busy/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  assert.equal(w.memory.pendingOperations(KEY).length, 0)
  assert.equal(w.held().status, 'COMMITTED')
  assert.equal(w.held().steps.length, 2)
  assert.equal(w.held().execution.preservation_certificates, undefined)
  assert.ok(w.rows.some(row => row.event === 'contract.preservation_refused' && row.data.code === 'preservation_admission_native_busy'
    && row.data.category === 'unproven' && row.data.stage === 'admission' && row.data.retryable === false))
})
