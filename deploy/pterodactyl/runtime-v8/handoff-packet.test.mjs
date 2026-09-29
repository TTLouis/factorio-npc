import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHandoffPacket,
  estimateTokens,
  HANDOFF_PACKET_LIMITS,
  sanitizeHandoffNote,
} from './handoff-packet.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  getContextRestages,
  PLANNING_EVENT,
} from './planning-state.mjs'

const GOAL_ID = 'goal_handoff'

function goalState() {
  let state = applyPlanningEvent(createEmptyPlanningState(), {
    type: PLANNING_EVENT.GOAL_ACCEPTED,
    now: 10,
    goal_id: GOAL_ID,
    owner: 'louis',
    objective: 'Get power going and run a drill',
    constraints: ['do not remove player buildings'],
  })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.GOAL_DEFINED,
    now: 11,
    source: 'main_planner',
    goal_id: GOAL_ID,
    definition: {
      scope: 'long_horizon',
      summary: 'Run a drill on a powered network.',
      doneWhen: [
        { id: 'drill_on', kind: 'electric_network_satisfied', entity_name: 'electric-mining-drill', minimum: 1 },
        { id: 'plates', kind: 'items_produced', item_name: 'iron-plate', minimum: 100 },
      ],
    },
  })
  return applyPlanningEvent(state, {
    type: PLANNING_EVENT.ROADMAP_REVISED,
    now: 12,
    source: 'user',
    reason: 'initial shelf',
    nodes: [
      { id: 'node_power', intent: 'reach steam power', status: 'ready_to_refine' },
      { id: 'node_science', intent: 'automate red science', depends_on: ['node_power'] },
    ],
  })
}

function committedState() {
  const drafted = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    roadmap_node_ids: ['node_power'],
    steps: [
      { description: 'Mine stone and craft a boiler' },
      { description: 'Place the steam engine and offshore pump' },
      { description: 'Connect the drill to the pole' },
    ],
  })
  return applyPlanningEvent(drafted, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now: 30,
    plan_id: getActivePlan(drafted).plan_id,
    runtime_validation: { passed: true },
  })
}

function withReceipts(state, count) {
  let next = state
  for (let i = 1; i <= count; i++) {
    next = applyPlanningEvent(next, {
      type: PLANNING_EVENT.OPERATION_RECEIPT_RECORDED,
      now: 100 + i,
      source: 'runtime',
      goal_id: GOAL_ID,
      kind: 'operation_receipt',
      ref: `batch_${i}`,
      summary: JSON.stringify({ outcome: 'completed', task_types: ['mine_resource'], batch_id: i }),
    })
  }
  return next
}

function closeActiveStep(state, now) {
  const plan = getActivePlan(state)
  const stepId = plan.steps[plan.active_step_index].step_id
  const withEvidence = applyPlanningEvent(state, {
    type: PLANNING_EVENT.STEP_EVIDENCE_ACCEPTED,
    now,
    plan_id: plan.plan_id,
    step_id: stepId,
    evidence: { source: 'runtime', kind: 'deterministic_verification', ref: `ev_${now}`, batch_id: 1, satisfied_requirement_ids: [] },
  })
  return applyPlanningEvent(withEvidence, { type: PLANNING_EVENT.STEP_COMPLETED, now: now + 1, source: 'runtime', plan_id: plan.plan_id, step_id: stepId })
}

const ARGS = { role: 'executor', checkpoint: 'C3', reason: 'plan_committed', previousContextChars: 41000, now: 500 }

