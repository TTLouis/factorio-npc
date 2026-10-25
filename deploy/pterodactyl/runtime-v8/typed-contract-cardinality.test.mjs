import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { getActivePlan } from './planning-state.mjs'
import { captureObligationProof, normalizeObligations, compileObligations, obligationContractContext, obligationContractMatches } from './contract-obligations.mjs'
import { sanitizeStepCompletionContract, evaluateCompletionContract, checkpointBatchContradiction, provePermanentlyUnsatisfiable, COMPLETION_REQUIREMENT_LIMIT } from './step-completion.mjs'
import { completionContractSignature, normalizeStepCompletions } from './luna-step-contracts.mjs'
import { FakeFactorio, planReply } from './task-loop-fixtures.mjs'
import { recoverySession } from './recovery-loop-fixtures.mjs'
import { EXECUTOR_ROLE } from './agent-roles.mjs'

const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/ax-a-typed-cardinality.json', import.meta.url), 'utf8'))
const KEY = fixture.pre_failure.snapshot.planning_states[0].key
function world({ phase = 'pre_failure', reply, onRead } = {}) {
  const memory = new CanonicalTaskBoardMemory()
  memory.restore({ version: 1, ...structuredClone(fixture[phase].snapshot) })
  const plan = getActivePlan(memory.planningState(KEY))
  const game = new FakeFactorio({ inventory: Object.fromEntries(fixture.native_observed.inventory.map(row => [row.name, row.count])) })
  Object.assign(game.status, { actor_id: 14, epoch: 1, surface_index: 1, force_index: 1, connected_players: 0 })
  const native = game.command.bind(game)
  game.command = async command => {
    await onRead?.({ command, game, memory, agent })
    if (command.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(command)?.[1])
      const observed = plan.steps[1].obligation_proof.preserved.find(row => row.entity.unit_number === id)
      return JSON.stringify({ ...observed, found: Boolean(observed), fluid_box_count: 0, actor_surface_index: 1, actor_force_index: 1 })
    }
    return native(command)
  }
  let calls = 0
  const rows = []
  const agent = new NpcAgentLoop({ memory, rcon: game, npcId: 'npc-1', systemPrompt: 'Offline exact AX phase replay; native replies are labelled substitutions.',
    provider: async (...args) => { calls++; if (reply) return reply(...args); throw new Error('Unexpected checkpoint provider call') }, stateFile: null, traceFile: null, decisionTraceFile: null })
  agent.epoch = { ...game.status }
  agent.lastMemoryKey = KEY
  agent.requestInfo = { memoryKey: KEY, sender: 'offline-activation', text: memory.planningState(KEY).goal.objective, turnId: 24 }
  agent.traceRequest = { id: 'ax_offline_activation', seq: 0 }
  agent.active = true
  agent.behaviorTrace = { emit: async row => { rows.push(row) } }
  return { memory, game, agent, rows, calls: () => calls, plan: () => getActivePlan(memory.planningState(KEY)) }
}

test('AX-A exact pre-failure activation binds every original predicate without a checkpoint provider call', async () => {
  const w = world()
  const original = structuredClone(w.plan())
  assert.equal(original.steps[1].completion_contract, null)
  assert.equal(original.steps[1].obligations.outcome.requirements.length + original.steps[1].obligations.preserve.length, 9)
  const result = await w.agent.ensureActiveStepContract({ trigger: 'step_close', closedStepId: 'step_1', closedBy: 'deterministic_completion_contract' })
  assert.equal(result.ok, true, JSON.stringify(result.failure))
  assert.equal(w.plan().steps[1].completion_contract.requirements.length, 9)
  assert.deepEqual(w.plan().steps[1].obligations, original.steps[1].obligations)
  assert.deepEqual(w.plan().steps[1].obligation_proof, original.steps[1].obligation_proof)
  assert.equal(w.plan().plan_id, original.plan_id)
  assert.equal(w.plan().plan_version, original.plan_version)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})


const typedIntent = (outcomes, preserved) => ({ outcome: { mode: 'all', requirements: Array.from({ length: outcomes }, (_, index) =>
  ({ kind: 'inventory_count', item_name: `item-${index}`, minimum: 1 })) }, preserve: Array.from({ length: preserved }, (_, index) => 30 + index) })
