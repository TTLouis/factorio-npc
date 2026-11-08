import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { capturePlannerObligationProof, itemPreservationConflict } from './contract-obligation-runtime.mjs'
import { preservationGeometry, preservedProofMatches, normalizeObligationProof } from './contract-obligations.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { argumentCorrectionAvailable } from './planning-state.mjs'
import { planReply, answersStepContract } from './task-loop-fixtures.mjs'

const recorded = JSON.parse(fs.readFileSync(new URL('./fixtures/run-bf-preservation.json', import.meta.url)))
const originalOperations = JSON.parse(recorded.a_reply.tool_calls[0].function.arguments).operations
const originalProof = recorded.a_step.obligation_proof
const directory = new URL('./', import.meta.url)
const source = fs.readFileSync(new URL('./contract-obligations.test.mjs', import.meta.url), 'utf8')
const prefix = source.slice(0, source.indexOf("test('AV exact original"))
  .replaceAll("from './", `from '${directory.href}`).replaceAll("new URL('./", `new URL('${directory.href}`)
const fixture = await import(`data:text/javascript;base64,${Buffer.from(`${prefix}\nexport { world, geometry, KEY, injectResidual }`).toString('base64')}`)

// Real request/plan/admission/receipt lifecycle. Native replies and provider
// choices alone are scripted. The frozen BF reply/proof are checked separately.
function world({ container = false, residual = false, repeat = false, fault, ...options } = {}) {
  const w = fixture.world(options)
  const native = w.game.command.bind(w.game)
  const provider = w.agent.provider
  let executorTurns = 0
  w.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('entity_geometry')) return raw
    const data = JSON.parse(raw)
    if (container && data.entity?.unit_number === 22) Object.assign(data.entity, { name: 'wooden-chest', type: 'container' })
    if (container && data.item_io?.drop_target) Object.assign(data.item_io.drop_target, { name: 'wooden-chest', type: 'container' })
    return JSON.stringify(data)
  }
  w.agent.provider = async (messages, context) => {
    const reply = await provider(messages, context)
    if (context.role !== 'executor' || w.held()?.active_step_index !== 0) return reply
    if (executorTurns++ === 0 || repeat) return planReply({ stepId: w.held().steps[0].step_id,
      operations: [{ name: 'mine_entity_exact', args: { unit_number: 22 } }] })
    return reply
  }
  if (residual) {
    // Deliberately bypass the ordinary preflight once; the production final
    // admission and unsent settlement must detect and recover the miss.
    const preflight = w.agent.preflightOperations.bind(w.agent)
    let missed = false
    w.agent.preflightOperations = async operations => {
      if (!missed) { missed = true; return operations.map(() => ({ ok: true })) }
      return preflight(operations)
    }
  }
  if (fault) {
    const emit = w.agent.behaviorTrace.emit
    w.agent.behaviorTrace.emit = async row => {
      await emit(row)
      if (row.event === 'contract.item_preservation_refused') await fault(w)
    }
  }
  return w
}

test('BF exact eleven-operation reply protects belt43 via inserter44 under both proof versions', () => {
  assert.equal(recorded.source_sha, '3a1827ae5face33f619289ddcd8a290b380cc7e6')
  assert.equal(originalOperations.length, 11)
  assert.equal(originalProof.preserved.find(row => row.entity.unit_number === 44).item_io.drop_target.unit_number, 43)
  assert.ok(!recorded.a_step.obligations.preserve.includes(43))
  for (const version of [1, 2]) {
    const conflict = itemPreservationConflict({ ...originalProof, version }, originalOperations)
    assert.equal(originalOperations[conflict.operation_index].args.unit_number, 43)
    assert.equal(conflict.reason, 'protected_identity_or_item_endpoint')
  }
})