const GOLDEN = [
  '[HANDOFF] Rebuilt from durable harness state, not from the previous conversation. Verify against the world before acting.',
  '--- plan block (stable while this plan runs) ---',
  'goal_id: goal_handoff',
  'goal: Get power going and run a drill',
  'constraint: do not remove player buildings',
  'scope: long_horizon; Run a drill on a powered network.',
  'done_when drill_on: 1 × electric-mining-drill powered by a running electric network',
  'done_when plates: 100 × iron-plate produced from now on (all surfaces)',
  'roadmap_node: node_power: reach steam power',
  'plan: goal_handoff_p3 v1',
  'step 1: goal_handoff_p3_v1_s1_07uwmit | Mine stone and craft a boiler',
  'step 2: goal_handoff_p3_v1_s2_0hwfnhu | Place the steam engine and offshore pump',
  'step 3: goal_handoff_p3_v1_s3_13fxxg4 | Connect the drill to the pole',
  '--- step block ---',
  'restage: role=executor checkpoint=C3 reason=plan_committed',
  'plan_status: COMMITTED; steps 1:active 2:pending 3:pending',
  'active_step: 1 of 3 goal_handoff_p3_v1_s1_07uwmit | Mine stone and craft a boiler | batches=0 evidence=0',
  'receipt #1 operation_receipt batch_1: outcome=completed; types=mine_resource',
  'receipt #2 operation_receipt batch_2: outcome=completed; types=mine_resource',
  'loaded_skills: steam-power, pole-wiring',
  'budget: effort low, 6000 output units per turn, 4 handoffs left',
  'note (UNVERIFIED, written by the ending conversation; never the only source of state): boiler needs stone first',
].join('\n')

function fixed(overrides = {}) {
  const base = withReceipts(committedState(), 2)
  const state = { ...base, plans: base.plans.map(item => ({ ...item, loaded_skill_ids: ['steam-power', 'pole-wiring'] })) }
  const golden = GOLDEN
  return { state, golden, packet: buildHandoffPacket({
    planningState: state,
    ...ARGS,
    budget: 'effort low, 6000 output units per turn, 4 handoffs left',
    note: 'boiler needs stone first',
    ...overrides,
  }) }
}

test('golden packet text for a fixed reducer state', () => {
  const { packet, golden } = fixed()
  assert.equal(packet.text, golden)
  assert.equal(packet.chars, packet.text.length)
  assert.deepEqual(packet.dropped, [])
  assert.equal(packet.over_limit, false)
})

test('same input gives the same text, hash and handoff id; the id moves with checkpoint and time only', () => {
  const first = fixed().packet
  const second = fixed().packet
  assert.equal(first.text, second.text)
  assert.equal(first.hash, second.hash)
  assert.equal(first.handoff_id, second.handoff_id)
  assert.match(first.hash, /^[0-9a-f]{16}$/)
  const later = fixed({ now: 501 }).packet
  assert.equal(later.hash, first.hash, 'time never enters the text')
  assert.notEqual(later.handoff_id, first.handoff_id, 'each restage gets its own id')
  assert.notEqual(fixed({ checkpoint: 'C4' }).packet.handoff_id, first.handoff_id)
})

test('the plan block is byte-stable across step restages, only the step block changes', () => {
  const { state } = fixed()
  const before = buildHandoffPacket({ planningState: state, ...ARGS, checkpoint: 'C4' })
  const moreReceipts = withReceipts(state, 2)
  const after = buildHandoffPacket({ planningState: moreReceipts, ...ARGS, checkpoint: 'C4', reason: 'later', note: 'x' })
  const planBlock = text => text.split('--- step block ---')[0]
  assert.equal(planBlock(after.text), planBlock(before.text))
  assert.notEqual(after.text, before.text)
})

test('mandatory fields are present with no optional inputs', () => {
  const { text } = buildHandoffPacket({ planningState: committedState(), role: 'planner', checkpoint: 'C1', now: 1 })
  for (const needle of ['goal_id: goal_handoff', 'goal: Get power going', 'done_when drill_on', 'done_when plates', 'plan: goal_handoff_p3 v1', 'step 1:', 'active_step: 1 of 3', 'role=planner checkpoint=C1', 'plan_status: COMMITTED']) {
    assert.ok(text.includes(needle), `missing ${needle}`)
  }
  assert.ok(!text.includes('note'))
  assert.ok(!text.includes('budget'))
  assert.ok(!text.includes('receipt'))
})

