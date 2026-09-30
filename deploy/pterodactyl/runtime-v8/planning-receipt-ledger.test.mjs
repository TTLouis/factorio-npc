import test from 'node:test'
import assert from 'node:assert/strict'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcDialogueMemory } from './npc-agent-loop.mjs'
import {
  applyPlanningEvent,
  buildContextRestagedEvent,
  CONTEXT_RESTAGE_LIMITS,
  createEmptyPlanningState,
  getActivePlan,
  getContextRestages,
  PLAN_STATUS,
  PLANNING_EVENT,
  RECEIPT_LEDGER_LIMITS,
  restorePlanningState,
  serializePlanningState,
} from './planning-state.mjs'

const KEY = 'npc:sgluna'

function goalState() {
  return applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now: 10,
    goal_id: 'goal_ledger',
    owner: 'Louis',
    objective: 'Make iron plates',
  })
}

function committed(state = goalState()) {
  const drafted = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    steps: [{ description: 'Mine ore' }, { description: 'Smelt ore' }],
  })
  return applyPlanningEvent(drafted, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now: 30,
    plan_id: getActivePlan(drafted).plan_id,
    runtime_validation: { passed: true },
  })
}

function receipt(state, overrides = {}) {
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED,
    now: 100,
    source: 'runtime',
    goal_id: 'goal_ledger',
    kind: 'operation_receipt',
    ref: 'batch_7',
    summary: JSON.stringify({ outcome: 'completed', task_types: ['mine_resource'], batch_id: 7 }),
    ...overrides,
  })
}

function ledger(state, stepIndex = 0) {
  const plan = getActivePlan(state)
  return plan.execution.receipts[plan.steps[stepIndex].step_id] ?? []
}

function planContent(state) {
  return JSON.stringify({
    plans: state.plans.map(plan => ({ ...plan, execution: { ...plan.execution, receipts: undefined, receipts_seeded: undefined } })),
    active_plan_id: state.active_plan_id,
    goal: state.goal,
    reasoning_epoch: state.reasoning_epoch,
  })
}

// --- move 2: reducer -----------------------------------------------------------

test('OPERATION_RECEIPT_RECORDED appends a bounded entry to the active plan and step', () => {
  const state = committed()
  const next = receipt(state)
  const entries = ledger(next)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].kind, 'operation_receipt')
  assert.equal(entries[0].ref, 'batch_7')
  assert.equal(entries[0].batch_id, '7')
  assert.equal(entries[0].at, 100)
  assert.equal(entries[0].source, 'runtime')
  assert.match(entries[0].summary, /outcome=completed/)
  assert.deepEqual(ledger(next, 1), [], 'the other step is untouched')
  assert.equal(planContent(next), planContent(state), 'no plan, step, blocker or epoch effect')
})

test('batch id comes from an explicit id, a batch_ ref, or the receipt summary', () => {
  let state = committed()
  state = receipt(state, { batch_id: 41, ref: 'other' })
  state = receipt(state, { ref: 'batch_9', summary: '' })
  state = receipt(state, { ref: 'request/x', summary: JSON.stringify({ batch_id: 12 }) })
  state = receipt(state, { ref: 'request/y', summary: 'free text' })
  assert.deepEqual(ledger(state).map(entry => entry.batch_id), ['41', '9', '12', ''])
})

test('the ledger caps entries per step, keeps the newest, and bounds every field', () => {
  let state = committed()
  const total = RECEIPT_LEDGER_LIMITS.perStep + 6
  for (let i = 0; i < total; i++) state = receipt(state, { ref: `batch_${i}`, now: 100 + i })
  const entries = ledger(state)
  assert.equal(entries.length, RECEIPT_LEDGER_LIMITS.perStep)
  assert.equal(entries.at(-1).ref, `batch_${total - 1}`)
  assert.equal(entries[0].ref, `batch_${total - RECEIPT_LEDGER_LIMITS.perStep}`)
  const seqs = entries.map(entry => entry.seq)
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'sequence stays monotonic')

  const long = receipt(committed(), { kind: 'k'.repeat(500), ref: 'r'.repeat(500), summary: 'x'.repeat(5000) })
  const [entry] = ledger(long)
  assert.ok(entry.kind.length <= RECEIPT_LEDGER_LIMITS.kind)
  assert.ok(entry.ref.length <= RECEIPT_LEDGER_LIMITS.ref)
  assert.ok(entry.summary.length <= RECEIPT_LEDGER_LIMITS.summary)
})