for (const [outcomes, preserved] of [[8, 8], [8, 0], [6, 3], [1, 8]]) {
  test(`complete typed ${outcomes}+${preserved} keeps every predicate; raw generic authoring still caps at eight`, () => {
    const intent = typedIntent(outcomes, preserved)
    const contract = compileObligations(intent)
    const context = obligationContractContext(intent)
    assert.equal(COMPLETION_REQUIREMENT_LIMIT, 8)
    assert.equal(contract.requirements.length, outcomes + preserved)
    assert.equal(obligationContractMatches(contract, intent), true)
    assert.equal(JSON.parse(completionContractSignature(contract, context)).requirements.length, outcomes + preserved)
    const facts = Object.fromEntries(contract.requirements.map(row => [row.id, row.kind === 'inventory_count' ? { kind: row.kind, item_name: row.item_name, current: 1 } : { kind: row.kind, unit_number: row.unit_number, exists: true }]))
    assert.equal(evaluateCompletionContract(contract, facts, context).satisfied, true)
    if (preserved) {
      facts[contract.requirements.at(-1).id].exists = false
      const incomplete = evaluateCompletionContract(contract, facts, context)
      assert.equal(incomplete.satisfied, false)
      assert.equal(incomplete.results.length, outcomes + preserved)
      assert.ok(checkpointBatchContradiction(contract, [{ name: 'mine_entity_exact', args: { unit_number: 30 + preserved - 1 } }], context))
      assert.ok(provePermanentlyUnsatisfiable(contract, { staleUnitNumbers: [30 + preserved - 1], contractContext: context }))
    }
    if (outcomes + preserved > 8) {
      assert.equal(sanitizeStepCompletionContract({ ...contract, source: 'runtime', typed: true, expectedRequirements: context.expectedRequirements }).mode, 'semantic_unknown')
      assert.throws(() => normalizeStepCompletions(['test'], [{ kind: 'deterministic', checkpoint: contract }]), /supported checkpoint/)
      assert.equal(sanitizeStepCompletionContract({ ...contract, requirements: contract.requirements.slice(0, -1) }, context).mode, 'semantic_unknown')
    }
  })
}

test('AX complete binding round trips board and canonical state without losing preservation', async () => {
  const w = world()
  await w.agent.ensureActiveStepContract({ trigger: 'admission_backstop' })
  const before = w.memory.snapshot()
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(before)
  const plan = getActivePlan(restored.planningState(KEY))
  assert.equal(plan.steps[1].completion_contract.requirements.length, 9)
  assert.equal(restored.currentPlan(KEY).task_board.steps[1].completion_contract.requirements.length, 9)
  assert.deepEqual(plan.steps[1].obligations, w.plan().steps[1].obligations)
  assert.equal(restored.planningState(KEY).run.auto_resume, w.memory.planningState(KEY).run.auto_resume)
})


test('missed prevention reaches actual Session admission backstop and continues unchanged AX step once', async () => {
  const w = world({ reply: async (_messages, context) => {
    assert.notEqual(context?.triggerSource, 'step_contract')
    return planReply({ stepId: w.plan().steps[1].step_id, operations: [{ name: 'wait', args: { ticks: 1 } }] })
  } })
  w.agent.agentContext.role = EXECUTOR_ROLE
  w.agent.requestLifecycle = 'completion'
  w.agent.planUpdateReason = 'completion'
  const original = structuredClone(w.plan())
  const ledger = structuredClone(w.memory.planningState(KEY).run.auto_resume)
  const { session } = recoverySession({ ...w, trace: w.rows }, { actorId: 14, epoch: 1 })
  const result = await session.queueEvent(() => w.agent.runGuarded())
  assert.equal(result.operations.length, 1, JSON.stringify({ result, events: w.rows.filter(row => /failed|refused|blocked|declined|paused/.test(row.event)).slice(-8) }))
  assert.equal(w.game.mutations.length, 1)
  assert.equal(w.calls(), 1, 'one ordinary executor request, no checkpoint-provider request')
  const now = w.plan()
  assert.equal(now.steps[1].completion_contract.requirements.length, 9)
  assert.equal(now.steps[1].step_id, original.steps[1].step_id)
  assert.deepEqual(now.steps[1].obligations, original.steps[1].obligations)
  assert.deepEqual(now.steps[1].obligation_proof, original.steps[1].obligation_proof)
  assert.deepEqual(now.execution.step_progress[original.steps[0].step_id], original.execution.step_progress[original.steps[0].step_id])
  assert.equal(now.plan_version, original.plan_version)
  assert.equal(now.plan_id, original.plan_id)
  assert.deepEqual(w.memory.planningState(KEY).run.auto_resume, ledger)
  assert.equal(w.rows.filter(row => row.event === 'plan.contract_bound_just_in_time').length, 1)
  assert.equal(w.rows.some(row => row.event === 'goal.paused'), false)
})

