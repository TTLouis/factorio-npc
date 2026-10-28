import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { compileObligations, normalizeObligations, contractDefectShape, outcomeOnlyCheckpoint, preservationGeometry, obligationProofOrigin, obligationSignature, effectivePreservationProof, preservedProofMatches } from './contract-obligations.mjs'
import { recoverContractObligations } from './contract-obligation-runtime.mjs'
import { getActivePlan, PLANNING_EVENT } from './planning-state.mjs'
import { configuration, Session, recoverInterruptedAgentPlan } from './supervisor.mjs'
import { recoverySession, settle, fireResumeTimer } from './recovery-loop-fixtures.mjs'
import { analyzeBehaviorTrace } from './run-check.mjs'
import { answersStepContract, FakeFactorio, inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const recorded = JSON.parse(readFileSync(new URL('./fixtures/run-av-contract-drift.json', import.meta.url)))
const correctedReply = JSON.parse(recorded.exact_assistant_replies.tap_63.content)
const KEY = 'npc:obligation-fixture'
const typed = normalizeObligations({ outcome: { mode: 'all', requirements: [
  { kind: 'entity_count', prototype: 'stone-furnace', minimum: 1, anchor: { x: 46, y: 14 }, radius: 8 },
  { kind: 'authoritative_operation_receipt', operation_name: 'place_entity' },
] }, preserve: [21, 22] })
const expected = compileObligations(typed)
const description = recorded.active_plan.steps[1].description
const nextDescription = recorded.active_plan.steps[2].description
function geometry(id) {
  const entity = { unit_number: id, name: id === 21 ? 'burner-mining-drill' : 'stone-furnace',
    type: id === 21 ? 'mining-drill' : 'furnace', position: { x: id === 21 ? 47 : 46, y: id === 21 ? 16 : id === 22 ? 14 : 12 }, direction: 0 }
  return { found: true, entity, actor_id: 18, actor_surface_index: 1, actor_force_index: 1, surface_index: 1, force_index: 1, fluid_box_count: 0, fluid_storages_truncated: false,
    ...(id === 21 ? { item_io: { drop_position: { x: 46.5, y: 14.703125 }, drop_target: geometry(22).entity } } : {}) }
}
function world({ required = false, onRead, onTrace, firstIntent = typed, legacy = false, bootstrapFuel = false } = {}) {
  const initialDescription = bootstrapFuel ? 'Fuel the existing iron drill with one coal while preserving its cell.' : description
  if (bootstrapFuel) firstIntent = normalizeObligations({ outcome: { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name: 'supply_entity' }] }, preserve: [21, 22] })
  const memory = new CanonicalTaskBoardMemory()
  // Scripted native preflight: a coordinate place_entity reports its planned footprint centre, as the mod does (the fixture's
  // coordinates are already on the grid, so the snapped centre is the requested one).
  const preflight = text => {
    const x = Number(/\['x'\]=(-?[\d.]+)/.exec(text)?.[1]); const y = Number(/\['y'\]=(-?[\d.]+)/.exec(text)?.[1])
    const name = /\['entity_name'\]='([^']+)'/.exec(text)?.[1]
    return /["']place_entity["']/.test(text) && name && Number.isFinite(x) && Number.isFinite(y) ? { ok: true, planned_footprint: { entity_name: name, position: { x, y }, direction: 0 } } : { ok: true }
  }
  const game = new FakeFactorio({ inventory: { 'stone-furnace': 1, 'copper-plate': 10, 'iron-plate': 58, ...(bootstrapFuel ? { coal: 1 } : {}) }, preflight })
  game.status.connected_players = 0
  const native = game.command.bind(game)
  const rows = []
  const calls = []
  let agent
  game.command = async text => {
    await onRead?.({ text, game, agent, memory })
    if (text.includes('remote.call("autorio_operations","status")')) {
      const status = JSON.parse(await native(text))
      if (status.last_completed_batch) {
        Object.assign(status.last_completed_batch, { batch_generation: 1, batch_ref: `batch-g1-${game.batchId}` })
        status.receipt_journal = [{ ...status.last_completed_batch, state: 'completed' }]
      }
      return JSON.stringify(status)
    }
    if (text.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(text)?.[1] ?? /unit_number[=: ]+(\d+)/.exec(text)?.[1])
      const result = geometry(id)
      if (bootstrapFuel && id === 21 && !game.routeReady) delete result.item_io.drop_target
      return JSON.stringify(result)
    }
    if (text.includes('get_entity_status')) return JSON.stringify({ found: true, entity: geometry(23).entity })
    if (text.includes('remote.call("autorio_crafting","status")')) return JSON.stringify({ task_active: false, native_queue: [] })
    if (text.includes('evaluate_condition')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(text)?.[1]
      const request = encoded ? JSON.parse(encoded.replace(/\\(.)/g, '$1')) : {}
      if (request.kind === 'entity_count') {
        const current = request.prototype === 'stone-furnace' ? (game.batchId > 0 ? 2 : 1) : 1
        return JSON.stringify({ ok: true, kind: 'entity_count', prototype: request.prototype, current, satisfied: current >= request.minimum, truncated: false, found: current })
      }
      if (request.kind === 'entity_exists') return JSON.stringify({ ok: true, exists: [21, 22, 23].includes(request.unit_number), satisfied: [21, 22, 23].includes(request.unit_number) })
    }
    return native(text)
  }
  game.onMutation = text => {
    if (text.includes("'place_entity'")) {
      game.inventory['stone-furnace'] = 0
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18,
        type: 'placing', accepted: true, completed: true, code: 'completed', entity_name: 'stone-furnace',
        placed_unit_number: 23, placed_entity_type: 'furnace', placed_position: { x: 46, y: 12 }, placed_surface_index: 1, placed_direction: 0 }
    }
    if (bootstrapFuel && text.includes("'supply_entity'")) {
      game.fuelled = true
      game.inventory.coal = 0
      game.lastBasicResult = { operation_id: game.batchId, tick: 600 + game.batchId, actor_id: 18, type: 'moving_items',
        accepted: true, completed: true, code: 'completed', moved_count: 1, target_unit_number: 21, to_entity: true }
    }
  }
  agent = new NpcAgentLoop({ rcon: game, memory, npcId: 'obligation-fixture', completionProtocolVersion: 3,
    replacementWake: true, requireTypedObligations: required, stateFile: null, traceFile: null, decisionTraceFile: null,
    systemPrompt: 'Run AV typed obligation lifecycle fixture; scripted providers only.',
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    provider: answersStepContract(async (_messages, context) => {
      calls.push(context.role)
      const heldBefore = getActivePlan(memory.planningState(KEY))
      if (legacy && context.role === 'planner' && ['COMMITTED', 'EXECUTING'].includes(heldBefore?.status)) return planReply({
        chatMessage: 'BLOCKED: The recorded extra global counts do not describe the completed intended placement.',
        plan: [description, nextDescription], currentStep: 0, operations: [] })
      if (context.role === 'planner') return planReply({ plan: [initialDescription, nextDescription], currentStep: 0, operations: [],
        goal: { scope: 'long_horizon', summary: recorded.goal, doneWhen: [{ kind: 'production_rate', item_name: 'automation-science-pack', per_minute: 1, window_minutes: 1 }] },
        roadmap: [{ id: 'science-unlock', intent: 'Unlock science without changing the goal.' }],
        stepCompletions: [{ kind: 'deterministic', checkpoint: legacy ? correctedReply.checkpoint : compileObligations(firstIntent), ...(!legacy ? { obligations: firstIntent } : {}) },
          { kind: 'deterministic', checkpoint: inventoryCheckpoint('copper-plate', 15),
            ...(!legacy ? { obligations: { outcome: inventoryCheckpoint('copper-plate', 15), preserve: [] } } : {}) }],
        executionGuidance: [initialDescription, nextDescription].map(approach => ({ approach, rationale: 'Preserve the original semantic step.', constraints: [], skillIds: [], materialSupply: null })) })
      const held = getActivePlan(memory.planningState(KEY))
      if (legacy && (memory.autoResumeAllowance(KEY).step_attempts ?? 0) >= 2) return planReply({ stepId: held.steps[held.active_step_index].step_id,
        operations: [], plannerReview: { reason: 'scope_change', rationale: 'The frozen checkpoint adds the recorded three-furnace/two-drill requirements after the intended placement already completed.' } })
      if (held.steps[held.active_step_index].description === initialDescription) return planReply({ stepId: held.steps[held.active_step_index].step_id,
        operations: bootstrapFuel ? [{ name: 'supply_entity', args: { unit_number: 21, items: [{ item_name: 'coal', count: 1 }] } }]
          : [{ name: 'place_entity', args: { entity_name: 'stone-furnace', x: 46, y: 12 } }] })
      agent.recordLiveEntityObservation(geometry(23).entity, undefined, 'fixture_fresh_native_read')
      return planReply({ stepId: held.steps[held.active_step_index].step_id,
        operations: [{ name: 'supply_entity', args: { unit_number: 23, items: [{ item_name: 'copper-ore', count: 5 }, { item_name: 'coal', count: 1 }] } }] })
    }) })
  agent.behaviorTrace = { emit: async row => { rows.push(row); await onTrace?.({ row, agent, game, memory }) } }
  return { agent, game, memory, rows, calls, held: () => getActivePlan(memory.planningState(KEY)),
    start: () => agent.request(recorded.goal, { sender: 'Louis' }) }
}
function injectResidual(w) {
  // Explicit fixture substitution: unlike historical AV, this plan committed
  // valid frozen typed intent and native provenance before an injected miss.
  const plan = w.held()
  const bad = structuredClone(plan.steps[0])
  bad.completion_contract = correctedReply.checkpoint
  w.memory.planningByNpc.set(KEY, { ...w.memory.planningState(KEY), plans: [
    ...w.memory.planningState(KEY).plans.filter(row => row.plan_id !== plan.plan_id),
    { ...plan, steps: [bad, ...plan.steps.slice(1)] },
  ] })
  w.memory.syncPlanningState(KEY)
  return structuredClone(w.held())
}