test('receipts fail closed: wrong source, stale goal, plan, epoch or step, no goal, cancelled plan', () => {
  const state = committed()
  const planId = getActivePlan(state).plan_id
  for (const source of ['main_planner', 'jev', 'user', '', undefined]) {
    assert.equal(receipt(state, { source }), state, `source ${String(source)} refused`)
  }
  assert.equal(receipt(state, { goal_id: 'goal_other' }), state, 'stale goal')
  assert.equal(receipt(state, { plan_id: 'plan_gone' }), state, 'unknown plan')
  assert.equal(receipt(state, { step_id: 'step_gone' }), state, 'unknown step')
  assert.equal(receipt(state, { reasoning_epoch: state.reasoning_epoch + 1 }), state, 'stale epoch')
  assert.equal(receipt(state, { kind: '' }), state, 'no kind')
  assert.notEqual(receipt(state, { reasoning_epoch: state.reasoning_epoch, plan_id: planId }), state, 'a matching stamp is accepted')
  const empty = createEmptyPlanningState()
  assert.equal(receipt(empty), empty, 'no goal')
  const cancelled = applyPlanningEvent(state, {
    type: PLANNING_EVENT.PLAN_CANCELLED, now: 60, source: 'user', plan_id: planId, reason: 'test',
  })
  assert.equal(cancelled.plans.find(plan => plan.plan_id === planId).status, PLAN_STATUS.CANCELLED)
  assert.equal(receipt(cancelled, { plan_id: planId }), cancelled, 'a cancelled plan takes no receipts')
})

test('the receipt ledger persists in the snapshot; an old snapshot restores unseeded and empty', () => {
  const state = receipt(committed())
  const round = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(ledger(round), ledger(state))
  assert.equal(getActivePlan(round).execution.receipts_seeded, true)

  const old = JSON.parse(JSON.stringify(serializePlanningState(state)))
  for (const plan of old.plans) {
    delete plan.execution.receipts
    delete plan.execution.receipts_seeded
  }
  const restored = restorePlanningState(old)
  assert.deepEqual(getActivePlan(restored).execution.receipts, {})
  assert.equal(getActivePlan(restored).execution.receipts_seeded, false)
})

// --- move 2: facade ------------------------------------------------------------

function startCommitted(memory) {
  const plan = { chatMessage: 'Working.', plan: ['Gather stone', 'Craft furnace', 'Build power'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] }
  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'Build early automation' }, plan)
  memory.reconcileTaskBoard(KEY, undefined, plan, recorded, { allowReplan: false })
  memory.commitPlanningPlan(KEY, { now: 100, runtime_validation: { passed: true } })
  return memory.currentPlan(KEY)
}

function reducerLedger(memory) {
  const plan = getActivePlan(memory.planningState(KEY))
  return plan.execution.receipts[plan.steps[plan.active_step_index].step_id] ?? []
}

test('recordBoardEvidence records the reducer ledger first and mirrors it into the board', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  // A JSON summary far longer than the ledger digest: readers JSON.parse it.
  const summary = JSON.stringify({ outcome: 'completed', batch_id: 5, task_types: ['mine_resource'], pad: 'p'.repeat(600) })
  assert.ok(summary.length > RECEIPT_LEDGER_LIMITS.summary)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_5', summary })

  const entries = reducerLedger(memory)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].batch_id, '5')
  assert.ok(entries[0].summary.length <= RECEIPT_LEDGER_LIMITS.summary)

  const board = memory.currentPlan(KEY).task_board
  const mirrored = board.evidence.at(-1)
  assert.equal(mirrored.kind, entries[0].kind)
  assert.equal(mirrored.ref, entries[0].ref)
  assert.equal(mirrored.at, entries[0].at)
  assert.equal(mirrored.id, 'evidence_1')
  assert.equal(mirrored.step_id, board.active_step_id)
  // The consumer check: the mirror keeps the FULL summary, so every reader
  // that parses board evidence (step close proof, completion gate) still works.
  assert.equal(mirrored.summary, summary)
  assert.equal(JSON.parse(mirrored.summary).pad.length, 600)
})

