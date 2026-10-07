import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHandoffPacket,
  deriveResidualNeeds,
  estimateTokens,
  HANDOFF_PACKET_LIMITS,
  executorFactsRefreshMessage,
  neededItems,
  normalizeRecipeFact,
  parseInventoryCounts,
  recipeFactFromRequiresMachine,
  recipeFactLine,
  sanitizeHandoffNote,
  selectRecipeFacts,
  stepContractNeeds,
  researchPathFact,
  researchFactItems,
} from './handoff-packet.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  getContextRestages,
  PLANNING_EVENT,
} from './planning-state.mjs'

const GOAL_ID = 'goal_handoff'

test('research contracts declare technology subjects without inventing item quantities or intent for any contracts', () => {
  assert.deepEqual(stepContractNeeds({ completion_contract: { mode: 'any', requirements: [
    { kind: 'research_completed', technology: 'electronics' }, { kind: 'research_completed', technology: 'steam-power' },
  ] } }), { roots: [], items: [], technologies: ['electronics', 'steam-power'] })
})

test('research paths keep exact engine triggers and reject missing, wrong-target and oversized evidence', () => {
  const path = { ok: true, target: 'electronics', node_count: 1, nodes: [
    { name: 'electronics', researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item: 'copper-plate', count: 10 } },
  ] }
  const fact = researchPathFact(path, 'electronics', { epoch: 1 })
  assert.equal(fact.state, 'fresh')
  assert.equal(fact.nodes[0].research_trigger.count, 10)
  assert.deepEqual(researchFactItems([fact]), ['copper-plate'])
  for (const malformed of [{}, { ...path, target: 'other' }, { ...path, node_count: 9 }, { ...path, truncated: true },
    { ...path, nodes: [{ ...path.nodes[0], research_trigger: undefined }] },
    { ...path, nodes: [{ ...path.nodes[0], prerequisites: ['x'.repeat(1700)] }] }]) {
    const rejected = researchPathFact(malformed, 'electronics', { epoch: 1 })
    assert.equal(rejected.state, 'unavailable')
    assert.equal(rejected.nodes, undefined)
    assert.deepEqual(researchFactItems([rejected]), [])
  }
})

test('research coverage records survive packet trimming and deferred refresh labels missing reads explicitly', () => {
  const state = circuitState()
  const fact = { target: 'electronics', state: 'unavailable', reason: 'research_path_read_failed' }
  const packet = buildHandoffPacket({ planningState: state, ...ARGS, role: 'executor', executorFacts: { research: [fact] }, limits: { maxChars: 100 } })
  assert.match(packet.text, /research_path_read_failed/)
  assert.deepEqual(packet.executor_facts.missing_research, ['electronics'])
  assert.equal(packet.over_limit, true)
  assert.match(executorFactsRefreshMessage({ research: [fact] }), /research_path_read_failed/)
})

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
  'active_step: 1 of 3 goal_handoff_p3_v1_s1_07uwmit | Mine stone and craft a boiler | batches=0 accepted_for_close=0',
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
  const { event, chars, handoff_id } = buildHandoffPacket({ planningState: state, ...ARGS })
  assert.equal(event.handoff_id, handoff_id, 'the ledger links to the trace id')
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
    handoff_id,
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

// --- U8: actor snapshot, runtime state and the active step contract (step block only) ---

function contractState() {
  const drafted = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    roadmap_node_ids: ['node_power'],
    steps: [
      { description: 'Mine stone and craft a boiler', completion_contract: { mode: 'all', requirements: [{ id: 'boiler', kind: 'inventory_count', item_name: 'boiler', minimum: 1 }] } },
      { description: 'Place the steam engine and offshore pump' },
    ],
  })
  return applyPlanningEvent(drafted, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now: 30,
    plan_id: getActivePlan(drafted).plan_id,
    runtime_validation: { passed: true },
  })
}

const ACTOR = { actor_id: 19, actor_kind: 'standalone_character', epoch: 4, connected_players: 0, position: { x: 1, y: 2 }, secret: 'not-whitelisted' }
const RUNTIME = { task_state: 'idle', queue_length: 0, idle: true, last_operations: [{ unit_number: 4242 }] }