test('AV exact original reply has the additional global counts and keeps its semantic placement scope', () => {
  assert.equal(recorded.source_sha, '11d182c1aa8650c9254a58ee8dc4bfc3fe7b936a')
  assert.deepEqual(correctedReply.checkpoint.requirements.filter(row => row.kind === 'entity_count' && !row.anchor)
    .map(row => [row.prototype, row.minimum]), [['stone-furnace', 3], ['burner-mining-drill', 2]])
  assert.equal(recorded.terminal_evidence.exhaustion_event.data.step_attempts, 2)
})

test('shared validator rejects the exact AV corrected checkpoint against frozen typed intent; future declared global counts remain valid', async () => {
  const w = world()
  await w.start()
  const step = w.held().steps[0]
  assert.equal((await w.agent.validatePlannerCheckpointContract(correctedReply.checkpoint, [], { plannerOnlyDraft: true, step })).reason, 'contract_obligation_mismatch')
  const global = normalizeObligations({ outcome: { mode: 'all', requirements: [{ kind: 'entity_count', prototype: 'stone-furnace', minimum: 3 }] }, preserve: [] })
  const future = world({ firstIntent: global })
  await future.start()
  assert.equal((await future.agent.validatePlannerCheckpointContract(compileObligations(global), [], { plannerOnlyDraft: true, step: future.held().steps[0] })).accepted, true)
})

