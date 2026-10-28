import assert from 'node:assert/strict'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { reconcilePreservationProof } from './contract-obligation-runtime.mjs'
import { captureObligationProof, compileObligations, effectivePreservationProof } from './contract-obligations.mjs'
import { fluidGeometry, fluidFixture } from './fluid-preservation-fixtures.mjs'
import { answersStepContract, FakeFactorio, planReply } from './task-loop-fixtures.mjs'

const KEY = 'npc:fluid-fixture'
function world({ trace, persist, read, response, executorReply, journal, craftingQueue, secondOperation, doneMinimum = 99 } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  const game = new FakeFactorio({ inventory: { boiler: 1, coal: 2 } })
  game.status.actor_id = 10
  game.status.connected_players = 0
  game.nearby = [fluidGeometry().entity]
  const native = game.command.bind(game)
  const rows = []; const calls = []; const prepared = []
  let agent
  game.command = async text => {
    if (text.includes('projection="next_slice_ownership_v1"')) return native(text)
    await read?.({ text, game, memory, agent })
    const substituted = await response?.({ text, game, memory, agent })
    if (substituted !== undefined) return typeof substituted === 'string' ? substituted : JSON.stringify(substituted)
    if (text.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(text)?.[1])
      return JSON.stringify(fluidGeometry(id, game.connected === true))
    }
    if (text.includes('autorio_preflight') && text.includes('place_candidate')) {
      return JSON.stringify({ ok: true, operation: 'place_candidate', preservation_join: fluidFixture().admission.candidate })
    }
    if (text.includes('fluid_preservation_candidate')) {
      const candidate = fluidFixture().admission.candidate
      const pending = memory.pendingOperations(KEY)[0]
      const held = getActivePlan(memory.planningState(KEY)); const step = held.steps[held.active_step_index]
      candidate.operation_key = pending?.operation_key; candidate.signature = pending?.signature
      const selected = /fluid_preservation_candidate["'],\s*["']([^"']+)["'],\s*["']([^"']+)["']/.exec(text)
      candidate.candidate_set_id = selected?.[1] ?? candidate.candidate_set_id
      candidate.candidate_id = selected?.[2] ?? candidate.candidate_id
      candidate.native_baseline = { generation: pending.baseline.generation, max_batch_id: pending.baseline.max_batch_id }
      candidate.owner = { goal_id: held.goal_id, plan_id: held.plan_id, plan_version: held.plan_version, step_id: step.step_id,
        semantic_step_id: step.semantic_step_id ?? step.step_id, actor_id: 10, actor_epoch: 3, session: game.status.session }
      candidate.protected_geometry = [fluidGeometry(1, game.connected === true)]
      return JSON.stringify({ ok: true, preservation_join: candidate })
    }
    if (text.includes('autorio_crafting') && text.includes('status')) return JSON.stringify({ task_active: false, native_queue: craftingQueue ? craftingQueue() : [] })
    if (text.includes('evaluate_condition') && text.includes('entity_count')) return JSON.stringify({ ok: true, kind: 'entity_count',
      prototype: 'boiler', current: game.connected ? 1 : 0, found: game.connected ? 1 : 0, satisfied: game.connected === true, truncated: false })
    if (text.includes('autorio_operations","status')) {
      const status = JSON.parse(await native(text))
      if (journal && game.batchId === 0) status.admission_journal = journal({ status, game, memory, agent })
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
      const envelope = Object.values(getActivePlan(memory.planningState(KEY)).execution.preservation_admissions).at(-1)
      game.lastBasicResult.preservation_binding = { operation_key: envelope.operation_key, attempt_id: envelope.attempt_id,
        ordinal: envelope.ordinal, signature: envelope.signature, owner: envelope.candidate.owner,
        batch_id: game.batchId, batch_generation: 1, batch_ref: `batch-g1-${game.batchId}` }
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
          doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: doneMinimum }] }, roadmap: [{ id: 'steam', intent: 'Run native steam production.' }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: compileObligations(first), obligations: first }, { kind: 'deterministic', obligations: second }],
        executionGuidance: ['Join the existing pump with one boiler.', 'Supply one coal to the installed boiler.'].map(approach =>
          ({ approach, rationale: 'Preserve pump identity and all prior edges.', constraints: [], skillIds: [], materialSupply: null })) })
      const held = getActivePlan(memory.planningState(KEY)); const step = held.steps[held.active_step_index]
      const reply = await executorReply?.({ held, step, game, agent, memory })
      if (reply !== undefined) return reply
      if (held.active_step_index === 0) return planReply({ stepId: step.step_id,
        operations: [{ name: 'place_candidate', args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1' } }] })
      return planReply({ stepId: step.step_id, operations: [secondOperation ?? { name: 'supply_entity', args: { unit_number: 2, items: [{ item_name: 'coal', count: 1 }] } }] })
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row); if (row.event === 'operations.admit') prepared.push(row.data.operations); await trace?.({ row, agent, memory, game }) } }
  const realPersist = agent.persistState.bind(agent)
  agent.persistState = async options => { await realPersist(options); await persist?.({ options, agent, memory, game }) }
  // The real production hook runs once; prepared counts observe its existing admission trace.
  return { agent, memory, game, rows, calls, prepared, held: () => getActivePlan(memory.planningState(KEY)),
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

for (const name of ['rotate_entity', 'mine_entity_exact']) test(`actual prepared next-step ${name} of certified neighbour is refused before native transport`, async () => {
  const w = world({ secondOperation: { name, args: { unit_number: 2 } } })
  await w.start(); await assert.rejects(w.agent.completed(), /preservation_protected_mutation_refused/)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.prepared.length, 2, 'the destructive operation reached the real prepared admission seam')
  assert.equal(w.prepared[1][0].name, name)
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.held().execution.preservation_certificates.length, 1)
})