test('golden step block with the actor snapshot, runtime state and active step contract; the plan block is untouched', () => {
  const state = contractState()
  const plain = buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C7', reason: 'recovery:actor_replaced', now: 500 })
  const packet = buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C7', reason: 'recovery:actor_replaced', actor: ACTOR, runtime: RUNTIME, now: 500 })
  assert.equal(packet.stableText, plain.stableText, 'stableText is byte-identical with or without the new fields')
  assert.equal(packet.volatileText, [
    '--- step block ---',
    'restage: role=planner checkpoint=C7 reason=recovery:actor_replaced',
    'actor: actor_id=19 actor_kind=standalone_character epoch=4 connected_players=0',
    'plan_status: COMMITTED; steps 1:active 2:pending',
    `active_step: 1 of 2 ${getActivePlan(state).steps[0].step_id} | Mine stone and craft a boiler | batches=0 accepted_for_close=0`,
    'active_step_contract: all: inventory_count boiler>=1',
    'runtime: task_state=idle queue_length=0 idle=true',
  ].join('\n'))
  assert.ok(!packet.text.includes('4242') && !packet.text.includes('not-whitelisted') && !packet.text.includes('position'), 'only whitelisted scalar fields enter')
  assert.doesNotMatch(packet.stableText, /actor|runtime|contract|epoch/, 'nothing volatile in the stable block')
})

test('the actor line is mandatory when supplied, the runtime and contract lines drop whole before steps (the contract goes before the roadmap node)', () => {
  const state = contractState()
  const run = maxChars => buildHandoffPacket({ planningState: state, role: 'planner', checkpoint: 'C7', now: 1, actor: ACTOR, runtime: RUNTIME, budget: 'effort low', limits: { maxChars } })
  const full = run(100000)
  assert.deepEqual(full.dropped, [])
  const tiny = run(1)
  assert.deepEqual(tiny.dropped, ['runtime', 'budget', 'contract', 'roadmap_node', 'step_1'], 'fixed order; the pending step drops last, the active step never')
  assert.ok(tiny.text.includes('actor: actor_id=19'), 'the actor snapshot is never dropped')
})

// --- D2: executor facts (recipe records, fresh/stale counts, residual needs, authority and history labels) ---

function circuitState() {
  const drafted = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    roadmap_node_ids: ['node_power'],
    steps: [
      { description: 'Craft 10 electronic circuits for the lab', completion_contract: { mode: 'all', requirements: [{ id: 'circuits', kind: 'inventory_count', item_name: 'electronic-circuit', minimum: 10 }] } },
      { description: 'Craft the lab' },
    ],
  })
  const committed = applyPlanningEvent(drafted, {
    type: PLANNING_EVENT.PLAN_COMMITTED,
    now: 30,
    plan_id: getActivePlan(drafted).plan_id,
    runtime_validation: { passed: true },
  })
  return withReceipts(committed, 2)
}

const TAG = { tick: 612, epoch: 3, actor_id: 19, at_ms: 1_700_000_000_000 }
const recipeFact = (name, ingredients, products, extra = {}) => normalizeRecipeFact({
  name,
  energy: 0.5,
  categories: ['crafting'],
  ingredients: ingredients.map(([ingredient, amount]) => ({ type: 'item', name: ingredient, amount })),
  products: products.map(([product, amount]) => ({ type: 'item', name: product, amount })),
  machines: ['assembling-machine-1', 'assembling-machine-2'],
  ...extra,
}, { source: 'getRecipeDetails', tag: TAG })
const LAB = recipeFact('lab', [['electronic-circuit', 10], ['iron-gear-wheel', 10], ['transport-belt', 4]], [['lab', 1]])
const CIRCUIT = recipeFact('electronic-circuit', [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]])
const CABLE = recipeFact('copper-cable', [['copper-plate', 1]], [['copper-cable', 2]])
const GEAR = recipeFact('iron-gear-wheel', [['iron-plate', 2]], [['iron-gear-wheel', 1]])
const heldOf = entries => new Map(Object.entries(entries))