test('only a checkpoint restating exactly the declared outcome counts as the harness-compiled preserving contract', () => {
  const outcome = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'burner-inserter', minimum: 1 }] }
  const intent = { outcome, preserve: [22, 23] }
  assert.equal(outcomeOnlyCheckpoint(structuredClone(outcome), intent), true)
  assert.equal(outcomeOnlyCheckpoint(structuredClone(outcome), { outcome, preserve: [] }), false)
  assert.equal(outcomeOnlyCheckpoint({ ...outcome, mode: 'any' }, intent), false)
  assert.equal(outcomeOnlyCheckpoint({ mode: 'all', requirements: [{ ...outcome.requirements[0], minimum: 2 }] }, intent), false)
  assert.equal(outcomeOnlyCheckpoint({ mode: 'all', requirements: [...outcome.requirements, { kind: 'entity_exists', unit_number: 22 }] }, intent), false)
  // The AV global-count translation stays a mismatch.
  assert.equal(outcomeOnlyCheckpoint(correctedReply.checkpoint, typed), false)
  assert.equal(outcomeOnlyCheckpoint(structuredClone(typed.outcome), typed), true)
})

test('residual count-translation miss runs real completion -> one successor -> next original semantic step, with one placement only', async () => {
  const w = world({ required: true })
  const { session, logs } = recoverySession(w, { actorId: 18, epoch: 3 })
  session.npcId = 'obligation-fixture'
  await w.start()
  assert.equal(w.game.mutations.length, 1)
  const before = injectResidual(w)
  assert.equal(contractDefectShape(before.steps[0]), true)
  session.onGameLine('[AUTORIO] All operations completed')
  await settle(session)
  assert.equal(w.held().plan_version, 2, JSON.stringify({events:w.rows.filter(row => /contract\.defect/.test(row.event)),evidence:w.memory.currentPlan(KEY).task_board.evidence}))
  assert.equal(w.held().steps[w.held().active_step_index].description, nextDescription)
  assert.equal(w.game.mutations.filter(text => text.includes("'place_entity'")).length, 1)
  assert.ok(w.game.mutations.at(-1).includes("'supply_entity'"), 'normal next-step operation is automatically admitted')
  const old = w.memory.planningState(KEY).plans.find(row => row.plan_id === before.plan_id)
  assert.deepEqual(old.steps, before.steps, 'historical committed contracts and semantic steps are unchanged')
  assert.equal(w.memory.planningState(KEY).goal.replacements_accepted, 1)
  assert.deepEqual(w.memory.planningState(KEY).goal.contract_defect_claims, [before.steps[0].semantic_step_id])
  assert.ok(w.rows.some(row => row.event === 'contract.defect_continued'))
  assert.equal(w.memory.planningState(KEY).goal.objective, recorded.goal)
  assert.deepEqual(logs.filter(row => /listener failed|follow-up failed/.test(row)), [])
})

for (const variant of ['missing_receipt', 'busy', 'pending', 'preservation_changed', 'revoked', 'limit', 'legacy']) {
  test(`residual certificate refuses ${variant} without extra world work`, async () => {
    const w = world()
    await w.start()
    injectResidual(w)
    // Capture the real completed receipt without asking the executor again.
    await w.agent.routeStepCompletionDecision(await w.agent.taskStatusReceipt())
    if (variant === 'missing_receipt') w.memory.currentPlan(KEY).task_board.evidence = []
    if (variant === 'busy') w.game.queueLength = 1
    if (variant === 'pending') w.agent.batchInFlight = true
    if (variant === 'preservation_changed') {
      const native = w.game.command.bind(w.game)
      w.game.command = text => text.includes('entity_geometry') ? JSON.stringify({ found: false }) : native(text)
    }
    if (variant === 'revoked') w.memory.revokeAuthorization(KEY, w.memory.currentGoalGrant(KEY).grant_id)
    if (variant === 'limit') w.memory.planningState(KEY).goal.contract_defect_claims = [w.held().steps[0].semantic_step_id]
    if (variant === 'legacy') {
      const step = w.held().steps[0]
      delete step.obligation_proof
    }
    const result = await recoverContractObligations(w.agent)
    assert.equal(result.goalStatus, 'paused')
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.memory.planningState(KEY).goal.replacements_accepted ?? 0, 0)
    assert.ok(w.rows.some(row => /^contract.defect_(?:refused|exhausted)$/.test(row.event)))
    const reason = w.rows.find(row => /^contract.defect_(?:refused|exhausted)$/.test(row.event)).data.reason
    assert.match(reason, { missing_receipt: /^same_step_completed_placement_receipt_required$/, busy: /^native_busy$/,
      pending: /^operation_unsettled$/, preservation_changed: /^native_proof_unreadable:/,
      revoked: /^current_recovery_grant_required$/, limit: /^semantic_step_limit_exhausted$/, legacy: /^provenance_unproven$/ }[variant])
  })
}