test('the board mirror keeps legacy behaviour: same-ref items are all kept, ids and step binding unchanged', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_1', summary: 'a' })
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_1', summary: 'b' })
  memory.recordBoardEvidence(KEY, { kind: 'operation_failure_recoverable', ref: 'batch_2', summary: JSON.stringify({ failure_class: 'x' }) })
  const board = memory.currentPlan(KEY).task_board
  assert.deepEqual(board.evidence.map(item => item.id), ['evidence_1', 'evidence_2', 'evidence_3'])
  assert.deepEqual(board.evidence.map(item => item.summary).slice(0, 2), ['a', 'b'])
  assert.equal(reducerLedger(memory).length, 3, 'one ledger entry per board item')
})

test('outcome evidence items go through the ledger; a repeated ref is not re-recorded', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  const candidate = {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'operation_preflight_failed:missing_dependency',
    candidate_blocker: 'operation_preflight_failed:missing_dependency',
    evidence: [{ kind: 'operation_preflight_blocker', ref: 'preflight_missing_dependency', summary: 'Required dependency cannot be satisfied.' }],
  }
  memory.applyOutcomeAuthority(KEY, candidate)
  memory.applyOutcomeAuthority(KEY, candidate)
  const entries = reducerLedger(memory)
  assert.equal(entries.filter(entry => entry.ref === 'preflight_missing_dependency').length, 1)
  const board = memory.currentPlan(KEY).task_board
  assert.equal(board.evidence.filter(item => item.ref === 'preflight_missing_dependency').length, 1, 'board and ledger agree')
})

test('ledger and mirror survive a restart', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_3', summary: 'ok' })
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.deepEqual(reducerLedger(restored), reducerLedger(memory))
  assert.equal(restored.currentPlan(KEY).task_board.evidence.length, 1)
})

test('an old snapshot without the ledger seeds it once from the legacy board evidence', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_3', summary: 'first' })
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_4', summary: 'second' })
  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  for (const entry of snapshot.planning_states) {
    for (const plan of entry.state.plans) {
      delete plan.execution.receipts
      delete plan.execution.receipts_seeded
    }
  }
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const seeded = reducerLedger(restored)
  assert.deepEqual(seeded.map(entry => entry.ref), ['batch_3', 'batch_4'])
  assert.ok(seeded.every(entry => entry.source === 'legacy_adopted'))
  assert.equal(getActivePlan(restored.planningState(KEY)).execution.receipts_seeded, true)

  restored.seedReceiptLedgerFromLegacy(KEY)
  assert.equal(reducerLedger(restored).length, 2, 'seeding never runs twice')
  restored.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_5', summary: 'third' })
  assert.deepEqual(reducerLedger(restored).map(entry => entry.ref), ['batch_3', 'batch_4', 'batch_5'])
})

// --- move 6: CONTEXT_RESTAGED --------------------------------------------------

function restageEvent(state, overrides = {}) {
  return {
    ...buildContextRestagedEvent(state, {
      role: 'executor', checkpoint: 'C4', reason: 'step_closed', packetChars: 4200, previousContextChars: 31000, now: 500,
    }),
    ...overrides,
  }
}

test('CONTEXT_RESTAGED is recorded as a ledger entry with no plan, step, sequence or epoch effect', () => {
  const state = receipt(committed())
  const before = JSON.stringify({ ...state, context_restages: undefined })
  const event = restageEvent(state)
  assert.equal(event.goal_id, 'goal_ledger')
  assert.equal(event.plan_id, state.active_plan_id)
  const next = applyPlanningEvent(state, event)
  assert.equal(JSON.stringify({ ...next, context_restages: undefined }), before, 'nothing but the restage log changed')
  assert.equal(next.reasoning_epoch, state.reasoning_epoch)
  assert.equal(next.last_reasoning_reset, state.last_reasoning_reset)
  assert.deepEqual(getContextRestages(next), [{
    goal_id: 'goal_ledger',
    plan_id: state.active_plan_id,
    role: 'executor',
    checkpoint: 'C4',
    reason: 'step_closed',
    packet_chars: 4200,
    previous_context_chars: 31000,
    at: 500,
  }])
  // A planner restage is equally free of plan effect.
  const planner = applyPlanningEvent(next, restageEvent(next, { role: 'planner', checkpoint: 'C2', now: 600 }))
  assert.equal(JSON.stringify({ ...planner, context_restages: undefined }), before)
  assert.equal(getContextRestages(planner).length, 2)
})