const FRESH_FACTS = () => ({
  recipes: [LAB, CIRCUIT, CABLE],
  counts: {
    items: [{ item: 'electronic-circuit', count: 0, state: 'fresh' }, { item: 'copper-plate', count: 10, state: 'fresh' }],
    unavailable: [],
    as_of: TAG,
  },
  residual: { roots: [{ item: 'electronic-circuit', count: 10 }], rows: deriveResidualNeeds({ roots: [{ item: 'electronic-circuit', count: 10 }], recipes: [CIRCUIT, CABLE], held: heldOf({ 'electronic-circuit': 0, 'iron-plate': 0, 'copper-cable': 0, 'copper-plate': 10 }) }).rows },
  historical_entities: [{ name: 'stone-furnace', count: 2, tick: 600 }],
})

test('D2: a recipe record is carried tagged and bounded, and the plan block and a packet without facts do not change', () => {
  const state = circuitState()
  const plain = buildHandoffPacket({ planningState: state, ...ARGS })
  const withFacts = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: FRESH_FACTS() })
  assert.equal(withFacts.stableText, plain.stableText, 'the cache-friendly plan block is byte-identical')
  assert.ok(Buffer.from(withFacts.stableText).equals(Buffer.from(plain.stableText)))
  assert.equal(plain.executor_facts, undefined, 'no facts, no summary')
  assert.ok(!plain.text.includes('recipe_fact'))
  const line = withFacts.text.split('\n').find(item => item.startsWith('recipe_fact lab '))
  assert.equal(line, 'recipe_fact lab (stable recipe data, source=getRecipeDetails, as_of=tick:612,epoch:3): categories=crafting | energy=0.5 | ingredients=10 electronic-circuit + 10 iron-gear-wheel + 4 transport-belt | products=1 lab | machines=assembling-machine-1,assembling-machine-2')
  assert.equal(withFacts.executor_facts.recipe_facts, 3)
  assert.ok(withFacts.volatileText.includes('recipe_fact'), 'recipe facts live in the step block')

  // Bounded: at most five records, each within its character bound, an over-long recipe is marked incomplete, bad names are refused.
  const many = Array.from({ length: 9 }, (_, index) => recipeFact(`widget-${index}`, [['iron-plate', 1]], [[`widget-${index}`, 1]]))
  const crowded = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: { recipes: selectRecipeFacts(many, { wanted: ['widget-3'], limit: 5 }) }, limits: { maxChars: 100000 } })
  const lines = crowded.text.split('\n').filter(item => item.startsWith('recipe_fact '))
  assert.equal(lines.length, 5)
  assert.ok(lines[0].startsWith('recipe_fact widget-3 '), 'a recipe producing a named item comes first')
  for (const item of lines) assert.ok(item.length <= 340)
  const big = recipeFact('big', Array.from({ length: 12 }, (_, index) => [`part-${index}`, 1]), [['big', 1]])
  assert.equal(big.complete, false)
  assert.equal(big.ingredients.length, 8)
  assert.ok(recipeFactLine(big).includes('incomplete'))
  assert.equal(normalizeRecipeFact({ name: 'Bad Name', ingredients: [{ name: 'x', amount: 1 }] }), undefined)
  assert.equal(normalizeRecipeFact({ name: 'ok', ingredients: [], products: [] }), undefined)
})

test('D2: recipe facts, counts and residual needs drop whole in the fixed order, above the note and below the mandatory records', () => {
  const state = circuitState()
  const run = maxChars => buildHandoffPacket({ planningState: state, ...ARGS, note: 'a note', budget: 'effort low', executorFacts: FRESH_FACTS(), actor: ACTOR, limits: { maxChars } })
  const full = run(100000)
  assert.deepEqual(full.dropped, [])
  const tiny = run(1)
  assert.equal(tiny.over_limit, true)
  const order = tiny.dropped
  const at = key => order.findIndex(item => item === key || item.startsWith(key))
  for (const [first, second] of [
    ['note', 'historical_entities'],
    ['historical_entities', 'receipt_1'],
    ['receipt_2', 'budget'],
    ['budget', 'recipe_fact_2'],
    ['recipe_fact_2', 'recipe_fact_0'],
    ['recipe_fact_0', 'contract'],
    ['contract', 'held_counts'],
    ['held_counts', 'residual_needs'],
    ['residual_needs', 'roadmap_node'],
  ]) {
    assert.ok(at(first) >= 0 && at(second) >= 0, `${first} and ${second} dropped`)
    assert.ok(at(first) < at(second), `${first} drops before ${second}: ${order.join(', ')}`)
  }
  // Mandatory records survive every drop: the authority fields, the active step, the actor line.
  for (const needle of ['authority: active_step=', 'active_step: 1 of 2', 'actor: actor_id=19']) assert.ok(tiny.text.includes(needle), `mandatory ${needle} dropped`)
  assert.ok(!order.includes('executor_authority'))
  // Same input, same drops, and every surviving line is whole.
  assert.deepEqual(run(1).dropped, order)
  for (const line of full.text.split('\n')) {
    if (tiny.text.includes(line.slice(0, 12))) assert.ok(tiny.text.includes(line), `cut mid-record: ${line}`)
  }
  // A limit just under the full packet drops only the optional note.
  assert.deepEqual(run(full.chars - 1).dropped, ['note'])
})