test('production Session rejects missing declarations on a restored legacy DRAFT without changing readable legacy state', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'obligation-production-'))
  await fsp.mkdir(path.join(root, 'src'))
  await fsp.writeFile(path.join(root, 'src', 'prompt.md'), 'Scripted production policy fixture.')
  const game = new FakeFactorio()
  game.status.connected_players = 0
  const session = new Session({ root, app: root, game: root, save: 'fixture', settingsFile: 'fixture', modDir: 'fixture', ini: 'fixture',
    rcon: { port: 12346, password: 'fixture' }, log: () => {}, provider: async () => { throw new Error('provider forbidden') },
    config: configuration({}, { SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-key-not-a-real-credential', OPENAI_MODEL: 'fixture-model' }) })
  session.startGameProcess = async () => { session.rcon = game }
  session.bindNpc = async () => { session.lastStatus = game.status }
  session.syncTaskBoardUi = async () => {}
  session.drainTaskBoardUiInputs = () => {}
  session.queueStartupRecovery = () => {}
  try {
    await session.start()
    const agent = session.agent
    assert.equal(agent.requireTypedObligations, true)
    const legacy = world()
    await legacy.start()
    const held = legacy.held()
    const planning = legacy.memory.planningState(KEY)
    legacy.memory.planningByNpc.set(KEY, { ...planning, plans: [{ ...held, status: 'DRAFT',
      steps: held.steps.map(({ completion_mode: _mode, ...kept }) => kept) }] })
    agent.memory = legacy.memory
    agent.requestInfo = { memoryKey: KEY, sender: 'Louis', text: recorded.goal, origin: 'chat' }
    const before = agent.memory.snapshot()
    assert.equal(getActivePlan(agent.memory.planningState(KEY)).status, 'DRAFT')
    await assert.rejects(agent.validateStepCompletionDeclarations({ plan: [description, nextDescription], currentStep: 0, operations: [] }), error => error.code === 'missing_step_completions')
    await assert.rejects(agent.validateStepCompletionDeclarations({ plan: [description, nextDescription], currentStep: 0, operations: [],
      stepCompletions: [{ kind: 'deterministic', checkpoint: expected }, { kind: 'deterministic' }] }), error => error.code === 'missing_step_obligations')
    assert.deepEqual(agent.memory.snapshot(), before)
    assert.equal(game.mutations.length, 0)
  } finally {
    session.stopping = true
    for (const timer of [session.poll, session.uiHeartbeat, session.uiInputPoll]) clearInterval(timer)
    session.agent?.cancel('fixture_cleanup')
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('ordinary completed receipt cannot close a typed step after preserved drill routing changes, even when every predicate is true', async () => {
  const w = world()
  await w.start()
  const native = w.game.command.bind(w.game)
  w.game.command = async text => {
    const raw = await native(text)
    if (!text.includes('entity_geometry')) return raw
    const result = JSON.parse(raw)
    if (result.entity.unit_number === 21) { result.entity.direction = 2; result.item_io.drop_target = geometry(23).entity }
    return JSON.stringify(result)
  }
  const result = await w.agent.completed()
  assert.equal(result.goalStatus, 'paused')
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.rows.some(row => row.event === 'contract.preservation_close_refused' && row.data.reason === 'preservation_baseline_changed'))
})

for (const corrupt of ['goal', 'plan', 'version', 'step', 'semantic', 'item_io', 'scope', 'obligations_removed']) {
  test(`restore refuses copied or corrupt ${corrupt} provenance`, async () => {
    const w = world()
    await w.start()
    const snapshot = w.memory.snapshot()
    const state = snapshot.planning_states.find(row => row.key === KEY).state
    const held = state.plans.find(row => row.plan_id === state.active_plan_id)
    const step = held.steps[0]
    if (corrupt === 'goal') step.obligation_proof.binding.goal_id = 'another-goal'
    if (corrupt === 'plan') step.obligation_proof.binding.plan_id = `${state.goal.goal_id}_p999`
    if (corrupt === 'version') step.obligation_proof.binding.plan_version++
    if (corrupt === 'step') step.obligation_proof.binding.step_id = 'another-step'
    if (corrupt === 'semantic') step.semantic_step_id = held.steps[1].step_id
    if (corrupt === 'item_io') step.obligation_proof.preserved[0].item_io.drop_position = { x: 'unknown', y: 1 }
    if (corrupt === 'scope') step.obligation_proof.preserved[0].force_index = 'unknown'
    if (corrupt === 'obligations_removed') delete step.obligations
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(snapshot)
    const restoredStep = getActivePlan(restored.planningState(KEY)).steps[0]
    assert.equal(restoredStep.obligation_protocol, 1)
    assert.equal(obligationProofOrigin(restored.planningState(KEY), restoredStep), false)
  })
}

for (const unsupported of ['transport-belt', 'underground-belt', 'splitter', 'electric-pole', 'assembling-machine']) {
  test(`preservation fails closed for unsupported ${unsupported} mechanics`, () => {
    const raw = geometry(22)
    raw.entity.type = unsupported
    assert.throws(() => preservationGeometry(raw, 22), /preservation_type_unsupported/)
  })
}

test('exact legacy AV checkpoint reproduces native-success/count-failure and both bounded supervisor resumes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Fixture starts at the already-bound checkpoint, omitting the earlier
  // bootstrap/native history. Exact taps 62/63 and the final original plan are
  // retained separately. No typed authority is added to this legacy control.
  const w = world({ legacy: true })
  const ctx = recoverySession(w, { actorId: 18, epoch: 3 })
  ctx.t = t
  ctx.session.npcId = 'obligation-fixture'
  t.after(() => { if (ctx.session.modelResume?.timer) clearTimeout(ctx.session.modelResume.timer) })
  await w.start()
  w.game.preflight = text => text.includes('place_entity')
    ? { ok: false, code: 'placement_item_missing', refusal_class: 'world', placement_item: { entity_name: 'stone-furnace', count: 1, held_count: 0 } }
    : { ok: true }
  ctx.session.onGameLine('[AUTORIO] All operations completed')
  await settle(ctx.session)
  await fireResumeTimer(ctx)
  await fireResumeTimer(ctx)
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.held().active_step_index, 0)
  assert.equal(w.rows.filter(row => row.event === 'recovery.auto_resume_started').length, 2)
  const exhausted = w.rows.filter(row => row.event === 'recovery.auto_resume_exhausted')
  assert.equal(exhausted.length, 1, JSON.stringify(w.rows.filter(row => /auto_resume|goal.paused|request.failed/.test(row.event))))
  assert.equal(exhausted[0].data.step_attempts, 2)
  assert.equal(w.rows.some(row => row.event === 'contract.defect_corrected'), false, 'legacy facts cannot mint a certificate')
  const checked = w.rows.find(row => row.event === 'step.completion_checked' && row.data.contract?.requirements?.some(row => row.minimum === 3))
  assert.ok(checked.data.evidence.find(row => row.kind === 'authoritative_operation_receipt').satisfied)
  assert.ok(checked.data.evidence.filter(row => row.kind === 'entity_count').slice(1).every(row => !row.satisfied))
  assert.ok(analyzeBehaviorTrace([recorded.terminal_evidence.exhaustion_event]).findings.some(row => row.signature === 'auto_resume_exhausted'))
})

for (const phase of ['native_read', 'defect_trace', 'claim_flush']) {
  test(`request replacement during ${phase} cannot pause/clear/charge or commit for its heir`, async () => {
    let armed = false
    let changed = false
    const replace = agent => { if (armed && !changed) { changed = true; agent.traceRequest = { id: 'replacement-owner', usage: {} } } }
    const w = world({ onRead: ({ text, agent }) => { if (phase === 'native_read' && text.includes('entity_geometry')) replace(agent) },
      onTrace: ({ row, agent }) => { if (phase === 'defect_trace' && row.event === 'contract.defect_detected') replace(agent) } })
    await w.start()
    injectResidual(w)
    await w.agent.taskStatusReceipt()
    const persist = w.agent.persistState.bind(w.agent)
    if (phase === 'claim_flush') w.agent.persistState = async options => { await persist(options); if (w.held().blocker?.kind === 'contract_defect') replace(w.agent) }
    armed = true
    await assert.rejects(recoverContractObligations(w.agent), /cancelled|superseded/i)
    assert.equal(changed, true)
    assert.equal(w.agent.traceRequest.id, 'replacement-owner')
    assert.deepEqual(w.agent.traceRequest.usage, {})
    assert.equal(w.memory.planningState(KEY).goal.replacements_accepted ?? 0, 0)
    assert.equal(w.game.mutations.length, 1)
  })
}

for (const change of ['actor', 'epoch', 'goal', 'version', 'cancel', 'amendment', 'native_busy']) {
  test(`a ${change} change during certificate trace prevents successor commitment`, async () => {
    let armed = false
    const w = world({ onTrace: ({ row, agent, memory, game }) => {
      if (!armed || row.event !== 'contract.defect_detected') return
      armed = false
      if (change === 'actor') game.status.actor_id++
      if (change === 'epoch') game.status.epoch++
      if (change === 'goal') memory.planningState(KEY).goal.goal_id = 'replacement-goal'
      if (change === 'version') getActivePlan(memory.planningState(KEY)).plan_version++
      if (change === 'cancel') agent.cancel('user_stop')
      if (change === 'amendment') agent.currentPendingAmendment = () => ({ text: 'New owner direction' })
      if (change === 'native_busy') game.queueLength = 1
    } })
    await w.start()
    injectResidual(w)
    await w.agent.taskStatusReceipt()
    armed = true
    if (['amendment', 'native_busy'].includes(change)) assert.equal((await recoverContractObligations(w.agent)).goalStatus, 'paused')
    else await assert.rejects(recoverContractObligations(w.agent), /cancelled|superseded|epoch|actor/i)
    assert.equal(w.memory.planningState(KEY).goal.replacements_accepted ?? 0, 0)
    assert.equal(w.game.mutations.length, 1)
  })
}

async function crashSnapshot(phase) {
  const w = world()
  await w.start()
  injectResidual(w)
  await w.agent.taskStatusReceipt()
  const persist = w.agent.persistState.bind(w.agent)
  let snapshot
  w.agent.persistState = async options => {
    await persist(options)
    const held = w.held()
    const atPhase = phase === 'claim' ? held.blocker?.kind === 'contract_defect'
      : held.plan_version === 2 && held.status === (phase === 'draft' ? 'DRAFT' : 'COMMITTED')
    if (atPhase) { snapshot = w.memory.snapshot(); throw new Error(`fixture_crash_${phase}`) }
  }
  await assert.rejects(recoverContractObligations(w.agent), new RegExp(`fixture_crash_${phase}`))
  assert.ok(snapshot, 'the actual strict persistence seam was reached')
  w.agent.persistState = persist
  return { w, snapshot }
}

for (const drift of ['none', 'outcome', 'guidance', 'future_contract', 'future_intent', 'proof', 'certificate', 'lineage']) {
  test(`restored successor DRAFT commit revalidates immutable predecessor: ${drift}`, async () => {
    const { w, snapshot } = await crashSnapshot('draft')
    const state = snapshot.planning_states.find(row => row.key === KEY).state
    const draft = state.plans.find(row => row.plan_id === state.active_plan_id)
    if (drift === 'outcome') {
      draft.steps[0].obligations.outcome.requirements[0].minimum = 2
      draft.steps[0].completion_contract = compileObligations(draft.steps[0].obligations)
      draft.steps[0].obligation_proof.intent_signature = obligationSignature(draft.steps[0].obligations)
    }
    if (drift === 'guidance') draft.steps[0].execution_guidance.constraints = ['Dismantle the iron cell.']
    if (drift === 'future_contract') { draft.steps[1].completion_contract = inventoryCheckpoint('copper-plate', 1); draft.steps[1].contract_status = 'bound' }
    if (drift === 'future_intent') draft.steps[1].obligations.outcome = inventoryCheckpoint('copper-plate', 1)
    if (drift === 'proof') draft.steps[0].obligation_proof.binding.plan_version++
    if (drift === 'certificate') delete draft.replacement.reason
    if (drift === 'lineage') { delete draft.replacement; delete draft.derived_from_plan_id }
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(snapshot)
    restored.dispatchPlanningEvent(KEY, { type: PLANNING_EVENT.PLAN_COMMITTED, source: 'runtime', now: Date.now(),
      plan_id: draft.plan_id, runtime_validation: { passed: true }, grant_check: { actor_id: 18, actor_epoch: 3 } })
    assert.equal(getActivePlan(restored.planningState(KEY)).status === 'COMMITTED', drift === 'none')
    assert.equal(restored.planningState(KEY).goal.replacements_accepted, 1)
    assert.equal(restored.planningState(KEY).goal.contract_defect_claims.length, 1)
    assert.equal(w.game.mutations.length, 1)
  })
}

for (const phase of ['claim', 'draft']) {
  test(`restart after persisted ${phase} keeps claim spent and classifies a visible pause before any model call`, async () => {
    const { w, snapshot } = await crashSnapshot(phase)
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(snapshot)
    w.agent.memory = restored
    const calls = w.calls.length
    const result = await recoverInterruptedAgentPlan(w.agent, 'runtime_restart', {}, { requestId: `restart-after-${phase}` })
    assert.equal(result.reason, 'contract_defect_claim_exhausted')
    assert.equal(result.paused, true)
    assert.equal(restored.planningState(KEY).goal.contract_defect_claims.length, 1)
    assert.equal(w.calls.length, calls)
    assert.equal(w.game.mutations.length, 1)
    assert.ok(w.rows.some(row => row.event === 'contract.defect_exhausted'))
  })
}

test('a second residual miss on the same semantic step cannot renew its allowance after successor ID and snapshot restore', async () => {
  const { w, snapshot } = await crashSnapshot('commit')
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  w.agent.memory = restored
  const active = getActivePlan(restored.planningState(KEY))
  const bad = { ...structuredClone(active.steps[0]), completion_contract: correctedReply.checkpoint }
  restored.planningByNpc.set(KEY, { ...restored.planningState(KEY), plans: restored.planningState(KEY).plans.map(row => row.plan_id === active.plan_id
    ? { ...active, steps: [bad, ...active.steps.slice(1)] } : row) })
  restored.syncPlanningState(KEY)
  const result = await recoverContractObligations(w.agent)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(restored.planningState(KEY).goal.replacements_accepted, 1)
  assert.equal(restored.planningState(KEY).goal.contract_defect_claims.length, 1)
  assert.equal(w.game.mutations.length, 1)
  const exhausted = w.rows.find(row => row.event === 'contract.defect_exhausted')
  assert.equal(exhausted.data.reason, 'semantic_step_limit_exhausted')
  assert.ok(analyzeBehaviorTrace(w.rows).findings.some(row => row.signature === 'contract_defect_exhausted'))
})

test('unresolved native target does not block a needed first fuel action or pretend the cell is connected', async () => {
  const w = world({ bootstrapFuel: true, required: true })
  await w.start()
  const baseline = structuredClone(w.held().steps[0].obligation_proof)
  assert.equal(baseline.preserved[0].item_io.drop_target, null)
  assert.equal(w.game.fuelled, true, 'the actual loop admitted the bounded first fuel action before output/target resolution')
  assert.equal(w.game.mutations.length, 1)
  assert.ok(w.game.mutations[0].includes("'supply_entity'"))
  const completion = await w.agent.routeStepCompletionDecision(await w.agent.taskStatusReceipt())
  assert.equal(completion.verified, true, JSON.stringify(completion))
  assert.equal(w.held().active_step_index, 1)
  assert.deepEqual(w.held().steps[0].obligation_proof, baseline)
  assert.equal(w.rows.some(row => row.event === 'contract.defect_corrected'), false)
})

test('native target resolution is monotonic, durable, and restricted to unchanged already-preserved identities', async () => {
  const w = world({ bootstrapFuel: true })
  await w.start()
  await w.agent.taskStatusReceipt()
  const baseline = structuredClone(w.held().steps[0].obligation_proof)
  w.game.routeReady = true
  assert.equal(await recoverContractObligations(w.agent), undefined)
  const resolved = effectivePreservationProof(w.held(), w.held().steps[0])
  assert.equal(resolved.preserved[0].item_io.drop_target.unit_number, 22)
  assert.deepEqual(w.held().steps[0].obligation_proof, baseline, 'frozen baseline remains unchanged')
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  w.agent.memory = restored
  const held = getActivePlan(restored.planningState(KEY))
  assert.equal(effectivePreservationProof(held, held.steps[0]).preserved[0].item_io.drop_target.unit_number, 22)
  w.game.routeReady = false
  assert.equal((await recoverContractObligations(w.agent)).goalStatus, 'paused', 'a known target cannot disappear after restore')
  assert.equal(w.game.mutations.length, 1)
  assert.equal(getActivePlan(restored.planningState(KEY)).active_step_index, 0)
})

for (const variant of ['placed_surface', 'placed_force', 'crafting_busy', 'unresolved_route']) {
  test(`residual certificate refuses native boundary ${variant}`, async () => {
    const w = world()
    await w.start()
    await w.agent.taskStatusReceipt()
    injectResidual(w)
    const native = w.game.command.bind(w.game)
    w.game.command = async text => {
      const raw = await native(text)
      if (variant === 'crafting_busy' && text.includes('autorio_crafting')) return JSON.stringify({ task_active: true, native_queue: [{ count: 1 }] })
      if (!text.includes('entity_geometry')) return raw
      const row = JSON.parse(raw)
      if (row.entity.unit_number === 23 && variant === 'placed_surface') row.surface_index = row.actor_surface_index = 2
      if (row.entity.unit_number === 23 && variant === 'placed_force') row.force_index = row.actor_force_index = 2
      if (row.entity.unit_number === 21 && variant === 'unresolved_route') delete row.item_io.drop_target
      return JSON.stringify(row)
    }
    if (variant === 'unresolved_route') {
      // Future typed fixture starts with advisory unknown; historical AV is not recertified.
      const step = w.held().steps[0]
      step.obligation_proof.preserved[0].item_io.drop_target = null
    }
    const result = await recoverContractObligations(w.agent)
    assert.equal(result.goalStatus, 'paused')
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.memory.planningState(KEY).goal.replacements_accepted ?? 0, 0)
    const refusal = w.rows.find(row => row.event === 'contract.defect_refused')
    assert.equal(refusal.data.reason, { placed_surface: 'placed_identity_mismatch', placed_force: 'placed_identity_mismatch',
      crafting_busy: 'native_busy', unresolved_route: 'preservation_route_unresolved' }[variant])
  })
}

test('unknown target cannot resolve to an identity outside frozen preservation membership', async () => {
  const w = world({ bootstrapFuel: true })
  await w.start()
  const before = w.held().steps[0].obligation_proof
  const after = structuredClone(before)
  after.preserved[0].item_io.drop_target = geometry(23).entity
  assert.equal(preservedProofMatches(before, after), false)
  after.preserved[0].item_io.drop_target = geometry(22).entity
  assert.equal(preservedProofMatches(before, after), true)
  after.preserved[1].surface_index = 2
  assert.equal(preservedProofMatches(before, after), false)
})

for (const seam of ['persist', 'trace', 'final_owner']) {
  test(`ordinary receipt close defers a same-owner amendment during ${seam} without consuming it`, async () => {
    let armed = false
    let fired = false
    const amendment = { sender: 'Louis', text: 'Hold the copper step for new owner direction.' }
    const stage = agent => {
      fired = true
      agent.pendingInteractionAmendment = amendment
      agent.pendingAmendmentConversationSeq = agent.agentContext.conversationSeq
    }
    const w = world({ bootstrapFuel: true, onTrace: async ({ row, agent }) => {
      if (armed && seam === 'trace' && row.event === 'contract.preservation_resolved') { stage(agent); await Promise.resolve() }
    } })
    await w.start()
    const owner = w.agent.captureCheckpointOwner()
    const calls = w.calls.length
    const receipt = await w.agent.taskStatusReceipt()
    w.game.routeReady = true
    const persist = w.agent.persistState.bind(w.agent)
    w.agent.persistState = async options => {
      await persist(options)
      if (armed && !fired && seam === 'persist' && options?.strict && w.held().execution.preservation_proofs) stage(w.agent)
    }
    const assertOwner = w.agent.assertCheckpointOwnerCurrent.bind(w.agent)
    w.agent.assertCheckpointOwnerCurrent = async (...args) => {
      const caller = new Error('capture checkpoint caller').stack.split('\n')[2]
      await assertOwner(...args)
      if (armed && !fired && seam === 'final_owner' && caller.includes('NpcAgentLoop.applyStepClose')) stage(w.agent)
    }
    armed = true
    // The ordinary real completion path owns this receipt; no residual defect is injected.
    const result = await w.agent.completed()
    assert.equal(fired, true, 'the intended late-await seam was exercised')
    assert.equal(w.agent.checkpointOwnerCurrent(owner), true, 'amendment alone does not change checkpoint owner')
    assert.equal(result.deferred, 'pending_amendment')
    assert.equal(result.goalStatus, 'active', 'deferral does not cancel or pause the held amendment request')
    assert.strictEqual(w.agent.currentPendingAmendment(), amendment)
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.calls.length, calls)
    assert.equal(w.rows.some(row => row.event === 'step.verified'), false)
    assert.ok(w.rows.some(row => row.event === 'step.close_deferred' && row.data.reason === 'pending_amendment'))
    assert.ok(receipt.taskBoard.evidence.some(row => row.kind === 'deterministic_verification'))
  })
}