test('receipt tail is the last entries of the active step ledger only', () => {
  const state = withReceipts(committedState(), 8)
  const { text } = buildHandoffPacket({ planningState: state, ...ARGS })
  const lines = text.split('\n').filter(line => line.startsWith('receipt #'))
  assert.equal(lines.length, HANDOFF_PACKET_LIMITS.receiptTail)
  assert.ok(lines[0].startsWith('receipt #4 '))
  assert.ok(lines.at(-1).startsWith('receipt #8 '))
})

test('over the limit whole records drop in the fixed order and never truncate mid-record', () => {
  const { state } = fixed()
  const run = maxChars => buildHandoffPacket({
    planningState: state, ...ARGS, note: 'boiler needs stone first', budget: 'effort low', limits: { maxChars },
  })
  const full = run(100000)
  assert.deepEqual(full.dropped, [])

  const noNote = run(full.chars - 1)
  assert.deepEqual(noNote.dropped, ['note'])

  const smaller = run(noNote.chars - 1)
  assert.deepEqual(smaller.dropped, ['note', 'receipt_1'], 'oldest receipt drops first')
  assert.ok(smaller.text.includes('receipt #2 '))

  const tiny = run(1)
  assert.equal(tiny.over_limit, true)
  assert.deepEqual(tiny.dropped, ['note', 'receipt_1', 'receipt_2', 'skills', 'budget', 'roadmap_node', 'step_2', 'step_1'])
  // Mandatory records survive every drop; every surviving line is whole.
  for (const needle of ['goal_id: goal_handoff', 'goal: Get power going', 'done_when drill_on', 'done_when plates', 'plan: goal_handoff_p3 v1', 'step 1:', 'active_step: 1 of 3']) {
    assert.ok(tiny.text.includes(needle), `mandatory ${needle} dropped`)
  }
  for (const line of full.text.split('\n')) {
    if (tiny.text.includes(line.slice(0, 10))) assert.ok(tiny.text.includes(line), `line cut mid-record: ${line}`)
  }
  // Same input, same drops.
  assert.deepEqual(run(1).dropped, tiny.dropped)
  assert.equal(run(1).text, tiny.text)
})