test('D2: counts are labelled fresh or stale with their tick, a failed read never shows as current, and a missing value says so', () => {
  const state = circuitState()
  const facts = {
    counts: {
      items: [
        { item: 'copper-plate', count: 10, state: 'fresh' },
        { item: 'iron-plate', count: 4, state: 'stale', tick: 300, epoch: 3, reason: 'fresh_read_failed' },
      ],
      unavailable: ['coal'],
      as_of: TAG,
    },
    machine: { state: 'stale', facts: { unit_number: 55, name: 'stone-furnace', working: true, inventories: { input: { 'copper-ore': 3 } } }, as_of: { tick: 300, epoch: 3 }, reason: 'fresh_read_failed' },
  }
  const { text } = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: facts })
  assert.ok(text.includes('held_counts (fresh live read of the actor inventory, as_of=tick:612,epoch:3): copper-plate=10'))
  const stale = text.split('\n').find(line => line.startsWith('held_counts_STALE'))
  assert.ok(stale.includes('NOT current'))
  assert.ok(stale.includes('iron-plate=4 (observed tick:300,epoch:3, fresh_read_failed)'))
  assert.ok(stale.includes('no value: coal'))
  assert.ok(!stale.includes('copper-plate'), 'a fresh item is never listed as stale')
  const fresh = text.split('\n').find(line => line.startsWith('held_counts '))
  assert.ok(!fresh.includes('iron-plate'), 'a stale item is never listed as fresh')
  const machine = text.split('\n').find(line => line.startsWith('checkpoint_machine'))
  assert.ok(machine.startsWith('checkpoint_machine_STALE (earlier observation as_of=tick:300,epoch:3, NOT current; fresh_read_failed)'))
  const freshMachine = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: { machine: { state: 'fresh', facts: { unit_number: 55, name: 'stone-furnace', working: true, checkpoint: { current: 3, minimum: 10, satisfied: false } }, as_of: TAG } } }).text
  assert.ok(freshMachine.includes('checkpoint_machine (fresh live read, as_of=tick:612,epoch:3): {"unit_number":55,"name":"stone-furnace","working":true,"checkpoint":{"current":3,"minimum":10,"satisfied":false}}'))
})