for (const change of ['native_busy', 'pending', 'batch']) {
  test(`ordinary receipt close refreshes ${change} safety after durable native refinement`, async () => {
    let armed = false
    let fired = false
    const w = world({ bootstrapFuel: true, onTrace: ({ row, agent, game, memory }) => {
      if (!armed || row.event !== 'contract.preservation_resolved') return
      fired = true
      if (change === 'native_busy') game.queueLength = 1
      if (change === 'batch') agent.batchInFlight = true
      if (change === 'pending') memory.pendingOperation = () => ({ operation_key: 'new-outstanding-operation' })
    } })
    await w.start()
    const calls = w.calls.length
    await w.agent.taskStatusReceipt()
    w.game.routeReady = true
    armed = true
    const result = await w.agent.completed()
    assert.equal(fired, true)
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.calls.length, calls)
    assert.equal(w.rows.some(row => row.event === 'step.verified'), false)
    if (change === 'native_busy') {
      assert.equal(result.goalStatus, 'paused')
      assert.ok(w.rows.some(row => row.event === 'contract.preservation_close_refused' && row.data.reason === 'preservation_native_not_idle'))
    } else assert.equal(result.deferred, change === 'pending' ? 'pending_operation' : 'batch_in_flight')
  })
}

for (const change of ['pending', 'batch']) {
  test(`ordinary close fences late ${change} immediately after its final owner await`, async () => {
    const w = world({ bootstrapFuel: true })
    await w.start()
    const calls = w.calls.length
    const assertOwner = w.agent.assertCheckpointOwnerCurrent.bind(w.agent)
    let fired = false
    w.agent.assertCheckpointOwnerCurrent = async (...args) => {
      const caller = new Error('capture checkpoint caller').stack.split('\n')[2]
      await assertOwner(...args)
      if (!fired && caller.includes('NpcAgentLoop.applyStepClose')) {
        fired = true
        if (change === 'batch') w.agent.batchInFlight = true
        else w.memory.pendingOperation = () => ({ operation_key: 'late-pending' })
      }
    }
    const result = await w.agent.completed()
    assert.equal(fired, true)
    assert.equal(result.deferred, change === 'pending' ? 'pending_operation' : 'batch_in_flight')
    assert.equal(w.held().active_step_index, 0)
    assert.equal(w.game.mutations.length, 1)
    assert.equal(w.calls.length, calls)
    assert.equal(w.rows.some(row => row.event === 'step.verified'), false)
  })
}