test('BF successor retains the chest preservation requirement; container stock is not frozen', () => {
  const reply = JSON.parse(recorded.b_reply.content)
  assert.ok(reply.stepCompletions.some(row => row.obligations.preserve.includes(30)))
  const raw = fixture.geometry(22)
  Object.assign(raw.entity, { name: 'wooden-chest', type: 'container' })
  const before = preservationGeometry(raw, 22)
  const after = preservationGeometry({ ...raw, inventory: { coal: 3 }, distance: 9 }, 22)
  assert.deepEqual(before, after)
  assert.equal(before.entity.type, 'container')
  assert.throws(() => preservationGeometry({ ...raw, entity: { ...raw.entity, type: 'logistic-container' } }, 22), /preservation_type_unsupported/)
})

for (const container of [false, true]) for (const residual of [false, true]) test(`real lifecycle preserves ${container ? 'container' : 'item endpoint'}, residual=${residual}, corrects once and continues automatically`, async () => {
  const w = world({ container, residual })
  await w.start()
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes("'place_entity'"))
  assert.equal(w.game.mutations.some(text => text.includes("'mine_entity_exact'")), false)
  const before = structuredClone(w.held().steps)
  assert.ok(normalizeObligationProof(before[0].obligation_proof, before[0].obligations))
  const refused = w.rows.find(row => row.event === 'contract.item_preservation_refused')
  assert.equal(refused.data.boundary, residual ? 'transport' : 'preflight')
  const corrected = w.rows.find(row => row.event === 'operations.preflight_recoverable')
  assert.equal(corrected.data.zero_send.reason, 'native_idle_journal_absent_exact_unsent_settled')
  if (residual) assert.ok(w.rows.some(row => row.event === 'operation.not_sent'))
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.mutations.length, 2)
  assert.deepEqual(w.held().steps[0], before[0])
  assert.deepEqual(w.held().steps.map(row => [row.step_id, row.semantic_step_id, row.description, row.obligations, row.obligation_proof]), before.map(row => [row.step_id, row.semantic_step_id, row.description, row.obligations, row.obligation_proof]))
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.equal(restored.planningState(fixture.KEY).goal.argument_corrections.claims.length, 1)
})

test('repeated unchanged route conflict exhausts durable allowance and remains exhausted after restart', async () => {
  const w = world({ repeat: true, residual: true, container: true })
  await assert.rejects(w.start(), /argument_correction_limit_exhausted/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.pendingOperations(fixture.KEY).length, 0)
  assert.ok(w.rows.some(row => row.event === 'contract.preservation_refused' && row.data.code === 'argument_correction_limit_exhausted'))
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.equal(argumentCorrectionAvailable(restored.planningState(fixture.KEY)), false)
  assert.equal(restored.planningState(fixture.KEY).goal.argument_corrections.claims.length, 1)
})

for (const [name, fault] of Object.entries({
  busy: w => { w.game.queueLength = 1; w.game.taskState = 'working' },
  amendment: w => { w.agent.pendingInteractionAmendment = { sender: 'Louis', text: 'Hold.' } },
  request: w => { w.agent.requestAdmissionOwner = { replacement: true } },
  epoch: w => { w.game.status.epoch++ },
  cancel: w => { w.agent.cancel('user_stop') },
  step: w => { w.held().steps[0].obligation_proof.binding.step_id = 'wrong-step' },
  uncertain: w => { const native = w.game.command.bind(w.game); w.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('autorio_operations","status')) return raw
    const status = JSON.parse(raw); delete status.admission_journal; return JSON.stringify(status)
  } },
})) test(`residual correction fences ${name} introduced during refusal trace`, async () => {
  const w = world({ residual: true, fault })
  await w.start().catch(() => undefined)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.memory.planningState(fixture.KEY).goal.argument_corrections.claims.length, 0)
})