test('CONTEXT_RESTAGED is harness-only, goal-stamped and validated', () => {
  const state = committed()
  for (const source of ['main_planner', 'jev', 'user', '', undefined]) {
    assert.equal(applyPlanningEvent(state, restageEvent(state, { source })), state)
  }
  assert.equal(applyPlanningEvent(state, restageEvent(state, { goal_id: 'goal_other' })), state)
  assert.equal(applyPlanningEvent(state, restageEvent(state, { goal_id: undefined })), state)
  assert.equal(applyPlanningEvent(state, restageEvent(state, { role: 'jev' })), state)
  assert.equal(applyPlanningEvent(state, restageEvent(state, { checkpoint: 'C9' })), state)
  assert.equal(applyPlanningEvent(state, restageEvent(state, { plan_id: 'plan_gone' })), state)
  assert.equal(getContextRestages(applyPlanningEvent(createEmptyPlanningState(), restageEvent(state))).length, 0)
  const lifecycle = applyPlanningEvent(state, restageEvent(state, { source: 'server_lifecycle', checkpoint: 'C7' }))
  assert.equal(getContextRestages(lifecycle).length, 1, 'a restart restage is allowed')
})

test('the restage log is bounded to the last entries and survives snapshot and restore', () => {
  let state = committed()
  for (let i = 0; i < CONTEXT_RESTAGE_LIMITS.entries + 5; i++) {
    state = applyPlanningEvent(state, restageEvent(state, { now: 1000 + i, reason: `r${i}` }))
  }
  const log = getContextRestages(state)
  assert.equal(log.length, CONTEXT_RESTAGE_LIMITS.entries)
  assert.equal(log.at(-1).reason, `r${CONTEXT_RESTAGE_LIMITS.entries + 4}`)
  const round = restorePlanningState(JSON.parse(JSON.stringify(serializePlanningState(state))))
  assert.deepEqual(getContextRestages(round), log)

  const old = JSON.parse(JSON.stringify(serializePlanningState(state)))
  delete old.context_restages
  assert.deepEqual(getContextRestages(restorePlanningState(old)), [])
})

// --- review follow-ups ---------------------------------------------------------

function boardEvidenceRefs(memory) {
  return memory.currentPlan(KEY).task_board.evidence.map(item => item.ref)
}

test('facade fallback: when the reducer refuses a receipt the legacy board write still happens', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_unknown_plan', summary: 'x', plan_id: 'plan_missing', step_id: 'step_x' })
  const activePlanId = getActivePlan(memory.planningState(KEY)).plan_id
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_unknown_step', summary: 'y', plan_id: activePlanId, step_id: 'step_gone' })
  assert.deepEqual(reducerLedger(memory), [], 'the reducer recorded neither')
  assert.deepEqual(boardEvidenceRefs(memory), ['batch_unknown_plan', 'batch_unknown_step'], 'the board recorded both')
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_ok', summary: 'z', plan_id: activePlanId })
  assert.deepEqual(reducerLedger(memory).map(entry => entry.ref), ['batch_ok'], 'a matching plan stamp is recorded')
})

test('a receipt admitted before a roadmap revision and arriving after it is still recorded when plan and step are unchanged', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.setAdmissionState(KEY, 'admitted')
  const stamp = memory.admissionStamp(KEY)
  assert.equal(stamp.reasoning_epoch, undefined, 'the admission stamp carries no epoch')
  const epochBefore = memory.planningState(KEY).reasoning_epoch

  const revised = applyPlanningEvent(memory.planningState(KEY), {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    source: 'user',
    now: Date.now(),
    reason: 'roadmap moved while a batch was in flight',
    nodes: [{ id: 'roadmap_automation', intent: 'automation and red science', development_hint: 'vertical' }],
  })
  assert.ok(revised.reasoning_epoch > epochBefore, 'the roadmap revision bumped the reasoning epoch')
  memory.planningByNpc.set(KEY, revised)
  const plan = getActivePlan(memory.planningState(KEY))
  assert.equal(plan.plan_id, stamp.plan_id)

  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_across_revision', summary: 'done', ...stamp })
  assert.deepEqual(reducerLedger(memory).map(entry => entry.ref), ['batch_across_revision'], 'real work is not dropped by an epoch bump')
  assert.ok(boardEvidenceRefs(memory).includes('batch_across_revision'))
})