// Explicit BD substitution: the historical internal refusal payload was not
// retained. Inject the current native entity_not_visible shape after real commit.
function losePreservationVisibility(w, { persistently = false } = {}) {
  let invisible = true
  const native = w.game.command.bind(w.game)
  const mutate = w.game.onMutation
  w.game.onMutation = text => {
    mutate?.(text)
    if (text.includes("'walk_to_position'")) {
      invisible = persistently
      w.game.lastTaskTypes = ['walking'] // native arrival is not deterministic gameplay verification
    }
  }
  w.game.command = async text => {
    if (text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, position: { x: 100, y: 20 } }, surface_index: 1, force_index: 1 })
    if (invisible && text.includes('entity_geometry')) return JSON.stringify({ found: false, code: 'entity_not_visible', unit_number: 21 })
    return native(text)
  }
}

test('BD residual invisible proof returns through native admission then ordinary receipt closes once without replay', async () => {
  const w = world({ required: true })
  await w.start()
  const before = structuredClone(w.held().steps)
  losePreservationVisibility(w)
  const first = await w.agent.completed()
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 1, JSON.stringify(w.rows.slice(-10)))
  assert.equal(w.held().active_step_index, 0)
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 1)
  assert.deepEqual(w.held().steps[0], before[0])
  assert.deepEqual(w.held().steps.map(s => [s.description, s.obligations]), before.map(s => [s.description, s.obligations]))
  assert.equal(w.game.mutations.filter(text => text.includes("'place_entity'")).length, 1)
  assert.ok(w.rows.some(r => r.event === 'contract.preservation_recovery_admitted'))
  assert.ok(first)
})