test('applied loss of a protected endpoint pauses; a replacement unit never becomes the baseline', async () => {
  const w = fixture.world()
  await w.start()
  const original = structuredClone(w.held().steps)
  const native = w.game.command.bind(w.game)
  w.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('entity_geometry')) return raw
    const geometry = JSON.parse(raw)
    if (geometry.item_io?.drop_target) geometry.item_io.drop_target.unit_number = 999
    return JSON.stringify(geometry)
  }
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.mutations.length, 1)
  assert.deepEqual(w.held().steps, original)
  assert.ok(w.rows.some(row => row.event === 'contract.preservation_close_refused' && row.data.reason === 'preservation_baseline_changed'))
})

test('clearance, rotation, opaque construction and open-port placements share the item-route rule', () => {
  for (const name of ['rotate_entity', 'mine_entity_exact', 'clear_construction_area', 'reserve_construction_area', 'prepare_pump_site', 'execute_construction_plan']) {
    assert.ok(itemPreservationConflict(originalProof, [{ name, args: { unit_number: 43 } }]), name)
  }
  const port = originalProof.preserved.find(row => row.entity.unit_number === 44).item_io.drop_position
  const operation = { name: 'place_entity', args: { entity_name: 'wooden-chest', ...port } }
  const footprint = { tile_box: { left_top: { x: port.x - 0.4, y: port.y - 0.4 }, right_bottom: { x: port.x + 0.4, y: port.y + 0.4 } } }
  assert.equal(itemPreservationConflict(originalProof, [operation], [{ ok: true, planned_footprint: footprint }]).reason, 'item_port_occupancy_changed')
  assert.equal(preservedProofMatches(originalProof, { ...originalProof, preserved: [] }), false)
})

function recordedWorld(lane, { residual = false, repeated = false, onRetry, initialCapture, unsupported = false } = {}) {
  const w = fixture.world()
  const native = w.game.command.bind(w.game)
  let reads = 0; let executors = 0
  const b = JSON.parse(recorded.b_reply.content)
  const obligations = lane === 'a' ? recorded.a_step.obligations : b.stepCompletions[0].obligations
  const scope = { actor_id: 18, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1 }
  const geometry = id => {
    if (lane === 'a') {
      const row = originalProof.preserved.find(row => row.entity.unit_number === id)
      return { found: true, ...row, ...scope, fluid_box_count: 0, fluid_storages_truncated: false }
    }
    const entity = { unit_number: id, name: id === 29 ? 'burner-mining-drill' : 'wooden-chest', type: id === 29 ? 'mining-drill' : unsupported ? 'logistic-container' : 'container', position: { x: id, y: 0 }, direction: 0 }
    return { found: true, entity, ...scope, fluid_box_count: 0, fluid_storages_truncated: false,
      ...(id === 29 ? { item_io: { drop_position: { x: 30, y: 0 }, drop_target: { unit_number: 30, name: 'wooden-chest', type: 'container', position: { x: 30, y: 0 }, direction: 0 } } } : {}) }
  }
  w.game.command = async text => {
    if (text.includes('evaluate_condition') && text.includes('entity_exists')) return JSON.stringify({ ok: true, exists: true, satisfied: true })
    if (text.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(text)?.[1])
      if (lane === 'b' && id === 30 && residual && (reads++ === 0 || repeated)) { await initialCapture?.(w); return 'malformed native capture reply' }
      return JSON.stringify(geometry(id))
    }
    return native(text)
  }
  w.agent.provider = answersStepContract(async (_messages, context) => {
    if (context.role === 'planner') return planReply({
      plan: [lane === 'a' ? recorded.a_step.description : b.plan[0]], currentStep: 0, operations: [],
      goal: { scope: 'finite', summary: 'Replay the original BF preservation intent.', doneWhen: [{ kind: 'inventory_count', item_name: 'coal', minimum: 3 }] },
      stepCompletions: [{ kind: 'deterministic', obligations }],
      // Only library context and outer goal are substituted; the original
      // description, outcome and preserve IDs are unchanged.
      executionGuidance: [{ approach: 'Use original BF intent and native facts.', rationale: 'Deterministic original-intent replay.', constraints: [], skillIds: [], materialSupply: null }],
    })
    executors++
    // BF supplied exact targets in its prior observations. Nonendpoint bindings
    // here are synthetic; the recorded protected belt43 identity is exact.
    if (lane === 'a') for (const op of originalOperations) w.agent.recordLiveEntityObservation({
      unit_number: op.args.unit_number, name: 'transport-belt', type: 'transport-belt', direction: 0,
      position: op.args.unit_number === 43 ? originalProof.preserved.find(row => row.entity.unit_number === 44).item_io.drop_target.position : { x: op.args.unit_number, y: 0 },
    }, undefined, 'fixture_native_target_binding')
    return planReply({ stepId: w.held().steps[0].step_id, operations: lane === 'a' ? originalOperations
      : [{ name: 'move_items_exact', args: { unit_number: 30, item_name: 'coal', max_count: 3, to_entity: false } }] })
  })
  w.game.onMutation = () => {
    w.game.inventory.coal = 3
    w.game.lastBasicResult = { operation_id: w.game.batchId, tick: 601, actor_id: 18, type: 'moving_items',
      accepted: true, completed: true, code: 'completed', target_unit_number: 30, to_entity: false, moved_count: 3 }
  }
  if (lane === 'a') w.agent.preflightOperations = async operations => operations.map(() => ({ ok: true })) // inject early miss; exact payload reaches final shared admission
  const emit = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => { await emit(row); if (row.event === 'contract.preservation_capture_retry') await onRetry?.(w) }
  return Object.assign(w, { executorCalls: () => executors })
}