test('D2: residual needs use shared stock once and recipe output quantities, and are omitted rather than guessed', () => {
  const circuits = [{ item: 'electronic-circuit', count: 10 }]
  const rows = (roots, recipes, held) => {
    const result = deriveResidualNeeds({ roots, recipes, held: heldOf(held) })
    assert.equal(result.ok, true, JSON.stringify(result))
    return Object.fromEntries(result.rows.map(row => [row.item, row]))
  }

  // Copper-cable yields 2 per craft: 30 cable is 15 crafts, so 15 plates, and 10 held plates leave 5 missing.
  const base = rows(circuits, [CIRCUIT, CABLE], { 'electronic-circuit': 0, 'iron-plate': 0, 'copper-cable': 0, 'copper-plate': 10 })
  assert.deepEqual(base['electronic-circuit'], { item: 'electronic-circuit', required: 10, held: 0, missing: 10, crafts: 10, recipe: 'electronic-circuit' })
  assert.deepEqual(base['copper-cable'], { item: 'copper-cable', required: 30, held: 0, missing: 30, crafts: 15, recipe: 'copper-cable' })
  assert.deepEqual(base['copper-plate'], { item: 'copper-plate', required: 15, held: 10, missing: 5 })
  assert.deepEqual(base['iron-plate'], { item: 'iron-plate', required: 10, held: 0, missing: 10 })

  // An odd cable demand rounds the crafts up; held intermediates cut the crafts first.
  const odd = rows([{ item: 'copper-cable', count: 31 }], [CABLE], { 'copper-cable': 0, 'copper-plate': 0 })
  assert.equal(odd['copper-cable'].crafts, 16)
  assert.equal(odd['copper-plate'].required, 16)
  const partial = rows(circuits, [CIRCUIT, CABLE], { 'electronic-circuit': 4, 'iron-plate': 0, 'copper-cable': 0, 'copper-plate': 0 })
  assert.equal(partial['electronic-circuit'].crafts, 6)
  assert.equal(partial['copper-cable'].required, 18)
  assert.equal(partial['copper-plate'].required, 9)
  const covered = rows(circuits, [CIRCUIT, CABLE], { 'electronic-circuit': 12, 'iron-plate': 0, 'copper-cable': 0, 'copper-plate': 0 })
  assert.deepEqual(Object.keys(covered), ['electronic-circuit'], 'enough held: nothing below it is needed')
  assert.equal(covered['electronic-circuit'].missing, 0)

  // Shared stock: iron plate is needed by the circuits (10) and by the gears (2 each, 5 gears = 10): 20 in all, taken once.
  const shared = rows([...circuits, { item: 'iron-gear-wheel', count: 5 }], [CIRCUIT, CABLE, GEAR], { 'electronic-circuit': 0, 'iron-gear-wheel': 0, 'iron-plate': 12, 'copper-cable': 0, 'copper-plate': 0 })
  assert.equal(shared['iron-plate'].required, 20)
  assert.equal(shared['iron-plate'].held, 12)
  assert.equal(shared['iron-plate'].missing, 8, 'not counted once per consumer (which would hide the shortfall)')

  // Unknown inputs: no row is invented.
  assert.deepEqual(deriveResidualNeeds({ roots: circuits, recipes: [CIRCUIT, CABLE], held: heldOf({ 'electronic-circuit': 0 }) }), { ok: false, reason: 'held_unknown:iron-plate' })
  assert.deepEqual(deriveResidualNeeds({ roots: [], recipes: [CIRCUIT], held: heldOf({}) }), { ok: false, reason: 'no_contract_roots' })
  // No recipe known: the contract item itself is still a row (required, held, missing), nothing more.
  const bare = rows([{ item: 'copper-plate', count: 10 }], [], { 'copper-plate': 3 })
  assert.deepEqual(bare['copper-plate'], { item: 'copper-plate', required: 10, held: 3, missing: 7 })
  // Recipes that cannot be counted exactly are not expanded: fluid ingredient, probabilistic product, incomplete, ambiguous, catalyst.
  const fluid = recipeFact('oil-thing', [['iron-plate', 1]], [['oil-thing', 1]], { ingredients: [{ type: 'item', name: 'iron-plate', amount: 1 }, { type: 'fluid', name: 'water', amount: 5 }] })
  const chance = normalizeRecipeFact({ name: 'lucky', ingredients: [{ name: 'iron-plate', amount: 1 }], products: [{ name: 'lucky', amount_min: 1, amount_max: 2 }] }, { tag: TAG })
  const catalyst = recipeFact('loop-thing', [['loop-thing', 1], ['iron-plate', 1]], [['loop-thing', 2]])
  const twin = [recipeFact('alt-a', [['iron-plate', 1]], [['alt-target', 1]]), recipeFact('alt-b', [['copper-plate', 1]], [['alt-target', 1]])]
  const bigRecipe = recipeFact('big', Array.from({ length: 12 }, (_, index) => [`part-${index}`, 1]), [['big', 1]])
  for (const [item, recipes] of [['oil-thing', [fluid]], ['lucky', [chance]], ['big', [bigRecipe]], ['alt-target', twin], ['loop-thing', [catalyst]]]) {
    const result = rows([{ item, count: 4 }], recipes, { [item]: 1 })
    assert.deepEqual(Object.keys(result), [item], `${item} is a leaf row only`)
  }
  // A cycle between two recipes is refused outright.
  const ping = recipeFact('ping', [['pong', 1]], [['ping', 1]])
  const pong = recipeFact('pong', [['ping', 1]], [['pong', 1]])
  assert.deepEqual(deriveResidualNeeds({ roots: [{ item: 'ping', count: 1 }], recipes: [ping, pong], held: heldOf({ ping: 0, pong: 0 }) }), { ok: false, reason: 'recipe_cycle' })

  // The contract decides the roots: a mode `any` contract names none, an entity-inventory requirement is not actor stock.
  assert.deepEqual(stepContractNeeds({ completion_contract: { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }, { kind: 'entity_inventory_count', item_name: 'iron-plate', unit_number: 5, minimum: 4 }] } }), { roots: [{ item: 'copper-plate', count: 10 }], items: ['copper-plate', 'iron-plate'] })
  assert.deepEqual(stepContractNeeds({ completion_contract: { mode: 'any', requirements: [{ kind: 'inventory_count', item_name: 'copper-plate', minimum: 10 }] } }).roots, [])
  assert.deepEqual(stepContractNeeds({}), { roots: [], items: [] })
  assert.deepEqual(neededItems([{ item: 'electronic-circuit', count: 1 }], [CIRCUIT, CABLE]).items, ['electronic-circuit', 'iron-plate', 'copper-cable', 'copper-plate'])
  assert.equal(neededItems([{ item: 'electronic-circuit', count: 1 }], [CIRCUIT, CABLE], 2).complete, false)
})