test('BD unchanged visibility failure exhausts one durable semantic-step claim after restore', async () => {
  const w = world({ required: true })
  await w.start()
  losePreservationVisibility(w, { persistently: true })
  await w.agent.completed()
  const snapshot = w.memory.snapshot()
  w.memory.restore(snapshot)
  await w.agent.completed()
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 1)
  assert.ok(w.rows.some(r => r.event === 'contract.preservation_recovery_exhausted' && r.data.reason === 'preservation_recovery_semantic_step_exhausted'))
  assert.equal(w.memory.currentPlan(KEY).status, 'paused')
})

for (const variant of ['missing_grant', 'malformed_ledger', 'wrong_body_force', 'persist_failure', 'replace_during_trace']) {
  test(`BD preservation recovery safely refuses ${variant} before navigation`, async () => {
    const w = world({ required: true })
    await w.start()
    losePreservationVisibility(w)
    if (variant === 'missing_grant') w.memory.currentGoalGrant = () => undefined
    if (variant === 'malformed_ledger') {
      const snapshot = w.memory.snapshot()
      snapshot.preservation_recoveries = [['invalid', { state: 'admitted', claimed_at: 0 }]]
      w.memory.restore(snapshot)
    }
    if (variant === 'wrong_body_force') {
      const read = w.game.command.bind(w.game)
      w.game.command = text => text.includes('remote.call("autorio_actor","status")')
        ? JSON.stringify({ actor: { actor_id: 18, position: { x: 100, y: 20 } }, surface_index: 1, force_index: 2 }) : read(text)
    }
    if (variant === 'persist_failure') w.agent.persistState = async () => { throw new Error('injected durable write failure') }
    if (variant === 'replace_during_trace') {
      const trace = w.agent.behaviorTrace.emit
      w.agent.behaviorTrace.emit = async row => {
        await trace(row)
        if (row.event === 'contract.preservation_recovery_claimed') w.agent.generation++
      }
    }
    try { await w.agent.completed() } catch (error) {
      assert.match(error.message, /scope_changed|durable write failure|cancelled|superseded|stale|owner/i)
    }
    assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 0)
    assert.equal(w.held().active_step_index, 0)
  })
}