test('BF A exact eleven-operation payload through real request and production admission is wholly unsent', async () => {
  const w = recordedWorld('a')
  const result = await w.start().catch(error => ({ error: error.message }))
  assert.equal(w.game.mutations.length, 0)
  assert.ok(w.rows.some(row => row.event === 'contract.item_preservation_refused' && row.data.protected_units.includes(43)), JSON.stringify({ result, rows: w.rows.slice(-15) }))
})

for (const residual of [false, true]) test(`BF B original [29,30] obligations capture, commit and ordinary native callback continue; capture miss=${residual}`, async () => {
  const w = recordedWorld('b', { residual })
  await w.start()
  assert.deepEqual(w.held().steps[0].obligations.preserve, [29, 30])
  const before = structuredClone(w.held().steps[0])
  assert.equal(w.game.mutations.length, 1)
  await w.agent.completed()
  assert.equal(w.memory.planningState(fixture.KEY).goal.status, 'completed')
  assert.deepEqual(w.held().steps[0], before)
  assert.equal(w.executorCalls(), 1)
  assert.equal(w.rows.filter(row => row.event === 'contract.preservation_capture_recovered').length, residual ? 1 : 0)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.ok(normalizeObligationProof(restored.planningState(fixture.KEY).plans[0].steps[0].obligation_proof, before.obligations))
  if (residual) assert.equal([...restored.preservationRecoveries.values()][0].state, 'verified')
})

test('unsupported container capability pauses without a Jev/model retry or dropping its preserve IDs', async () => {
  const w = recordedWorld('b', { unsupported: true })
  await assert.rejects(w.start(), error => error.code === 'preservation_type_unsupported' && !error.message.startsWith('provider_'))
  assert.equal(w.executorCalls(), 0); assert.equal(w.game.mutations.length, 0)
})

for (const [name, onRetry] of Object.entries({
  busy: w => { w.game.taskState = 'working'; w.game.queueLength = 1 },
  cancel: w => w.agent.cancel('user_stop'),
  request: w => { w.agent.requestAdmissionOwner = { replacement: true } },
  unreadable: w => { w.memory.preservationRecoveryFault = true },
})) test(`container capture recovery fences ${name} during durable retry trace`, async () => {
  const w = recordedWorld('b', { residual: true, onRetry })
  await assert.rejects(w.start())
  assert.equal(w.executorCalls(), 0); assert.equal(w.game.mutations.length, 0)
})