test('D2: the residual record names the contract and its rows; the authority record labels the committed step and history', () => {
  const state = circuitState()
  const { text, executor_facts: summary } = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: FRESH_FACTS() })
  const residual = text.split('\n').find(line => line.startsWith('residual_needs'))
  assert.equal(residual, 'residual_needs (derived from recipe_fact and fresh held_counts for the step contract electronic-circuit>=10; shared stock counted once): electronic-circuit required=10 held=0 missing=10 crafts=10 via electronic-circuit | iron-plate required=10 held=0 missing=10 | copper-cable required=30 held=0 missing=30 crafts=15 via copper-cable | copper-plate required=15 held=10 missing=5')
  const authority = text.split('\n').find(line => line.startsWith('authority:'))
  const stepId = getActivePlan(state).steps[0].step_id
  assert.equal(authority, `authority: active_step=${stepId} (committed plan) contract=all (committed) latest_receipt=#2 operation_receipt batch_2 (this step) entity_ids_in_receipts_and_snapshots=historical_observations`)
  assert.ok(text.includes('active_step_contract: all: inventory_count electronic-circuit>=10'), 'the committed contract is present')
  assert.ok(text.includes('receipt #2 operation_receipt batch_2'), 'the latest correlated receipt is present')
  assert.deepEqual(summary, { recipe_facts: 3, fresh_items: 2, stale_items: 0, residual_needs: 4, machine: 'none', historical_entity_kinds: 1 })
})

test('D2: historical entity observations are labelled, carry their tick and withhold exact ids', () => {
  const state = circuitState()
  const { text } = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: { historical_entities: [{ name: 'stone-furnace', count: 2, tick: 600, unit_number: 4242 }, { name: 'wooden-chest', count: 1 }] } })
  const line = text.split('\n').find(item => item.startsWith('historical_entities'))
  assert.equal(line, 'historical_entities (earlier observations, NOT current exact targets; ids withheld): stone-furnace x2 (tick:600) | wooden-chest x1')
  assert.ok(!text.includes('4242'))
})

test('D2: inventory text parses from JSON and from the serpent block the game prints, and anything else is refused', () => {
  assert.deepEqual([...parseInventoryCounts('[{"name":"copper-plate","count":10},{"name":"coal","count":2}]')], [['copper-plate', 10], ['coal', 2]])
  const serpent = '{\n  {\n    count = 10,\n    name = "copper-plate"\n  },\n  {\n    count = 2,\n    name = "coal"\n  }\n}'
  assert.deepEqual([...parseInventoryCounts(serpent)], [['copper-plate', 10], ['coal', 2]])
  assert.deepEqual([...parseInventoryCounts('{ { name = "iron-plate", count = 3 } }')], [['iron-plate', 3]], 'either field order')
  assert.equal(parseInventoryCounts('{}').size, 0, 'an empty inventory is a valid empty answer')
  assert.equal(parseInventoryCounts('no controlled actor'), undefined)
  assert.equal(parseInventoryCounts(''), undefined)
  assert.equal(parseInventoryCounts('{"found":false}'), undefined)
})