for (const seam of ['admission_persist', 'admission_trace']) for (const fault of ['amendment', 'native_busy']) {
  test(`helper fences ${fault} during ${seam} before the unsent catch, with zero native sends`, async () => {
    let injected = false
    const inject = ({ agent, game, memory }) => {
      if (injected || !Object.keys(getActivePlan(memory.planningState(KEY))?.execution.preservation_admissions ?? {}).length) return
      injected = true
      if (fault === 'amendment') agent.pendingInteractionAmendment = { sender: 'Louis', text: 'Hold for new direction.' }
      else { game.taskState = 'working'; game.queueLength = 1 }
    }
    const w = world(seam === 'admission_persist' ? { persist: inject } : { trace: data => {
      if (data.row.event === 'contract.fluid_admission_prepared') inject(data)
    } })
    await assert.rejects(w.start(), /preservation_admission_not_safe|preservation_admission_native_busy|preservation_pre_admission_boundary_changed/)
    assert.equal(injected, true); assert.equal(w.game.mutations.length, 0)
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.memory.pendingOperations(KEY).length, 0, 'unsent pending settles without an uncertain gameplay effect')
    // The actual helper and outer production unwind retain the newer amendment.
    if (fault === 'amendment') assert.equal(w.agent.currentPendingAmendment()?.text, 'Hold for new direction.')
  })
}

for (const seam of ['certificate_persist', 'certificate_trace']) test(`receipt close defers late same-owner amendment during ${seam} without next mutation`, async () => {
  let injected = false
  const inject = ({ agent, memory }) => {
    if (injected || !getActivePlan(memory.planningState(KEY))?.execution.preservation_certificates?.length) return
    injected = true; agent.pendingInteractionAmendment = { sender: 'Louis', text: 'Hold after exact boiler receipt.' }
  }
  const w = world(seam === 'certificate_persist' ? { persist: inject } : { trace: data => {
    if (data.row.event === 'contract.fluid_addition_certified') inject(data)
  } })
  await w.start(); const providers = w.calls.length; const result = await w.agent.completed()
  assert.equal(injected, true); assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, providers)
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.agent.currentPendingAmendment()?.text, 'Hold after exact boiler receipt.')
  assert.ok(result.deferred || result.goalStatus === 'paused', JSON.stringify(result))
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