test('container capture residual failure is terminal and its spent claim survives restore', async () => {
  const w = recordedWorld('b', { residual: true, repeated: true })
  await assert.rejects(w.start(), /preservation_capture_recovery_failed/)
  assert.equal(w.game.mutations.length, 0)
  assert.equal(w.executorCalls(), 0)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  assert.equal(restored.preservationRecoveries.size, 1)
  assert.equal([...restored.preservationRecoveries.values()][0].state, 'claimed')
  assert.ok(w.rows.some(row => row.event === 'contract.preservation_refused' && row.data.stage === 'capture_recovery'))
})


for (const [name, initialCapture] of Object.entries({
  intake: w => { w.agent.requestAdmissionOwner = { newer: true } },
  cancel: w => w.agent.cancel('newer_stop'),
  amendment: w => { w.agent.pendingInteractionAmendment = { text: 'hold' } },
})) test(`capture recovery never adopts ${name} arriving during its initial failed read`, async () => {
  const w = recordedWorld('b', { residual: true, initialCapture })
  await assert.rejects(w.start(), /cancelled|superseded|stale/i)
  assert.equal(w.memory.preservationRecoveries?.size ?? 0, 0)
  assert.equal(w.executorCalls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('capture recovery checks the newer native status, not just the earlier idle sample', async () => {
  let samples = 0
  const w = recordedWorld('b', { residual: true, initialCapture: w => {
    const original = w.agent.readTaskStatusRaw.bind(w.agent)
    w.agent.readTaskStatusRaw = async () => {
      const raw = await original(); const status = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (++samples === 2) Object.assign(status, { task_state: 'working', queue_empty: false, queue_length: 1 })
      return JSON.stringify(status)
    }
  } })
  await assert.rejects(w.start(), /preservation_capture_recovery_native_unsettled/)
  assert.equal(w.memory.preservationRecoveries?.size ?? 0, 0)
  assert.equal(w.game.mutations.length, 0)
})


test('original BF terminal shapes and corrected residual failures reach the checker; successful retries do not', async () => {
  for (const lane of ['a', 'b']) assert.ok(analyzeBehaviorTrace(recorded.terminal_events[lane]).findings.some(row => row.signature === 'preservation_guard'), lane)
  const failed = recordedWorld('b', { residual: true, repeated: true })
  await assert.rejects(failed.start())
  assert.ok(analyzeBehaviorTrace(failed.rows).findings.some(row => row.signature === 'preservation_guard'))
  const recovered = recordedWorld('b', { residual: true })
  await recovered.start(); await recovered.agent.completed()
  assert.equal(analyzeBehaviorTrace(recovered.rows).findings.some(row => row.signature === 'preservation_guard'), false)
})

test('same-intent recapture after memory restore refuses the durable spent claim before another retry', async () => {
  const w = recordedWorld('b', { residual: true, repeated: true })
  await assert.rejects(w.start(), /preservation_capture_recovery_failed/)
  const restored = new CanonicalTaskBoardMemory(); restored.restore(w.memory.snapshot())
  const state = restored.planningState(fixture.KEY)
  // Explicit operator-resume fixture boundary; it may resume control but cannot
  // refund the earlier capture allowance. No provider or mutation is called.
  state.run.paused = false
  const legacy = restored.currentPlan(fixture.KEY); if (legacy) legacy.status = 'active'
  w.agent.memory = restored; w.agent.active = true; w.agent.epoch = await w.agent.captureEpoch()
  const obligations = JSON.parse(recorded.b_reply.content).stepCompletions[0].obligations
  await assert.rejects(capturePlannerObligationProof(w.agent, obligations, async () => {}), /preservation_capture_recovery_exhausted/)
  assert.equal(restored.preservationRecoveries.size, 1)
  assert.equal(w.game.mutations.length, 0)
})