test('the note is sanitized, capped at 500 characters, labelled unverified and never the only state', () => {
  const long = `${'x'.repeat(700)} unit_number: 4242`
  const { text } = buildHandoffPacket({ planningState: committedState(), ...ARGS, note: long })
  const noteLine = text.split('\n').find(line => line.startsWith('note ('))
  const body = noteLine.split('): ')[1]
  assert.equal(body.length, HANDOFF_PACKET_LIMITS.noteChars)
  assert.ok(body.endsWith('…'))
  assert.ok(noteLine.includes('UNVERIFIED'))
  assert.ok(text.includes('active_step: 1 of 3'), 'state is present without relying on the note')

  const cleaned = sanitizeHandoffNote('go to unit_number: 4242 then\n\tmine  "target_unit_number":77 and unit #9')
  assert.ok(!/\b4242\b|\b77\b|#9/.test(cleaned))
  assert.ok(!cleaned.includes('\n'))
  assert.equal(sanitizeHandoffNote(''), '')
})

test('the packet carries only reducer state, no transcript or task board text', () => {
  const state = {
    ...committedState(),
    task_board: { title: 'TASKBOARD-SECRET' },
    messages: [{ role: 'assistant', content: 'TRANSCRIPT-SECRET' }],
  }
  const { text } = buildHandoffPacket({ planningState: state, ...ARGS })
  assert.ok(!text.includes('TASKBOARD-SECRET'))
  assert.ok(!text.includes('TRANSCRIPT-SECRET'))
})

test('a new goal with no committed plan still produces a packet', () => {
  const { text, event } = buildHandoffPacket({ planningState: goalState(), role: 'planner', checkpoint: 'C2', reason: 'shelf_pickup', now: 40, previousContextChars: 0 })
  assert.ok(text.includes('plan: none committed yet'))
  assert.ok(text.includes('active_step: none (no committed plan)'))
  assert.ok(text.includes('roadmap_node (next candidate, not yet refined): node_power: reach steam power'))
  assert.equal(event.plan_id, undefined)
  assert.equal(event.goal_id, GOAL_ID)
})

test('bad role, checkpoint or missing goal throw', () => {
  assert.throws(() => buildHandoffPacket({ planningState: committedState(), role: 'jev', checkpoint: 'C1' }), RangeError)
  assert.throws(() => buildHandoffPacket({ planningState: committedState(), role: 'planner', checkpoint: 'C9' }), RangeError)
  assert.throws(() => buildHandoffPacket({ planningState: createEmptyPlanningState(), role: 'planner', checkpoint: 'C1' }), RangeError)
})

test('the event passes CONTEXT_RESTAGED validation and does not change the reasoning epoch', () => {
  const state = withReceipts(committedState(), 2)
  const { event, chars } = buildHandoffPacket({ planningState: state, ...ARGS })
  assert.equal(event.type, PLANNING_EVENT.CONTEXT_RESTAGED)
  assert.equal(event.role, 'executor')
  assert.equal(event.checkpoint, 'C3')
  assert.equal(event.plan_id, state.active_plan_id)
  assert.equal(event.packet_chars, chars)
  assert.equal(event.previous_context_chars, 41000)
  assert.equal(event.now, 500)
  const next = applyPlanningEvent(state, event)
  assert.notEqual(next, state, 'reducer accepted it')
  assert.deepEqual(getContextRestages(next), [{
    goal_id: GOAL_ID,
    plan_id: state.active_plan_id,
    role: 'executor',
    checkpoint: 'C3',
    reason: 'plan_committed',
    packet_chars: chars,
    previous_context_chars: 41000,
    at: 500,
  }])
  assert.equal(next.reasoning_epoch, state.reasoning_epoch)
  assert.equal(next.last_reasoning_reset, state.last_reasoning_reset)
  assert.equal(next.sequence, state.sequence)
})

test('stableText is byte-identical for one plan at different steps and holds nothing volatile', () => {
  const step1 = withReceipts(committedState(), 2)
  const step2 = closeActiveStep(step1, 200)
  const step3 = withReceipts(closeActiveStep(step2, 300), 1)
  assert.equal(getActivePlan(step3).active_step_index, 2)
  const build = (state, overrides = {}) => buildHandoffPacket({ planningState: state, ...ARGS, ...overrides })
  const a = build(step1, { checkpoint: 'C3', now: 500 })
  const b = build(step2, { checkpoint: 'C4', now: 900, note: 'moved on', budget: 'effort low', reason: 'step_closed' })
  const c = build(step3, { role: 'planner', checkpoint: 'C8', now: 1300, previousContextChars: 5 })
  assert.equal(b.stableText, a.stableText)
  assert.equal(c.stableText, a.stableText)
  assert.ok(Buffer.from(a.stableText).equals(Buffer.from(c.stableText)))
  // The volatile tail is where the step moves.
  assert.notEqual(a.volatileText, b.volatileText)
  assert.ok(b.volatileText.includes('steps 1:completed 2:active 3:pending'))
  assert.ok(c.volatileText.includes('steps 1:completed 2:completed 3:active'))
  // Nothing per-call or live in the stable prefix.
  for (const packet of [a, b, c]) {
    assert.ok(!packet.stableText.includes(packet.handoff_id))
    assert.ok(!/pending|completed|receipt|note|budget|role=|checkpoint=|COMMITTED|EXECUTING/.test(packet.stableText), packet.stableText)
    assert.equal(packet.text, `${packet.stableText}\n${packet.volatileText}`)
    assert.ok(packet.text.startsWith(packet.stableText))
  }
})

test('the packet reports an estimated token count of ceil(chars / 4)', () => {
  const { chars, estimated_tokens: tokens } = buildHandoffPacket({ planningState: committedState(), ...ARGS })
  assert.equal(tokens, Math.ceil(chars / 4))
  assert.equal(estimateTokens(0), 0)
  assert.equal(estimateTokens(9), 3)
})