for (const fault of ['native_busy', 'uncertain_journal', 'body_force']) test(`BD final admission fences ${fault} injected during recovery trace`, async () => {
  const w = world({ required: true })
  await w.start()
  losePreservationVisibility(w)
  const trace = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => {
    await trace(row)
    if (row.event !== 'contract.preservation_recovery_claimed') return
    if (fault === 'native_busy') { w.game.taskState = 'working'; w.game.queueLength = 1 }
    else {
      const read = w.game.command.bind(w.game)
      w.game.command = async text => {
        const raw = await read(text)
        if (fault === 'body_force' && text.includes('remote.call("autorio_actor","status")')) return JSON.stringify({ actor: { actor_id: 18, position: { x: 100, y: 20 } }, surface_index: 1, force_index: 2 })
        if (fault === 'uncertain_journal' && text.includes('remote.call("autorio_operations","status")')) return JSON.stringify({ ...JSON.parse(raw), admission_journal: null })
        return raw
      }
    }
  }
  try { await w.agent.completed() } catch (error) { assert.match(error.message, /busy|idle|unsettled|scope_changed|guard|pending|checkpoint/i) }
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 0)
})

test('BD recovery grant revoked during claim trace remains a guard with no navigation', async () => {
  const w = world({ required: true })
  await w.start()
  losePreservationVisibility(w)
  const trace = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => {
    await trace(row)
    if (row.event === 'contract.preservation_recovery_claimed') w.memory.currentGoalGrant = () => undefined
  }
  await assert.rejects(w.agent.completed(), error => error.pause_class === 'guard' && error.code === 'preservation_recovery_authority_changed')
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 0)
  assert.equal(w.memory.preservationRecoveries.size, 1)
})

test('BD missed ordinary receipt settlement recovers through native_completion and closes on the next fresh read', async () => {
  const w = world({ required: true })
  await w.start()
  losePreservationVisibility(w)
  const route = w.agent.routeStepCompletionDecision.bind(w.agent)
  let bypassed = false
  w.agent.routeStepCompletionDecision = receipt => {
    if (!bypassed) { bypassed = true; return { verified: false, state: w.memory.currentPlan(KEY), reason: 'injected_missed_receipt_settlement' } }
    return route(receipt)
  }
  await w.agent.completed()
  assert.ok(w.rows.some(r => r.event === 'contract.preservation_recovery_claimed' && r.data.trigger === 'native_completion'))
  await w.agent.completed()
  assert.equal(w.held().active_step_index, 1)
  assert.equal(w.game.mutations.filter(text => text.includes("'place_entity'")).length, 1)
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 1)
})

test('BD second proof read losing visibility propagates terminal exhaustion without another model action', async () => {
  const w = world({ required: true })
  await w.start()
  losePreservationVisibility(w)
  const trace = w.agent.behaviorTrace.emit
  w.agent.behaviorTrace.emit = async row => {
    await trace(row)
    if (row.event === 'contract.preservation_recovery_completed') {
      const read = w.game.command.bind(w.game)
      w.game.command = text => text.includes('entity_geometry') ? JSON.stringify({ found: false, code: 'entity_not_visible' }) : read(text)
    }
  }
  await w.agent.completed()
  const calls = w.calls.length
  const stopped = await w.agent.completed()
  assert.equal(stopped.goalStatus, 'paused')
  assert.equal(w.calls.length, calls)
  assert.equal(w.game.mutations.filter(text => text.includes("'walk_to_position'")).length, 1)
})