test('D2: a recipe with several item products is a leaf (its crafts would double count the other product)', () => {
  const split = recipeFact('oil-split', [['crude-chunk', 2]], [['light-chunk', 1], ['heavy-chunk', 1]])
  const result = deriveResidualNeeds({ roots: [{ item: 'light-chunk', count: 4 }], recipes: [split], held: heldOf({ 'light-chunk': 0 }) })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rows.map(row => row.item), ['light-chunk'], 'no expansion into crude-chunk')
  // A fluid by-product does not count as a second item product.
  const withFluid = normalizeRecipeFact({ name: 'gear-with-slag', ingredients: [{ name: 'iron-plate', amount: 2 }], products: [{ name: 'iron-gear-wheel', amount: 1 }, { type: 'fluid', name: 'steam', amount: 5 }] }, { tag: TAG })
  const expanded = deriveResidualNeeds({ roots: [{ item: 'iron-gear-wheel', count: 2 }], recipes: [withFluid], held: heldOf({ 'iron-gear-wheel': 0, 'iron-plate': 0 }) })
  assert.deepEqual(expanded.rows.map(row => row.item), ['iron-gear-wheel', 'iron-plate'])
})

test('D2: a requires_machine recipe cut to its first eight ingredients is incomplete and is not expanded', () => {
  const ingredients = Array.from({ length: 8 }, (_, index) => ({ type: 'item', name: `part-${index}`, amount: 1 }))
  const cut = recipeFactFromRequiresMachine({
    recipe: { name: 'big-thing', categories: ['crafting'], energy: 1, ingredients, products: [{ type: 'item', name: 'big-thing', amount: 1 }], ingredients_truncated: true, products_truncated: false },
    machines: { candidates: [{ name: 'assembling-machine-1' }] },
  }, { tag: TAG })
  assert.equal(cut.complete, false)
  assert.ok(recipeFactLine(cut).includes('incomplete'))
  const result = deriveResidualNeeds({ roots: [{ item: 'big-thing', count: 2 }], recipes: [cut], held: heldOf({ 'big-thing': 0 }) })
  assert.deepEqual(result.rows.map(row => row.item), ['big-thing'])
  const whole = recipeFactFromRequiresMachine({
    recipe: { name: 'big-thing', categories: ['crafting'], energy: 1, ingredients, products: [{ type: 'item', name: 'big-thing', amount: 1 }], ingredients_truncated: false, products_truncated: false },
    machines: { candidates: [] },
  }, { tag: TAG })
  assert.equal(whole.complete, true)
})

test('D2: a deferred packet says so and carries no counts, machine or residual; the refresh message carries them in the packet labels', () => {
  const state = circuitState()
  const deferred = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: { recipes: [LAB, CIRCUIT, CABLE], counts: { items: [], unavailable: [], deferred: 'batch_in_flight', as_of: TAG }, historical_entities: [] } })
  assert.ok(deferred.text.includes('counts_deferred=batch_in_flight (an operation batch was sent and has not finished; held_counts, checkpoint_machine and residual_needs are omitted from this packet)'))
  assert.doesNotMatch(deferred.text, /^(held_counts|checkpoint_machine|residual_needs)/m)
  assert.ok(deferred.text.includes('recipe_fact lab '), 'recipe facts stay')
  assert.ok(deferred.text.includes('authority: active_step='), 'authority stays')
  assert.equal(deferred.executor_facts.counts_deferred, 'batch_in_flight')

  const facts = FRESH_FACTS()
  const message = executorFactsRefreshMessage({ counts: facts.counts, residual: facts.residual })
  const lines = message.split('\n')
  assert.ok(lines[0].startsWith('[HARNESS] Executor facts refreshed after the batch receipt landed'))
  assert.ok(lines.some(line => line.startsWith('held_counts (fresh live read of the actor inventory, as_of=tick:612,epoch:3): ')))
  assert.ok(lines.some(line => line.startsWith('residual_needs (derived from recipe_fact and fresh held_counts')))
  assert.ok(!message.includes('recipe_fact lab'), 'only the parts that changed')
  assert.equal(executorFactsRefreshMessage({ counts: { items: [], unavailable: [] } }), '')
  assert.equal(executorFactsRefreshMessage(undefined), '')
})