test('the board mirror is identical to what the base class writes, including a 240-character ref', () => {
  const build = (Memory) => {
    const memory = new Memory()
    const plan = { chatMessage: 'Working.', plan: ['Gather stone', 'Craft furnace'], currentStep: 0, operations: [{ name: 'wait', args: { ticks: 1 } }] }
    const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'Build early automation' }, plan)
    memory.reconcileTaskBoard(KEY, undefined, plan, recorded, { allowReplan: false })
    return memory
  }
  const inputs = [
    { kind: 'operation_receipt', ref: `batch_${'r'.repeat(240)}`, summary: 's'.repeat(1500), now: 4242 },
    { kind: 'k'.repeat(120), ref: 'batch_2', summary: 'line\none\ttab  spaced', now: 4243 },
    { kind: 'operation_receipt', ref: '', summary: '', now: 4244 },
  ]
  const base = build(NpcDialogueMemory)
  const facade = build(CanonicalTaskBoardMemory)
  facade.commitPlanningPlan(KEY, { now: 100, runtime_validation: { passed: true } })
  for (const input of inputs) {
    base.recordBoardEvidence(KEY, { ...input })
    facade.recordBoardEvidence(KEY, { ...input })
  }
  assert.deepEqual(facade.currentPlan(KEY).task_board.evidence, base.currentPlan(KEY).task_board.evidence)
  assert.ok(facade.currentPlan(KEY).task_board.evidence[0].ref.endsWith('…'), 'the base truncation mark is preserved')
  assert.ok(reducerLedger(facade).length > 0, 'and the ledger did record')
})

test('a late receipt stamped at admission is refused by the ledger after supersession but still lands on the board', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.setAdmissionState(KEY, 'admitted')
  const stamp = memory.admissionStamp(KEY)
  assert.ok(stamp?.plan_id && stamp.step_id, 'admission recorded the plan and step')
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_early', summary: 'a', ...stamp })
  const v1 = getActivePlan(memory.planningState(KEY))
  assert.equal(v1.plan_id, stamp.plan_id)

  const planning = memory.planningState(KEY)
  const now = Date.now()
  let next = applyPlanningEvent(planning, { type: PLANNING_EVENT.DRAFT_CREATED, now, origin: 'user_replan', steps: [{ description: 'Something else' }] })
  const successor = getActivePlan(next)
  next = applyPlanningEvent(next, { type: PLANNING_EVENT.PLAN_SUPERSEDED, now, source: 'user', plan_id: v1.plan_id, successor_plan_id: successor.plan_id, reason: 'user_replanned' })
  assert.equal(next.plans.find(plan => plan.plan_id === v1.plan_id).status, PLAN_STATUS.SUPERSEDED)
  memory.planningByNpc.set(KEY, next)

  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_late', summary: 'b', ...stamp })
  const after = memory.planningState(KEY)
  const v1After = after.plans.find(plan => plan.plan_id === v1.plan_id)
  assert.deepEqual(v1After.execution.receipts[stamp.step_id].map(entry => entry.ref), ['batch_early'], 'the superseded plan takes no late receipt')
  const successorAfter = getActivePlan(after)
  assert.deepEqual(Object.values(successorAfter.execution.receipts).flat(), [], "and it does not leak into the successor's ledger")
  assert.ok(boardEvidenceRefs(memory).includes('batch_late'), 'the legacy board still records it')
})

test('the admission stamp is dropped with the task context', () => {
  const memory = new CanonicalTaskBoardMemory()
  startCommitted(memory)
  memory.setAdmissionState(KEY, 'admitted')
  assert.ok(memory.admissionStamp(KEY))
  memory.clearTaskContext(KEY)
  assert.equal(memory.admissionStamp(KEY), undefined)
})

test('closed plans keep only the last few receipts per step when persisted', () => {
  let state = committed()
  const planId = getActivePlan(state).plan_id
  for (let i = 0; i < 10; i++) state = receipt(state, { ref: `batch_${i}`, now: 100 + i })
  assert.equal(ledger(state).length, 10)
  const stepId = getActivePlan(state).steps[0].step_id
  const live = JSON.parse(JSON.stringify(serializePlanningState(state)))
  assert.equal(live.plans[0].execution.receipts[stepId].length, 10, 'an open plan keeps them all')
  const cancelled = applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_CANCELLED, now: 200, source: 'user', plan_id: planId, reason: 'test' })
  const persisted = JSON.parse(JSON.stringify(serializePlanningState(cancelled)))
  assert.equal(persisted.plans[0].execution.receipts[stepId].length, RECEIPT_LEDGER_LIMITS.closedPlanPerStep)
  assert.equal(persisted.plans[0].execution.receipts[stepId].at(-1).ref, 'batch_9')
  const restored = restorePlanningState(persisted)
  assert.equal(restored.plans[0].execution.receipts[stepId].length, RECEIPT_LEDGER_LIMITS.closedPlanPerStep)
})