for (const seam of ['strict_envelope_persist', 'prepared_trace']) {
  test(`real production hook retains same-owner amendment at ${seam} without native send or next step`, async () => {
    let injected = false
    let amendment
    let request
    let callsAtSeam
    const inject = ({ agent }) => {
      if (injected) return
      injected = true
      amendment = { text: 'Later compatible instruction', source: 'user', seam }
      request = agent.traceRequest
      callsAtSeam = w.calls.length
      agent.pendingInteractionAmendment = amendment
    }
    const w = world({
      persist: context => {
        if (seam === 'strict_envelope_persist' && context.options?.strict
          && Object.keys(getActivePlan(context.memory.planningState(KEY))?.execution?.preservation_admissions ?? {}).length) inject(context)
      },
      trace: context => { if (seam === 'prepared_trace' && context.row.event === 'contract.fluid_admission_prepared') inject(context) },
    })
    await assert.rejects(w.start(), { code: 'preservation_admission_not_safe', category: 'unproven', stage: 'admission' })
    assert.equal(injected, true)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.calls.length, callsAtSeam)
    assert.equal(w.agent.pendingInteractionAmendment, amendment)
    assert.equal(w.agent.traceRequest, request)
    assert.equal(w.memory.pendingOperations(KEY).length, 0)
    assert.equal(w.held().status, 'COMMITTED')
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.held().execution.preservation_certificates, undefined)
  })
}
test('normal runtime receipt churn, genuine plan completion, closed4 trimming and snapshot restore retain sealed additive authority', async () => {
  const w = world({ doneMinimum: 1 })
  await w.start(); await w.agent.completed()
  const id = w.held().plan_id; const first = w.held().steps[0].step_id
  for (let i = 0; i < 32; i++) w.memory.dispatchPlanningEvent(KEY, { type: 'OPERATION_RECEIPT_RECORDED', source: 'runtime',
    plan_id: id, step_id: first, kind: 'observation', ref: `normal_churn_${i}`, summary: 'fresh unrelated observation', now: Date.now() })
  assert.equal(w.held().execution.receipts[first].length, 24)
  assert.equal(w.held().execution.receipts[first].some(row => row.ref === 'batch-g1-1'), false)
  assert.ok(effectivePreservationProof(w.held(), w.held().steps[0]))
  await w.agent.completed()
  const snapshot = w.memory.snapshot()
  const restored = new CanonicalTaskBoardMemory(); restored.restore(snapshot)
  const plan = restored.planningState(KEY).plans.find(row => row.plan_id === id)
  assert.equal(plan.status, 'COMPLETED')
  assert.equal(plan.execution.receipts[first].length, 4)
  assert.ok(effectivePreservationProof(plan, plan.steps[0]))
  assert.equal(effectivePreservationProof(plan, plan.steps[1], { plans: restored.planningState(KEY).plans }).preserved[0].fluid.storages[0].ports[0].target.entity.unit_number, 2)
  assert.equal(w.game.mutations.length, 2)
})

test('durable admission capacity refuses before send and survives restart without minting a fresh allowance', async () => {
  const w = world()
  const record = w.memory.recordPreservationAdmission.bind(w.memory)
  let seeded = false
  w.memory.recordPreservationAdmission = (key, envelope) => {
    if (!seeded) {
      seeded = true
      // Explicit saturation precondition: 64 previously valid durable native
      // claims for this exact typed step, none relabelled as a completed effect.
      const admissions = {}
      for (let i = 0; i < 64; i++) {
        const prior = structuredClone(envelope)
        prior.operation_key = `prior/${i}`; prior.candidate.operation_key = prior.operation_key
        admissions[prior.operation_key] = prior
      }
      w.held().execution.preservation_admissions = admissions
    }
    return record(key, envelope)
  }
  await assert.rejects(w.start(), error => error.code === 'preservation_admission_limit_exhausted')
  assert.equal(w.game.mutations.length, 0); assert.equal(w.prepared.length, 1)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  const plan = getActivePlan(restored.planningState(KEY))
  assert.equal(Object.keys(plan.execution.preservation_admissions).length, 64)
  assert.equal(plan.execution.preservation_certificates, undefined)
  assert.equal(restored.planningState(KEY).goal.replacements_accepted ?? 0, 0)
})

for (const seam of ['certificate_persist', 'certificate_trace']) test(`fresh native busy during ${seam} prevents ordinary close and next mutation`, async () => {
  let fired = false
  const inject = ({ memory, game }) => {
    if (!fired && getActivePlan(memory.planningState(KEY))?.execution.preservation_certificates?.length) {
      fired = true; game.taskState = 'working'; game.queueLength = 1
    }
  }
  const w = world(seam === 'certificate_persist' ? { persist: inject } : { trace: data => {
    if (data.row.event === 'contract.fluid_addition_certified') inject(data)
  } })
  await w.start(); const providers = w.calls.length; const result = await w.agent.completed()
  assert.equal(fired, true); assert.equal(w.game.mutations.length, 1); assert.equal(w.calls.length, providers)
  assert.equal(w.held().active_step_index, 0)
  assert.ok(result.goalStatus === 'paused' || result.deferred, JSON.stringify(result))
})



const nativeJournalRecord = state => ({ operation_key: 'historical/operation', attempt_id: 'historical/attempt', signature: 'a'.repeat(64),
  ordinal: 1, actor_id: 10, epoch: 3, generation: 1, tick: 600, operation_count: 1, state,
  slots: state === 'completed' ? [{ index: 1, ok: true, operation: 'wait', queued_tasks: 0, batch_refs: {} }] : {} })