// These capacity cases substitute new bounded intents/native entities; the AX replay above
// retains the exact issued six-plus-three intent and original committed history.
test('immediate and deferred typed declarations compile the full existing sixteen-predicate capability', async () => {
  const w = world()
  const planning = w.memory.planningState(KEY)
  const held = w.plan()
  w.memory.planningByNpc.set(KEY, { ...planning, plans: planning.plans.map(p => p === held ? { ...p, status: 'DRAFT' } : p) })
  const native = w.game.command.bind(w.game)
  w.game.command = async command => {
    if (command.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(command)?.[1])
      const base = structuredClone(held.steps[1].obligation_proof.preserved[0])
      base.entity.unit_number = id
      base.entity.position.x += id - 30
      return JSON.stringify({ ...base, found: true, fluid_box_count: 0, actor_id: 14, actor_surface_index: 1, actor_force_index: 1 })
    }
    return native(command)
  }
  const intent = typedIntent(8, 8)
  const plan = { plan: ['Immediate bounded intent', 'Deferred bounded intent'], currentStep: 0, operations: [],
    stepCompletions: [{ kind: 'deterministic', obligations: intent }, { kind: 'deterministic', obligations: intent }] }
  await w.agent.validateStepCompletionDeclarations(plan)
  assert.equal(plan.stepCompletions[0].checkpoint.requirements.length, 16)
  assert.equal(plan.stepCompletions[1].checkpoint, undefined, 'deferred activation remains deferred')
  for (const row of plan.stepCompletions) assert.equal(row.obligationProof.preserved.length, 8)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('the exact already-guard-paused row18 is not an activation or a resume grant', async () => {
  const w = world({ phase: 'existing_guard' })
  const before = w.memory.snapshot()
  const result = await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  assert.equal(result.skipped, true)
  assert.deepEqual(w.memory.snapshot(), before)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

for (const change of ['cancel', 'replacement', 'actor', 'epoch']) {
  test(`pending typed activation refuses ${change} during its actual fresh preservation read`, async () => {
    let changed = false
    let replacement
    const w = world({ onRead: ({ command, game, agent }) => {
      if (changed || !command.includes('entity_geometry')) return
      changed = true
      if (change === 'cancel') agent.cancel('user_stop_immediate')
      if (change === 'replacement') { agent.generation++; agent.traceRequest = { id: 'replacement', seq: 0 }; replacement = structuredClone(agent.traceRequest) }
      if (change === 'actor') game.status.actor_id++
      if (change === 'epoch') game.status.epoch++
    } })
    const before = structuredClone(w.plan())
    await assert.rejects(w.agent.ensureActiveStepContract({ trigger: 'startup' }))
    assert.deepEqual(w.plan(), before)
    assert.equal(w.calls(), 0)
    assert.equal(w.game.mutations.length, 0)
    assert.equal(w.plan().steps[1].completion_contract, null)
    if (change === 'replacement') assert.deepEqual(w.agent.traceRequest, replacement, JSON.stringify(w.rows))
  })
}

test('duplicate activation and restored pending activation cannot replenish or spend durable recovery allowances', async () => {
  const w = world()
  const before = structuredClone(w.memory.planningState(KEY).run.auto_resume)
  const [a, b] = await Promise.all([w.agent.ensureActiveStepContract({ trigger: 'startup' }), w.agent.ensureActiveStepContract({ trigger: 'startup' })])
  assert.equal(a.bound, true)
  assert.equal(b.bound, true)
  assert.equal(w.rows.filter(row => row.event === 'plan.contract_bound_just_in_time').length, 1)
  assert.equal((await w.agent.ensureActiveStepContract({ trigger: 'duplicate' })).skipped, true)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  assert.deepEqual(restored.planningState(KEY).run.auto_resume, before)
  assert.equal(restored.currentPlan(KEY).task_board.steps[1].completion_contract.requirements.length, 9)
  assert.equal(w.calls(), 0)
})

for (const boundary of ['amendment', 'batch', 'pending', 'condition']) {
  test(`pending activation settlement holds at ${boundary} without binding or spending`, async () => {
    const w = world()
    const before = structuredClone(w.plan())
    if (boundary === 'amendment') w.agent.currentPendingAmendment = () => ({ id: 'held-amendment' })
    if (boundary === 'batch') w.agent.batchInFlight = true
    if (boundary === 'pending') w.memory.pendingOperation = () => ({ operation_key: 'uncertain' })
    if (boundary === 'condition') w.memory.currentPlan(KEY).condition_wait = { id: 'native-wait' }
    const result = await w.agent.closeActiveStepOnFreshRead({ previousState: w.memory.currentPlan(KEY), trigger: 'checkpoint_met_before_wait' })
    assert.equal(result.closed, false)
    assert.deepEqual(w.plan(), before)
    assert.equal(w.calls(), 0)
    assert.equal(w.game.mutations.length, 0)
  })
}

test('fresh actual settlement keeps all preservation conjuncts even when all six inventory outcomes are met', async () => {
  const w = world()
  await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  for (const row of w.plan().steps[1].obligations.outcome.requirements) w.game.inventory[row.item_name] = row.minimum
  const native = w.game.command.bind(w.game)
  w.game.command = async command => command.includes('entity_geometry') && /entity_geometry["'],\s*32/.test(command)
    ? JSON.stringify({ found: false, unit_number: 32, actor_id: 14 }) : native(command)
  const original = structuredClone(w.plan())
  const result = await w.agent.closeActiveStepOnFreshRead({ previousState: w.memory.currentPlan(KEY), trigger: 'checkpoint_met_before_wait' })
  assert.equal(result.closed, false)
  assert.equal(w.plan().active_step_index, original.active_step_index)
  assert.equal(w.plan().steps[1].completion_contract.requirements.length, 9)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('restored board cannot grant a generic expanded contract or lose one typed conjunct', async () => {
  const w = world()
  await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  for (const tamper of ['missing_preserve', 'wrong_intent', 'no_provenance']) {
    const snapshot = structuredClone(w.memory.snapshot())
    const board = snapshot.plans[0].state.task_board
    const step = snapshot.planning_states[0].state.plans.find(row => row.plan_id === w.plan().plan_id).steps[1]
    if (tamper === 'missing_preserve') board.steps[1].completion_contract.requirements.pop()
    if (tamper === 'wrong_intent') board.steps[1].completion_contract.requirements[0].minimum++
    if (tamper === 'no_provenance') step.obligation_proof = null
    const restored = new CanonicalTaskBoardMemory()
    restored.restore(snapshot)
    const held = restored.currentPlan(KEY).task_board.steps[1].completion_contract
    assert.ok(!held || held.requirements.length === 9 && obligationContractMatches(held, w.plan().steps[1].obligations), tamper)
    assert.equal(w.game.mutations.length, 0)
  }
})

test('substituted sixteen-predicate committed intent retains exact ids/signature through real bind, board, restore and fresh facts', async () => {
  const w = world()
  const step = w.plan().steps[1]
  const oldProof = step.obligation_proof
  let missing = false
  const native = w.game.command.bind(w.game)
  w.game.command = async command => {
    if (command.includes('entity_geometry')) {
      const id = Number(/entity_geometry["'],\s*(\d+)/.exec(command)?.[1])
      const base = structuredClone(oldProof.preserved[0])
      base.entity.unit_number = id
      base.entity.position.x += id - 30
      return JSON.stringify({ ...base, found: true, fluid_box_count: 0, actor_id: 14, actor_surface_index: 1, actor_force_index: 1 })
    }
    if (command.includes('evaluate_condition')) {
      const encoded = /helpers\.json_to_table\('((?:[^'\\]|\\.)*)'\)/.exec(command)?.[1]
      const row = encoded ? JSON.parse(encoded.replace(/\\(.)/g, '$1')) : {}
      return JSON.stringify(row.kind === 'entity_exists' ? { ok: !missing || row.unit_number !== 37, exists: !missing || row.unit_number !== 37, kind: row.kind }
        : { ok: true, kind: row.kind, current: 1, satisfied: true })
    }
    return native(command)
  }
  // Labelled capacity substitution only: original AX replay remains six-plus-three.
  const obligations = normalizeObligations(typedIntent(8, 8))
  const proof = await captureObligationProof(w.agent, obligations, async () => {})
  const changed = { ...step, obligations, obligation_proof: { ...proof, binding: oldProof.binding, captured_at: oldProof.captured_at } }
  const planning = w.memory.planningState(KEY)
  const held = w.plan()
  w.memory.planningByNpc.set(KEY, { ...planning, plans: planning.plans.map(plan => plan === held
    ? { ...plan, steps: plan.steps.map(row => row === step ? changed : row) } : plan) })
  const bound = await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  assert.equal(bound.bound, true, JSON.stringify(bound))
  const contract = w.plan().steps[1].completion_contract
  const signature = w.agent.contractSignature(contract)
  assert.equal(contract.requirements.length, 16)
  const ids = contract.requirements.map(row => row.id)
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(w.memory.snapshot())
  const canonical = getActivePlan(restored.planningState(KEY)).steps[1]
  const board = restored.currentPlan(KEY).task_board.steps[1]
  for (const retained of [canonical.completion_contract, board.completion_contract]) {
    assert.deepEqual(retained.requirements.map(row => row.id), ids)
    assert.equal(completionContractSignature(retained, obligationContractContext(canonical.obligations)), signature)
  }
  missing = true
  const facts = await w.agent.completionFactsForContract(contract, undefined, [], { committedIdentity: true })
  assert.equal(Object.keys(facts).length, 16)
  const evaluation = w.agent.evaluateCompletionContract(contract, facts)
  assert.equal(evaluation.results.length, 16)
  assert.equal(evaluation.satisfied, false, 'the eighth preservation conjunct remains authoritative')
  assert.equal(evaluation.results.filter(row => row.satisfied).length, 15)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('same-owner amendment arriving during typed proof capture defers the unchanged bind without consuming it', async () => {
  const amendment = { id: 'new-same-owner-amendment' }
  let staged = false
  const w = world({ onRead: ({ command, agent }) => {
    if (!staged && command.includes('entity_geometry')) {
      staged = true
      agent.currentPendingAmendment = () => amendment
    }
  } })
  const before = structuredClone(w.plan())
  const result = await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  assert.equal(result.deferred, 'pending_amendment')
  assert.deepEqual(w.plan(), before)
  assert.equal(w.agent.currentPendingAmendment(), amendment)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('a failed strict binding write refuses continuation and leaves every durable recovery allowance unchanged', async () => {
  const w = world()
  const original = structuredClone(w.memory.planningState(KEY).run.auto_resume)
  w.agent.persistState = async options => { assert.equal(options.strict, true); throw new Error('fixture strict persistence unavailable') }
  await assert.rejects(w.agent.ensureActiveStepContract({ trigger: 'startup' }), /strict persistence unavailable/)
  assert.deepEqual(w.memory.planningState(KEY).run.auto_resume, original)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})

test('explicit global stop and operator pause cannot be converted into typed activation authority', async () => {
  const w = world()
  w.agent.cancel('user_stop_immediate')
  await w.agent.pausePersistentPlan('user_stop', { pause_class: 'operator' })
  const stopped = w.memory.snapshot()
  const result = await w.agent.ensureActiveStepContract({ trigger: 'startup' })
  assert.equal(result.skipped, true)
  assert.deepEqual(w.memory.snapshot(), stopped)
  assert.equal(w.plan().steps[1].completion_contract, null)
  assert.equal(w.calls(), 0)
  assert.equal(w.game.mutations.length, 0)
})