test('seeding a revised plan with a carried prefix adopts only the steps the plan holds', () => {
  const steps = [
    { id: 'step_1', description: 'Gather iron ore near base (~40).', status: 'completed' },
    { id: 'step_2', description: 'Smelt iron ore into iron plates.', status: 'active' },
    { id: 'step_3', description: 'Craft an electric mining drill.', status: 'pending' },
  ]
  const board = {
    kind: 'task_board_lite', goal_id: 'goal_1', status: 'active', blocker: '', pause_reason: '', revision: 3, event_sequence: 0,
    evidence_sequence: 1, active_index: 1, active_step_id: 'step_2', completed_count: 1, total_steps: 3, steps,
    evidence: [{ id: 'evidence_1', kind: 'operation_receipt', ref: 'batch_carried', summary: 'old', at: 5, step_id: 'step_1' }],
    events: [], created_at: 1, updated_at: 1,
  }
  const memory = new CanonicalTaskBoardMemory()
  memory.planByNpc.set(KEY, {
    goal_id: 'goal_1', owner: 'Louis', objective: 'Get power', status: 'active', blocker: '', pause_reason: '',
    plan: steps.map(step => step.description), current_step: 1, revision: 3, last_chat_message: '', last_operations: [],
    updated_at: 1, history: [], task_board: board,
  })
  memory.ensurePlanningDraft(KEY, memory.planByNpc.get(KEY), { now: 100, migrated: true })
  memory.commitPlanningPlan(KEY, { now: 110, migrated: true, runtime_validation: { passed: true } })
  memory.replayLegacyVerifiedPrefix(KEY, memory.planByNpc.get(KEY), memory.planningState(KEY), { now: 115 })
  // A structural blocker, the user picks Revise, the planner restates the
  // verified first step and adds a new one: the successor carries step 1.
  memory.applyOutcomeAuthority(KEY, {
    kind: 'world_blocked',
    source: 'deterministic_runtime',
    reason_code: 'transfer_failed:item_missing',
    candidate_blocker: 'transfer_failed:item_missing',
    evidence: [{ kind: 'fresh_world_observation', ref: 'block_1', summary: 'no coal' }],
  })
  memory.recordBlockedChoice(KEY, 'revise', 'Louis', { now: 120 })
  const blockedBoard = memory.currentPlan(KEY).task_board
  const proposed = {
    chatMessage: 'Revised.',
    plan: [steps[0].description, 'Gather 40 coal (ran out of coal).', steps[1].description, steps[2].description],
    currentStep: blockedBoard.completed_count,
    operations: [{ name: 'wait', args: { ticks: 1 } }],
  }
  const recorded = memory.recordPlan(KEY, { sender: 'Louis', text: 'revise the plan' }, proposed)
  memory.reconcileTaskBoard(KEY, blockedBoard, proposed, recorded, { previousState: memory.currentPlan(KEY) })
  assert.equal(recorded.userRevisionApproved, true)
  memory.commitPlanningPlan(KEY, { now: 140, runtime_validation: { passed: true } })
  const revised = getActivePlan(memory.planningState(KEY))
  assert.equal(revised.plan_version, 2)
  assert.equal(revised.carried_forward_evidence.length, 1, 'step 1 is carried, not repeated')
  assert.equal(revised.steps.length, 3)
  memory.recordBoardEvidence(KEY, { kind: 'operation_receipt', ref: 'batch_current', summary: 'now' })

  const snapshot = JSON.parse(JSON.stringify(memory.snapshot()))
  for (const entry of snapshot.planning_states) {
    for (const plan of entry.state.plans) {
      delete plan.execution.receipts
      delete plan.execution.receipts_seeded
    }
  }
  const restored = new CanonicalTaskBoardMemory()
  restored.restore(snapshot)
  const plan = getActivePlan(restored.planningState(KEY))
  const adopted = Object.values(plan.execution.receipts).flat().map(entry => entry.ref)
  assert.ok(adopted.includes('batch_current'), 'the current step receipt is adopted')
  assert.ok(!adopted.includes('batch_carried'), 'a receipt of a carried predecessor step is not adopted into a step it does not belong to')
  assert.equal(plan.execution.receipts_seeded, true)
})