for (const [shape, journal] of [['cold Lua empty object', () => ({})], ['empty array', () => []], ['resolved historical array', () => [nativeJournalRecord('completed')]]]) {
  test(`actual helper accepts native ${shape} before exact fluid send and certificate`, async () => {
    const w = world({ journal })
    await w.start()
    assert.equal(w.game.mutations.length, 1)
    assert.equal(Object.keys(w.held().execution.preservation_admissions).length, 1)
    await w.agent.completed()
    assert.equal(w.held().execution.preservation_certificates.length, 1)
    assert.equal(w.held().active_step_index, 1)
    assert.equal(w.game.mutations.length, 2)
    assert.ok(w.game.mutations[1].includes("'supply_entity'"))
  })
}

for (const [shape, journal] of [
  ['missing', () => undefined], ['null', () => null], ['nested records', () => ({ records: [] })],
  ['malformed nonempty object', () => ({ unexpected: 1 })], ['malformed terminal', () => [{ ...nativeJournalRecord('completed'), slots: [{ index: 2, ok: true, batch_refs: [] }] }]],
  ['truncated array', () => Array.from({ length: 129 }, (_, index) => ({ ...nativeJournalRecord('completed'), operation_key: `historical/${index}` }))],
  ...['admitting', 'admitted', 'uncertain'].map(state => [state, () => [nativeJournalRecord(state)]]),
  ['exact pending already recorded', ({ memory }) => [{ ...nativeJournalRecord('completed'), operation_key: memory.pendingOperations(KEY)[0]?.operation_key ?? 'historical/operation' }]],
]) {
  test(`actual helper refuses ${shape} native journal without fluid send or certificate`, async () => {
    const w = world({ journal })
    await assert.rejects(w.start(), /preservation_pre_admission_receipt_boundary_unproven/)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.game.inventory.boiler, 1)
    assert.deepEqual(w.held().execution.preservation_certificates ?? [], [])
    assert.deepEqual(w.held().execution.preservation_admissions ?? {}, {})
    assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  })
}


for (const [shape, craftingQueue] of [['empty array', () => []], ['cold Lua empty object', () => ({})]]) {
  test(`actual fluid hook accepts crafting ${shape} before send and certificate`, async () => {
    const w = world({ craftingQueue })
    await w.start()
    assert.equal(w.game.mutations.length, 1)
    assert.equal(Object.keys(w.held().execution.preservation_admissions).length, 1)
    await w.agent.completed()
    assert.equal(w.held().execution.preservation_certificates.length, 1)
    assert.equal(w.held().active_step_index, 1)
    assert.equal(w.game.mutations.length, 2)
    assert.ok(w.game.mutations[1].includes("'supply_entity'"))
  })
}

for (const [shape, craftingQueue] of [
  ['missing', () => undefined], ['null', () => null], ['numeric zero', () => 0], ['boolean false', () => false], ['empty string', () => ''],
  ['nonempty array', () => [{ count: 1 }]], ['nonempty object', () => ({ queued: 1 })], ['nested records', () => ({ records: [] })],
  ['malformed array', () => [null]],
]) {
  test(`actual fluid hook refuses crafting ${shape} without send or certificate`, async () => {
    const w = world({ craftingQueue })
    await assert.rejects(w.start(), /preservation_admission_native_busy/)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.game.inventory.boiler, 1)
    assert.deepEqual(w.held().execution.preservation_certificates ?? [], [])
    assert.deepEqual(w.held().execution.preservation_admissions ?? {}, {})
    assert.equal(w.memory.pauseRecord(KEY).pause_class, 'guard')
  })
}

test('BD fluid-version2 invisible proof admits only owned observation walk and then certifies the actual prior placement', async () => {
  const w = world()
  await w.start()
  let invisible = true
  const native = w.game.command.bind(w.game)
  const mutate = w.game.onMutation
  w.game.onMutation = text => {
    mutate?.(text)
    if (text.includes("'walk_to_position'")) invisible = false
  }
  w.game.command = async text => {
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 10, position: { x: 100, y: 20 } }, surface_index: 1, force_index: 1 })
    if (invisible && text.includes('entity_geometry')) return JSON.stringify({ found: false, code: 'entity_not_visible' })
    return native(text)
  }
  await w.agent.completed()
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 1, JSON.stringify(w.rows.slice(-12)))
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 1, JSON.stringify(w.rows.slice(-12)))
  assert.equal(w.game.mutations.filter(text => text.includes("'place_candidate'")).length, 1)
  assert.equal(w.held().execution.preservation_certificates.length, 1)
})
