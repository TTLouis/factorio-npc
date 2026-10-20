import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildHandoffPacket,
  burnerFuelsFromDetails,
  deriveBuildBill,
  labMachineEntries,
  scienceProductionRoots,
  scienceTargets,
  withLabEnergy,
  deriveFuelNeeds,
  deriveMachineEnergy,
  deriveResidualNeeds,
  expansionRecipeNames,
  HANDOFF_DROP_ORDER,
  machineStatusesFrom,
  mergeRecipeFact,
  recipeFactsFromDetails,
  triggerProductionRoots,
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
  cacheTriggerCraftingReports,
  attachCachedTriggerCrafting,
  EXECUTOR_FACT_LIMITS,
  fluidHintKey,
  fluidSourceHintsFromRead,
  rememberFluidHints,
  expandableIngredients,
  recipeKnownForItem,
  rawLeafFromRecipeDetails,
  rawLeafSourceFromRead,
  withoutRawLeafRecipes,
} from './handoff-packet.mjs'
import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import {
  applyPlanningEvent,
  createEmptyPlanningState,
  getActivePlan,
  getContextRestages,
  MAX_REVIEW_NOTES_CHARS,
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

function triggerCapabilityResearch(item = 'plate-a') {
  return { electronics: { trigger: { type: 'craft-item', item, count: 10 }, trigger_crafting: {
    item, recipes: [{ recipe: 'smelt-a', enabled: true, categories: ['smelting'],
      hand_craftable: false, hand_craftable_reason: 'category_unsupported', craftable_now_count: 123456,
      machines: [{ entity: 'furnace-a', item: 'furnace-a', status: 'craftable' }],
    }],
  } } }
}

function nativeTriggerPath(item = 'plate-a') {
  return researchPathFact({ ok: true, target: 'electronics', node_count: 1, nodes: [
    { name: 'electronics', researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item, count: 10 } },
  ] }, 'electronics', { tick: 900, actor_id: 4, epoch: 2 })
}

test('craft-trigger capability cache survives serialized handoff with historical source/tags and without volatile inventory counts', () => {
  const research = triggerCapabilityResearch()
  const cache = cacheTriggerCraftingReports(research, { tick: 100, actor_id: 4, epoch: 1, at_ms: 1000 })
  assert.equal(cache.length, 1)
  assert.equal(cache[0].state, 'historical')
  assert.equal(cache[0].source, 'goal_requirements')
  assert.deepEqual(cache[0].as_of, { tick: 100, epoch: 1, actor_id: 4, at_ms: 1000 })
  assert.doesNotMatch(JSON.stringify(cache), /craftable_now_count|123456/)
  const fresh = nativeTriggerPath()
  const attached = attachCachedTriggerCrafting(fresh, JSON.parse(JSON.stringify(cache)))
  assert.equal(attached.state, 'fresh')
  assert.equal(attached.as_of.tick, 900)
  assert.deepEqual(attached.nodes[0].research_trigger, fresh.nodes[0].research_trigger)
  const report = attached.nodes[0].trigger_crafting
  assert.equal(report.state, 'historical')
  assert.equal(report.as_of.tick, 100)
  assert.equal(report.as_of.epoch, 1, 'cached actor capability must not inherit the new epoch')
  assert.equal(report.recipes[0].hand_craftable, false)
  assert.equal(report.recipes[0].enabled, true)
  assert.equal(fresh.nodes[0].trigger_crafting, undefined, 'pure augmentation does not alter the native fact')
  assert.match(executorFactsRefreshMessage({ research: [attached] }), /trigger_crafting is cached\/historical, not current admission proof/)
  assert.doesNotMatch(JSON.stringify(attached), /craftable_now_count|123456/)
})

test('craft-trigger handoff never substitutes another item/technology and missing capabilities remain explicit', () => {
  const cache = cacheTriggerCraftingReports(triggerCapabilityResearch(), { epoch: 1 })
  const changed = attachCachedTriggerCrafting(nativeTriggerPath('other-item'), cache)
  assert.equal(changed.nodes[0].trigger_crafting.state, 'unavailable')
  assert.equal(changed.nodes[0].trigger_crafting.reason, 'trigger_crafting_not_reported')
  assert.doesNotMatch(JSON.stringify(changed), /smelt-a|furnace-a|plate-a/)
  const research = triggerCapabilityResearch()
  research.electronics.trigger_crafting.recipes[0].hand_craftable = undefined
  research.electronics.trigger_crafting.recipes[0].hand_craftable_reason = 'actor_categories_unknown'
  const unknown = cacheTriggerCraftingReports(research, {})[0]
  assert.equal(unknown.recipes[0].hand_craftable, 'unknown')
  assert.deepEqual(unknown.as_of, {})
  const unavailable = { target: 'electronics', state: 'unavailable', reason: 'read_failed' }
  assert.equal(attachCachedTriggerCrafting(unavailable, cache), unavailable)
})

test('craft-trigger cache bounds technologies, recipes, categories, machine options and report characters', () => {
  const node = triggerCapabilityResearch().electronics
  const base = node.trigger_crafting.recipes[0]
  const crowded = { ...base, categories: Array.from({ length: 10 }, (_, i) => `category-${i}`),
    machines: Array.from({ length: 20 }, (_, i) => ({ entity: `machine-${i}`, item: `machine-${i}`, status: 'locked', unlocked_by: 'machine-tech' })),
    ignored: 'x'.repeat(10000),
  }
  const research = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`technology-${i}`, { ...node,
    trigger_crafting: { item: 'plate-a', recipes: Array.from({ length: 20 }, (_, j) => ({ ...crowded, recipe: `recipe-${j}` })) },
  }]))
  const cache = cacheTriggerCraftingReports(research, { tick: 1 })
  assert.equal(cache.length, EXECUTOR_FACT_LIMITS.researchNodes)
  for (const report of cache) {
    assert.ok(JSON.stringify(report).length <= EXECUTOR_FACT_LIMITS.researchChars)
    assert.equal(report.truncated, true)
    assert.ok(report.recipes.length > 0 && report.recipes.length <= EXECUTOR_FACT_LIMITS.recipes)
    for (const recipe of report.recipes) {
      assert.equal(recipe.categories.length, EXECUTOR_FACT_LIMITS.recipeProducts)
      assert.equal(recipe.categories_truncated, true)
      assert.equal(recipe.machines.length, EXECUTOR_FACT_LIMITS.recipeMachines)
      assert.equal(recipe.machines_truncated, true)
    }
    assert.doesNotMatch(JSON.stringify(report), /ignored|craftable_now_count/)
  }
})

test('augmented fresh research respects the shared character cap with truthful missing facts instead of truncated native evidence', () => {
  const cache = cacheTriggerCraftingReports(triggerCapabilityResearch(), { tick: 1 })
  const fresh = nativeTriggerPath()
  fresh.nodes[0].prerequisites = ['x'.repeat(EXECUTOR_FACT_LIMITS.researchChars - JSON.stringify(fresh).length - 40)]
  assert.ok(JSON.stringify(fresh).length <= EXECUTOR_FACT_LIMITS.researchChars)
  const snapshot = JSON.stringify(fresh)
  const attached = attachCachedTriggerCrafting(fresh, cache)
  assert.deepEqual(attached, { target: 'electronics', state: 'unavailable', reason: 'research_path_with_trigger_crafting_size_limit' })
  assert.equal(JSON.stringify(fresh), snapshot)
  assert.ok(JSON.stringify(attached).length <= EXECUTOR_FACT_LIMITS.researchChars)
  const ordinary = attachCachedTriggerCrafting(nativeTriggerPath(), cache)
  const packet = buildHandoffPacket({ planningState: circuitState(), ...ARGS, role: 'executor', executorFacts: { research: [ordinary] } })
  assert.match(packet.text, /"state":"historical"/)
  assert.match(packet.text, /smelt-a/)
  assert.doesNotMatch(packet.text, /craftable_now_count/)
})

test('craft-trigger attachment reserves unknown coverage for later nodes before fitting early cached alternatives', () => {
  const research = triggerCapabilityResearch()
  research['next-tech'] = { ...research.electronics, trigger_crafting: { ...research.electronics.trigger_crafting } }
  const cache = cacheTriggerCraftingReports(research, { tick: 1 })
  const first = nativeTriggerPath()
  const fact = { ...first, nodes: [first.nodes[0], { ...first.nodes[0], name: 'next-tech' }] }
  fact.nodes[0].prerequisites = ['x'.repeat(400)]
  const attached = attachCachedTriggerCrafting(fact, cache)
  assert.equal(attached.state, 'fresh', 'bounded missing capability markers must preserve the complete fresh native path')
  assert.equal(attached.nodes.length, 2)
  assert.ok(JSON.stringify(attached).length <= EXECUTOR_FACT_LIMITS.researchChars)
  for (const node of attached.nodes) assert.ok(node.trigger_crafting)
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
  // Same state, same checkpoint, same millisecond: the caller's conversation sequence keeps the ids apart.
  assert.notEqual(fixed({ sequence: 3 }).packet.handoff_id, fixed({ sequence: 4 }).packet.handoff_id)
  assert.equal(fixed({ sequence: 3 }).packet.handoff_id, fixed({ sequence: 3 }).packet.handoff_id)
  assert.equal(fixed({ sequence: undefined }).packet.handoff_id, first.handoff_id, 'a caller without a sequence keeps the earlier ids')
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

test('step contracts: the authority record says contract=pending for an active step whose checkpoint is not bound yet, and shows no contract for it', () => {
  const drafted = applyPlanningEvent(goalState(), {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 20,
    roadmap_node_ids: ['node_power'],
    steps: [
      { description: 'Mine stone and craft a boiler' },
      { description: 'Place the steam engine and offshore pump', completion_mode: 'deterministic', contract_status: 'pending' },
    ],
  })
  const committedPlan = applyPlanningEvent(drafted, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 30, plan_id: getActivePlan(drafted).plan_id, runtime_validation: { passed: true } })
  const state = closeActiveStep(committedPlan, 40)
  assert.equal(getActivePlan(state).steps[getActivePlan(state).active_step_index].contract_status, 'pending')
  const { text } = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: FRESH_FACTS() })
  const authority = text.split('\n').find(line => line.startsWith('authority:'))
  assert.match(authority, /\(committed plan\) contract=pending latest_receipt=/)
  assert.doesNotMatch(authority, /contract=none/)
  assert.equal(text.includes('active_step_contract:'), false, 'a pending step has no contract line')
  // The stable plan block never carries a step contract, bound or not.
  const stable = text.slice(0, text.indexOf('--- step block'))
  assert.doesNotMatch(stable, /inventory_count|contract=/)
})

// --- Unit 3a: historical native fluid-tile anchors --------------------------------------------------------------------

const waterSample = (x, y, extra = {}) => ({ name: 'water', fluid_name: 'water', position: { x, y }, surface_index: 1, ...extra })
const waterAnswer = (samples, extra = {}) => ({
  ok: true, fluid_name: 'water', actor_position: { x: 0, y: 0 }, surface_index: 1, observed_tick: 77, search_radius: 128,
  coverage: 'generated_bounding_square', checked_chunks: 81, matching_tile_prototypes: 2, samples, returned_count: samples.length,
  truncated: false, ordering: 'native_samples_not_nearest', ...extra,
})
const learnWater = (answer, args = { fluid_name: 'water' }) => fluidSourceHintsFromRead(typeof answer === 'string' ? answer : JSON.stringify(answer), args, { epoch: 3, actor_id: 19, at_ms: 5, tick: 9999 })

test('3a: a well-formed native fluid answer yields keyed anchors tagged with the game tick it reports, and nothing else does', () => {
  const learned = learnWater(waterAnswer([waterSample(22, 8), waterSample(-82, -19, { name: 'deepwater' })]))
  assert.deepEqual(learned.anchors.map(fluidHintKey), ['1:22:8', '1:-82:-19'])
  assert.deepEqual(learned.anchors[0], { name: 'water', fluid_name: 'water', surface_index: 1, position: { x: 22, y: 8 }, as_of: { tick: 77, epoch: 3, actor_id: 19, at_ms: 5 } })
  assert.equal(learned.anchors[1].name, 'deepwater')
  // A request that spelled the bounds out is the same request.
  assert.ok(learnWater(waterAnswer([waterSample(1, 1)], { search_radius: 64 }), { fluid_name: 'water', search_radius: 64, limit: 4 }).anchors)

  const good = waterAnswer([waterSample(22, 8)])
  const cases = [
    ['unreadable_or_oversized', 'not json'],
    ['unreadable_or_oversized', 'x'.repeat(EXECUTOR_FACT_LIMITS.fluidReadChars + 1)],
    ['not_a_successful_answer', [good]],
    ['not_a_successful_answer', { ...good, ok: false, code: 'fluid_source_search_unexplored' }],
    ['fluid_name_mismatch', { ...good, fluid_name: 'crude-oil', samples: [waterSample(1, 1, { fluid_name: 'crude-oil' })] }],
    ['coverage_not_declared', { ...good, coverage: 'incomplete' }],
    ['coverage_not_declared', { ...good, coverage: undefined }],
    ['surface_index_invalid', { ...good, surface_index: 0 }],
    ['observed_tick_invalid', { ...good, observed_tick: -1 }],
    ['observed_tick_invalid', { ...good, observed_tick: undefined }],
    ['search_radius_mismatch', { ...good, search_radius: 64 }],
    ['sample_count_inconsistent', { ...good, returned_count: 2 }],
    ['sample_count_inconsistent', { ...good, truncated: undefined }],
    ['sample_count_inconsistent', { ...good, samples: 'tiles', returned_count: 1 }],
    ['sample_invalid', { ...good, samples: [waterSample(22, 8, { fluid_name: 'steam' })] }],
    ['sample_invalid', { ...good, samples: [waterSample(22, 8, { surface_index: 2 })] }],
    ['sample_invalid', { ...good, samples: [waterSample(1.5, 8)] }],
    ['sample_invalid', { ...good, samples: [waterSample(22, 10000257)] }],
    ['sample_invalid', { ...good, samples: [waterSample(22, 8, { name: 'Bad Name' })] }],
    ['no_samples', waterAnswer([])],
    ['no_samples', { ...waterAnswer([]), samples: {} }],
  ]
  for (const [reason, answer] of cases) assert.equal(learnWater(answer).rejected, reason, `${reason}: ${JSON.stringify(answer).slice(0, 80)}`)
  // More samples than the request's limit, a radius the request did not make, a fluid it did not ask for, no request at all.
  assert.equal(learnWater(waterAnswer([waterSample(1, 1), waterSample(2, 2)]), { fluid_name: 'water', limit: 1 }).rejected, 'sample_count_inconsistent')
  assert.equal(learnWater(good, { fluid_name: 'water', search_radius: 64 }).rejected, 'search_radius_mismatch')
  assert.equal(learnWater(good, { fluid_name: 'steam' }).rejected, 'fluid_name_mismatch')
  assert.equal(learnWater(good, null).rejected, 'request_unknown')
})

test('3a: anchors are bounded by count and by serialized size, a re-read moves an anchor, and an empty read erases nothing', () => {
  const store = new Map()
  const remember = (samples, name = 'water') => rememberFluidHints(store, learnWater(waterAnswer(samples.map(([x, y]) => waterSample(x, y, { name })))).anchors)
  remember([[0, 0]])
  remember([[1, 0]])
  assert.deepEqual([...store.keys()], ['1:0:0', '1:1:0'])
  remember([[0, 0]]) // re-read: same key, now the most recent
  assert.deepEqual([...store.keys()], ['1:1:0', '1:0:0'])
  // An empty or failed read yields no anchors to merge: the store is untouched.
  const before = [...store.keys()]
  assert.equal(learnWater(waterAnswer([])).anchors, undefined)
  assert.equal(learnWater('not json').anchors, undefined)
  assert.deepEqual([...store.keys()], before)

  for (let index = 0; index < 40; index++) remember([[index + 10, 0]])
  assert.equal(store.size, EXECUTOR_FACT_LIMITS.fluidHints)
  assert.equal([...store.keys()].at(-1), '1:49:0')
  assert.ok(!store.has('1:0:0') && !store.has('1:1:0'), 'the oldest were evicted')

  // Long names hit the serialized-size bound before the count bound.
  const big = new Map()
  const evicted = rememberFluidHints(big, Array.from({ length: 16 }, (_, index) => ({
    name: `w${'a'.repeat(98)}`, fluid_name: `f${'b'.repeat(98)}`, surface_index: 1, position: { x: index, y: 0 }, as_of: { tick: 1, epoch: 1, actor_id: 1, at_ms: 1_700_000_000_000 },
  })))
  assert.ok(JSON.stringify([...big.values()]).length <= EXECUTOR_FACT_LIMITS.fluidHintStoreChars)
  assert.ok(big.size < 16 && evicted === 16 - big.size)
  assert.ok(big.has('1:15:0'), 'the newest survives')
})

test('3a: the packet lists the anchors as historical, newest first, and they drop before core facts', () => {
  const state = circuitState()
  const anchors = learnWater(waterAnswer([waterSample(22, 8), waterSample(-82, -19)])).anchors
  const facts = { ...FRESH_FACTS(), fluid_source_hints: [...anchors].reverse() }
  const packet = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: facts, limits: { maxChars: 100000 } })
  const line = packet.volatileText.split('\n').find(item => item.startsWith('fluid_source_hints'))
  assert.match(line, /^fluid_source_hints \(HISTORICAL: positions where native fluid tiles were observed earlier, newest first; NOT current, not nearest, not a reachable or legal placement; re-check with getFluidSourceTiles before placing anything\): water:water@\(-82,-19\) surface=1 observed tick:77,epoch:3 \| water:water@\(22,8\) surface=1 observed tick:77,epoch:3$/)
  assert.equal(packet.executor_facts.fluid_source_hints, 2)
  // No hints: no record and no summary field, so a packet without them is unchanged.
  const without = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: FRESH_FACTS(), limits: { maxChars: 100000 } })
  assert.doesNotMatch(without.text, /fluid_source_hints/)
  assert.equal(without.executor_facts.fluid_source_hints, undefined)

  // Drop order: after the note and the history, before receipts and every core fact.
  const tiny = buildHandoffPacket({ planningState: state, ...ARGS, note: 'a note', executorFacts: facts, limits: { maxChars: 1 } }).dropped
  const at = key => tiny.findIndex(item => item === key || item.startsWith(key))
  for (const [first, second] of [['note', 'historical_entities'], ['historical_entities', 'fluid_source_hints'], ['fluid_source_hints', 'receipt_1'], ['fluid_source_hints', 'recipe_fact_2'], ['fluid_source_hints', 'held_counts'], ['fluid_source_hints', 'residual_needs']]) {
    assert.ok(at(first) >= 0 && at(second) >= 0 && at(first) < at(second), `${first} before ${second}: ${tiny.join(', ')}`)
  }
  // A limit just under the full packet drops only the hints when nothing optional ranks below them.
  const lean = { ...facts, historical_entities: [] }
  const full = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: lean, limits: { maxChars: 100000 } })
  const trimmed = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: lean, limits: { maxChars: full.chars - 1 } })
  assert.deepEqual(trimmed.dropped, ['fluid_source_hints'])
  assert.equal(trimmed.executor_facts.fluid_source_hints, 0, 'known but dropped for size')
  assert.doesNotMatch(trimmed.text, /fluid_source_hints/)

  // The rendered record is bounded and says how many did not fit.
  const crowded = Array.from({ length: 16 }, (_, index) => ({ ...anchors[0], name: `w${'a'.repeat(60)}`, position: { x: 1000 + index, y: -1000 - index } }))
  const bounded = buildHandoffPacket({ planningState: state, ...ARGS, executorFacts: { fluid_source_hints: crowded }, limits: { maxChars: 100000 } })
  const boundedLine = bounded.volatileText.split('\n').find(item => item.startsWith('fluid_source_hints'))
  assert.match(boundedLine, /\(\+\d+ more\)$/)
  assert.ok(boundedLine.length < EXECUTOR_FACT_LIMITS.fluidHintChars + 400)
  assert.ok(bounded.executor_facts.fluid_source_hints < 16 && bounded.executor_facts.fluid_source_hints > 0)
})

// --- Unit 3b: recipe completeness and the closure helpers ---------------------------------------------------------------

test('3b: a recipe is complete only when every ingredient and product quantity is a number and every probability is within [0, 1]', () => {
  const make = (ingredients, products) => normalizeRecipeFact({ name: 'widget', ingredients, products }, { tag: TAG })
  const iron = { name: 'iron-plate', amount: 2 }
  const widget = { name: 'widget', amount: 1 }
  assert.equal(make([iron], [widget]).complete, true)
  // A product that reports a min/max pair instead of an amount, or a probability inside [0, 1], is still a reported quantity.
  assert.equal(make([iron], [{ name: 'widget', amount_min: 1, amount_max: 2 }]).complete, true)
  assert.equal(make([iron], [{ ...widget, probability: 0.25 }]).complete, true)
  assert.equal(make([iron], [{ ...widget, probability: 0 }]).complete, true)
  assert.equal(make([iron], [{ ...widget, probability: 1 }]).complete, true)
  assert.equal(make([iron], [{ ...widget, independent_probability: 1 }]).complete, true)
  // An ingredient or product amount that is missing, not a number or not finite makes it incomplete (still shown, never derived from).
  for (const bad of [undefined, null, '2', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(make([{ name: 'iron-plate', amount: bad }], [widget]).complete, false, `ingredient amount ${String(bad)}`)
    assert.equal(make([iron], [{ name: 'widget', amount: bad }]).complete, false, `product amount ${String(bad)}`)
  }
  assert.equal(make([{ name: 'iron-plate' }], [widget]).complete, false)
  assert.equal(make([iron], [{ name: 'widget', amount_min: 1 }]).complete, false, 'a half range is not a quantity')
  // A probability outside [0, 1], or not a number, makes it incomplete.
  for (const bad of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, '0.5']) {
    assert.equal(make([iron], [{ ...widget, probability: bad }]).complete, false, `probability ${String(bad)}`)
    assert.equal(make([iron], [{ ...widget, independent_probability: bad }]).complete, false, `independent_probability ${String(bad)}`)
  }
  const incomplete = make([{ name: 'iron-plate' }], [widget])
  assert.ok(recipeFactLine(incomplete).includes('incomplete'))
  // An incomplete recipe is not expanded by the residual derivation.
  const result = deriveResidualNeeds({ roots: [{ item: 'widget', count: 3 }], recipes: [incomplete], held: heldOf({ widget: 0 }) })
  assert.deepEqual(result.rows.map(row => row.item), ['widget'])
})

test('3b: expandableIngredients names what a derivation would follow, and recipeKnownForItem finds a recipe by name or product', () => {
  assert.deepEqual(expandableIngredients('electronic-circuit', [CIRCUIT, CABLE]), ['iron-plate', 'copper-cable'])
  assert.deepEqual(expandableIngredients('copper-plate', [CIRCUIT, CABLE]), [], 'no recipe fact')
  const fluid = recipeFact('oil-thing', [['iron-plate', 1]], [['oil-thing', 1]], { ingredients: [{ type: 'item', name: 'iron-plate', amount: 1 }, { type: 'fluid', name: 'water', amount: 5 }] })
  assert.deepEqual(expandableIngredients('oil-thing', [fluid]), [], 'a fluid ingredient cannot be counted exactly, so nothing below it is worth reading')
  const big = recipeFact('big', Array.from({ length: 12 }, (_, index) => [`part-${index}`, 1]), [['big', 1]])
  assert.deepEqual(expandableIngredients('big', [big]), [], 'an incomplete recipe is not followed')
  assert.equal(recipeKnownForItem('electronic-circuit', [CIRCUIT]), true)
  assert.equal(recipeKnownForItem('copper-cable', [recipeFact('cable-recipe', [['copper-plate', 1]], [['copper-cable', 2]])]), true, 'by product')
  assert.equal(recipeKnownForItem('copper-plate', [CIRCUIT, CABLE]), false)
  assert.equal(recipeKnownForItem('copper-plate', []), false)
})

test('3b: the step contract shape names recipe roots only through inventory_count; entity checkpoints carry unit numbers, not items to craft', () => {
  const contract = { mode: 'all', requirements: [
    { kind: 'inventory_count', item_name: 'lab', minimum: 1 },
    { kind: 'entity_exists', unit_number: 55 },
    { kind: 'entity_state', unit_number: 55, expected: 'working' },
    { kind: 'entity_inventory_count', unit_number: 55, item_name: 'copper-plate', minimum: 10 },
  ] }
  const needs = stepContractNeeds({ completion_contract: contract })
  assert.deepEqual(needs.roots, [{ item: 'lab', count: 1 }])
  assert.deepEqual(needs.items, ['lab', 'copper-plate'], 'the machine content is a name to count, never a craft root')
})


test('6: mining-source normalization refuses wrong names, errors, partial searches, and malformed coordinates', () => {
  const empty = { found: false, name: 'copper-ore', max_radius: 1024, searched_radius: 1024, returned_count: 0, matched_count: 0, entities: [] }
  assert.equal(rawLeafSourceFromRead(empty, 'copper-ore', 1024).state, 'none')
  for (const answer of [null, 'not json', { ...empty, ok: false }, { ...empty, name: 'iron-ore' },
    { ...empty, searched_radius: 32 }, { ...empty, max_radius: 32 }, { ...empty, error: 'unavailable' },
    { ...empty, found: true, returned_count: 1, matched_count: 1, entities: [{ name: 'copper-ore', type: 'resource', position: { x: Number.NaN, y: 1 }, distance: 4 }] }]) {
    assert.equal(rawLeafSourceFromRead(answer, 'copper-ore', 1024).state, 'failed')
  }
  assert.deepEqual(rawLeafFromRecipeDetails({ found: false, code: 'no_recipe', query: 'copper-ore', mined_from: ['copper-ore', 'copper-ore'] }), { item: 'copper-ore', mined_from: ['copper-ore'] })
  assert.equal(rawLeafFromRecipeDetails({ found: false, query: 'copper-ore', mined_from: ['copper-ore'] }), undefined)
})


test('6: lab-sized recipe arithmetic cannot truncate the separate iron and copper acquisition record', () => {
  const rows = ['lab', 'electronic-circuit', 'iron-gear-wheel', 'transport-belt', 'copper-cable', 'iron-plate', 'copper-plate', 'iron-ore', 'copper-ore'].map(item => ({ item, required: 100, held: 0, missing: 100, crafts: 100, recipe: item,
    ...(item.endsWith('-ore') ? { raw: { mined_from: [item], sources: [{ resource: item, state: 'found', x: 192.5, y: 8.5, distance: 192.7, radius: 1024 }], as_of: { epoch: 3 } } } : {}) }))
  const packet = buildHandoffPacket({ planningState: committedState(), ...ARGS, role: 'executor', executorFacts: { residual: { roots: [{ item: 'lab', count: 1 }], rows } } })
  const acquisition = packet.text.split('\n').find(line => line.startsWith('raw_leaf_acquisition:'))
  assert.match(acquisition, /iron-ore missing=100.*nearest=\(192.5,8.5\)/)
  assert.match(acquisition, /copper-ore missing=100.*nearest=\(192.5,8.5\)/)
  assert.equal(packet.over_limit, false)
})


// --- Unit 8: trigger production roots, machine energy and burner fuel -------------------------------------------------

const liveMachine = (name, source, extra = {}) => ({
  name, type: 'furnace', placed_by_item: name, crafting_speed: 1, seconds_per_craft: 3.2, crafts_per_second: 0.3125,
  energy_source: source, energy_watts: 90000, ...extra,
})
const smeltingDetails = (machines) => ({
  found: true,
  query: 'copper-plate',
  truncated: false,
  recipes: [{
    name: 'copper-plate', enabled: true, energy: 3.2, categories: ['smelting'], hand_craftable_category: false,
    ingredients: [{ type: 'item', name: 'copper-ore', amount: 1 }], products: [{ type: 'item', name: 'copper-plate', amount: 1 }],
    crafting_machines: machines, crafting_machines_truncated: false,
  }],
})
const FURNACES = [
  liveMachine('electric-furnace', 'electric', { energy_watts: 180000 }),
  liveMachine('steel-furnace', 'burner', { burner_effectivity: 1, fuel_categories: ['chemical'] }),
  liveMachine('stone-furnace', 'burner', { burner_effectivity: 1, fuel_categories: ['chemical'] }),
]
const COPPER_PLATE_FACT = recipeFactsFromDetails(smeltingDetails(FURNACES), { tag: TAG })[0]
const triggerPath = (overrides = {}, node = {}) => researchPathFact({ ok: true, target: 'electronics', node_count: 1, nodes: [
  { name: 'electronics', researched: false, mode: 'trigger', status: 'ready', research_trigger: { type: 'craft-item', item: 'copper-plate', count: 10 }, ...node },
], ...overrides }, 'electronics', TAG)
const requirementResearch = (statuses) => ({ electronics: { trigger: { type: 'craft-item', item: 'copper-plate', count: 10 }, trigger_crafting: {
  item: 'copper-plate', recipes: [{ recipe: 'copper-plate', enabled: true, categories: ['smelting'], hand_craftable: false, hand_craftable_reason: 'category_unsupported',
    machines: Object.entries(statuses).map(([entity, status]) => ({ entity, item: entity, status })) }],
} } })

test('8 B: a production root comes only from a fresh, unresearched craft-item trigger on the research target', () => {
  assert.deepEqual(triggerProductionRoots([triggerPath()]), [{ item: 'copper-plate', count: 10, technology: 'electronics', held_counted: false, status: 'ready' }])
  for (const [label, path] of [
    ['researched', triggerPath({}, { researched: true })],
    ['lab research', researchPathFact({ ok: true, target: 'electronics', node_count: 1, nodes: [{ name: 'electronics', researched: false, mode: 'science', science: { count: 5, ingredients: [{ name: 'automation-science-pack', amount: 1 }] } }] }, 'electronics', TAG)],
    ['another trigger type', triggerPath({}, { research_trigger: { type: 'mine-entity', entity: 'rock-huge' } })],
    ['no count', triggerPath({}, { research_trigger: { type: 'craft-item', item: 'copper-plate' } })],
    ['zero count', triggerPath({}, { research_trigger: { type: 'craft-item', item: 'copper-plate', count: 0 } })],
    ['quality item', triggerPath({}, { research_trigger: { type: 'craft-item', item: 'copper-plate', item_quality: 'rare', count: 10 } })],
    ['unreadable path', { target: 'electronics', state: 'unavailable', reason: 'research_path_read_failed' }],
    ['deferred path', { target: 'electronics', state: 'deferred', reason: 'batch_in_flight' }],
  ]) assert.deepEqual(triggerProductionRoots([path]), [], label)
  // A prerequisite that is itself a trigger is not the contract's target: only the target node is a root.
  const chain = researchPathFact({ ok: true, target: 'automation-science-pack', node_count: 2, nodes: [
    { name: 'electronics', researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item: 'copper-plate', count: 10 } },
    { name: 'automation-science-pack', researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item: 'lab', count: 1 } },
  ] }, 'automation-science-pack', TAG)
  assert.deepEqual(triggerProductionRoots([chain]).map(root => root.item), ['lab'])
  const many = ['a', 'b', 'c', 'd', 'e', 'f'].map(name => researchPathFact({ ok: true, target: name, node_count: 1, nodes: [{ name, researched: false, mode: 'trigger', research_trigger: { type: 'craft-item', item: `item-${name}`, count: 1 } }] }, name, TAG))
  assert.equal(triggerProductionRoots(many).length, EXECUTOR_FACT_LIMITS.researchTargets)
})

test('8 B: a production target is met by new crafts: held stock is shown, never netted, while its ingredients net against held stock', () => {
  const production = [{ item: 'copper-plate', count: 10, technology: 'electronics', held_counted: false }]
  const derived = deriveResidualNeeds({ roots: [], production, recipes: [COPPER_PLATE_FACT], held: heldOf({ 'copper-plate': 10, 'copper-ore': 4 }) })
  assert.equal(derived.ok, true)
  assert.deepEqual(derived.rows, [
    { item: 'copper-plate', required: 10, held: 10, missing: 10, trigger: { technology: 'electronics', held_counted: false }, crafts: 10, recipe: 'copper-plate' },
    { item: 'copper-ore', required: 10, held: 4, missing: 6 },
  ])
  // The target needs no held count of its own; an unread one is simply not shown.
  const unread = deriveResidualNeeds({ roots: [], production, recipes: [COPPER_PLATE_FACT], held: heldOf({ 'copper-ore': 0 }) })
  assert.equal(unread.ok, true)
  assert.equal('held' in unread.rows[0], false)
  assert.deepEqual(unread.rows[1], { item: 'copper-ore', required: 10, held: 0, missing: 10 })
  // An ingredient count that is unknown still refuses, as for any root.
  assert.deepEqual(deriveResidualNeeds({ roots: [], production, recipes: [COPPER_PLATE_FACT], held: heldOf({}) }), { ok: false, reason: 'held_unknown:copper-ore' })
  // Without a usable recipe the target is stated with no crafts and no invented ingredients.
  const bare = deriveResidualNeeds({ roots: [], production, recipes: [], held: heldOf({}) })
  assert.deepEqual(bare.rows, [{ item: 'copper-plate', required: 10, missing: 10, trigger: { technology: 'electronics', held_counted: false } }])
  // A recipe both a production target and an inventory root would expand is refused rather than double counted.
  assert.deepEqual(deriveResidualNeeds({ roots: [{ item: 'copper-plate', count: 5 }], production, recipes: [COPPER_PLATE_FACT], held: heldOf({ 'copper-plate': 0, 'copper-ore': 0 }) }),
    { ok: false, reason: 'shared_recipe:copper-plate' })
  // Production alone is a valid input; neither roots nor production is not.
  assert.deepEqual(deriveResidualNeeds({ roots: [], production: [], recipes: [], held: heldOf({}) }), { ok: false, reason: 'no_contract_roots' })
  assert.deepEqual(expansionRecipeNames(['copper-plate', 'copper-ore'], [COPPER_PLATE_FACT]), ['copper-plate'])
})

test('8 C: recipe facts keep each machine native energy source from the mod answer, bounded, and never guess an unreported one', () => {
  assert.deepEqual(COPPER_PLATE_FACT.machines, ['electric-furnace', 'steel-furnace', 'stone-furnace'])
  assert.deepEqual(COPPER_PLATE_FACT.machine_energy, [
    { name: 'electric-furnace', energy_source: 'electric', energy_watts: 180000, item: 'electric-furnace' },
    { name: 'steel-furnace', energy_source: 'burner', fuel_categories: ['chemical'], energy_watts: 90000, item: 'steel-furnace' },
    { name: 'stone-furnace', energy_source: 'burner', fuel_categories: ['chemical'], energy_watts: 90000, item: 'stone-furnace' },
  ])
  const mixed = recipeFactsFromDetails(smeltingDetails([
    liveMachine('sink', 'void'), liveMachine('Bad Name', 'burner'), { name: 'mystery', type: 'furnace' }, liveMachine('lab-heater', 'nuclear-reactor'),
  ]), { tag: TAG })[0]
  assert.deepEqual(mixed.machine_energy.map(entry => `${entry.name}:${entry.energy_source}`), ['sink:void'])
  assert.deepEqual(mixed.machines, ['sink', 'mystery', 'lab-heater'], 'an unreported energy source adds no energy record, not a guessed one')
  assert.equal('machine_energy' in recipeFactsFromDetails(smeltingDetails([{ name: 'mystery', type: 'furnace' }]), { tag: TAG })[0], false)
  const wide = recipeFactsFromDetails(smeltingDetails(Array.from({ length: 9 }, (_, index) => liveMachine(`furnace-${index}`, 'electric'))), { tag: TAG })[0]
  assert.equal(wide.machine_energy.length, EXECUTOR_FACT_LIMITS.recipeMachines)
  // A later read without energy records does not erase them.
  assert.equal(mergeRecipeFact(COPPER_PLATE_FACT, { ...COPPER_PLATE_FACT, machine_energy: undefined }).machine_energy.length, 3)
})

test('8 C: the mod burner_fuels answer is validated, named and bounded', () => {
  const valid = { found: true, burner_fuels: { categories: ['chemical'], matched_count: 3, truncated: false, items: [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000 },
  ] } }
  assert.deepEqual(burnerFuelsFromDetails(valid), [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000, mined_from: [] },
  ])
  for (const bad of [undefined, {}, { found: false, burner_fuels: valid.burner_fuels }, { found: true }, { found: true, burner_fuels: 'coal' }]) assert.deepEqual(burnerFuelsFromDetails(bad), [])
  const items = [
    { name: 'Bad Name', category: 'chemical', fuel_value: 1 }, { name: 'no-value', category: 'chemical', fuel_value: 0 },
    { name: 'no-category', fuel_value: 5 }, { name: 'ok', category: 'chemical', fuel_value: 5, mined_from: ['a', 'b', 'c', 'd', 'e', 'f'] },
  ]
  const parsed = burnerFuelsFromDetails({ found: true, burner_fuels: { items } })
  assert.deepEqual(parsed.map(item => item.name), ['ok'])
  assert.equal(parsed[0].mined_from.length, EXECUTOR_FACT_LIMITS.rawLeafMinedFrom)
  const crowded = Array.from({ length: 12 }, (_, index) => ({ name: `fuel-${index}`, category: 'chemical', fuel_value: index + 1 }))
  assert.equal(burnerFuelsFromDetails({ found: true, burner_fuels: { items: crowded } }).length, EXECUTOR_FACT_LIMITS.fuelItems)
})

test('8 C: machine availability joins requirement statuses, fresh held counts and observed placement; locked and unverified machines are only counted', () => {
  const statuses = machineStatusesFrom({ triggerReports: cacheTriggerCraftingReports(requirementResearch({ 'stone-furnace': 'craftable', 'steel-furnace': 'locked', 'electric-furnace': 'locked' }), TAG) })
  assert.deepEqual([...statuses.entries()], [['stone-furnace', { item: 'stone-furnace', status: 'craftable' }], ['steel-furnace', { item: 'steel-furnace', status: 'locked' }], ['electric-furnace', { item: 'electric-furnace', status: 'locked' }]])
  const facts = deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], statuses, held: heldOf({ 'stone-furnace': 1 }), placed: new Map() })
  assert.deepEqual(facts.machines, [{ name: 'stone-furnace', energy_source: 'burner', fuel_categories: ['chemical'], energy_watts: 90000, item: 'stone-furnace',
    status: 'craftable', held: 1, placed: { observed: false } }])
  assert.deepEqual(facts.omitted, { locked: 2, unverified: 0, unread: 0, truncated: 0 })
  assert.equal(facts.burner_count, 1)
  assert.deepEqual(facts.fuel_categories, ['chemical'])
  // No status read at all: a machine counts as available only when the actor holds one or one was seen placed.
  const bare = deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], held: heldOf({ 'stone-furnace': 0, 'steel-furnace': 0 }), placed: new Map() })
  assert.equal(bare, undefined, 'nothing available to the actor means nothing to carry')
  const held = deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], held: heldOf({ 'steel-furnace': 2 }), placed: new Map([['electric-furnace', { count: 1, via: 'checkpoint_machine' }]]) })
  assert.deepEqual(held.machines.map(entry => [entry.name, entry.status, entry.held, entry.placed.observed]), [['electric-furnace', 'unknown', undefined, true], ['steel-furnace', 'unknown', 2, false]])
  assert.deepEqual(held.omitted, { locked: 0, unverified: 0, unread: 1, truncated: 0 }, 'a machine item whose count was not read is reported unread')
  const counted = deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], held: heldOf({ 'steel-furnace': 2, 'stone-furnace': 0, 'electric-furnace': 0 }), placed: new Map() })
  assert.deepEqual(counted.omitted, { locked: 0, unverified: 2, unread: 0, truncated: 0 }, 'a read zero count is unverified, not unread')
  assert.equal(held.burner_count, 1)
  // A recipe with no machine energy records says `unknown`, and a recipe that is not in the cache contributes nothing.
  const unlabelled = deriveMachineEnergy({ recipes: [{ ...COPPER_PLATE_FACT, machine_energy: undefined }], recipeNames: ['copper-plate', 'not-cached'], held: heldOf({}), placed: new Map([['stone-furnace', { count: 1, via: 'historical_entities' }]]) })
  assert.deepEqual(unlabelled.machines.map(entry => [entry.name, entry.energy_source]), [['stone-furnace', 'unknown']])
  assert.equal(unlabelled.burner_count, 0)
  assert.equal(deriveMachineEnergy({ recipes: [], recipeNames: ['copper-plate'], held: heldOf({}) }), undefined)
  // Requirement machine options reach the same status map.
  const fromOptions = machineStatusesFrom({ requirementMachines: new Map([['copper-plate', { machines: ['stone-furnace'], options: [{ entity: 'stone-furnace', item: 'stone-furnace', status: 'craftable' }, { entity: 'x y', item: 'z', status: 'craftable' }] }]]) })
  assert.deepEqual([...fromOptions.keys()], ['stone-furnace'])
})

test('8 C: fuel needs list the candidates for the burner categories, minable first, with fresh held counts and unread counts distinct', () => {
  const machineEnergy = { machines: [{ name: 'stone-furnace', energy_source: 'burner', fuel_categories: ['chemical'] }, { name: 'electric-furnace', energy_source: 'electric' }], fuel_categories: ['chemical'] }
  const fuels = [
    { name: 'wood', category: 'chemical', fuel_value: 2000000, mined_from: [] },
    { name: 'uranium-fuel-cell', category: 'nuclear', fuel_value: 8000000000, mined_from: [] },
    { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000, mined_from: [] },
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
  ]
  const needs = deriveFuelNeeds({ machineEnergy, fuels, held: heldOf({ coal: 5 }) })
  assert.equal(needs.search, 'held')
  assert.deepEqual(needs.machines, ['stone-furnace'])
  assert.deepEqual(needs.categories, ['chemical'])
  assert.deepEqual(needs.items.map(item => [item.name, item.held]), [['coal', 5], ['solid-fuel', undefined], ['wood', undefined]])
  assert.equal(needs.held_total, 5)
  assert.equal(needs.unknown_held, 2)
  assert.equal(deriveFuelNeeds({ machineEnergy, fuels, held: heldOf({ coal: 0 }) }).search, 'unknown_counts', 'one unread count forbids a search')
  assert.equal(deriveFuelNeeds({ machineEnergy, fuels, held: heldOf({ coal: 0, wood: 0, 'solid-fuel': 0 }) }).search, 'needed')
  assert.equal(deriveFuelNeeds({ machineEnergy, fuels: [], held: heldOf({}) }).search, 'no_candidates')
  assert.equal(deriveFuelNeeds({ machineEnergy: { machines: [{ name: 'electric-furnace', energy_source: 'electric' }], fuel_categories: [] }, fuels, held: heldOf({}) }), undefined)
  assert.equal(deriveFuelNeeds({ machineEnergy: undefined, fuels, held: heldOf({}) }), undefined)
})

test('8 C/D: the packet states the trigger target, the energy source and placement, and the fuel with its acquisition; sizes are bounded', () => {
  const statuses = machineStatusesFrom({ triggerReports: cacheTriggerCraftingReports(requirementResearch({ 'stone-furnace': 'craftable', 'steel-furnace': 'locked', 'electric-furnace': 'locked' }), TAG) })
  const held = heldOf({ 'copper-plate': 0, 'copper-ore': 10, 'stone-furnace': 1, coal: 0, 'solid-fuel': 0, wood: 0 })
  const machineEnergy = deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], statuses, held, placed: new Map() })
  const fuelNeeds = deriveFuelNeeds({ machineEnergy, held, fuels: [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'] },
    { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000, mined_from: [] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000, mined_from: [] },
  ] })
  fuelNeeds.items[0].raw = { mined_from: ['coal'], as_of: TAG, sources: [{ resource: 'coal', state: 'found', x: 192.5, y: 8.5, distance: 192.7, radius: 1024 }] }
  const production = [{ item: 'copper-plate', count: 10, technology: 'electronics', held_counted: false, status: 'ready' }]
  const residual = { roots: [], production, rows: deriveResidualNeeds({ roots: [], production, recipes: [COPPER_PLATE_FACT], held }).rows }
  const executorFacts = { recipes: [COPPER_PLATE_FACT], counts: { items: [{ item: 'copper-ore', count: 10, state: 'fresh' }], unavailable: [], as_of: TAG }, residual, machine_energy: machineEnergy, fuel_needs: fuelNeeds }
  const packet = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts, limits: { maxChars: 100000 } })
  const line = prefix => packet.text.split('\n').find(item => item.startsWith(prefix))
  assert.equal(line('residual_needs'), 'residual_needs (derived from recipe_fact and fresh held_counts for the step contract trigger:copper-platex10; shared stock counted once): trigger craft-item copper-plate count=10 for electronics (counts new crafts; held stock not counted) held=0 crafts=10 via copper-plate | copper-ore required=10 held=10 missing=0')
  assert.equal(line('machine_energy'), 'machine_energy (native prototype energy source; held = fresh live count of the machine item; placed = whether this harness observed an instance via historical_entities or checkpoint_machine, history and not a current exact target): stone-furnace energy=burner(fuel_categories=chemical, 90kW) status=craftable held=1 placed=not_observed | not_listed: locked=2')
  assert.equal(fuelNeeds.search, 'needed')
  assert.match(line('fuel_needs'), /^fuel_needs \(burner stone-furnace burn fuel_categories=chemical; candidates from item prototypes, held from the fresh read; amount needed not derived; sources derived from prototypes: resources that mine into the item \(mined_from\) and the natural trees and rocks the harvest operation mines for it \(harvested_from\), no_derived_source = neither yields it\): held_fuel=none \| coal fuel_value=4MJ held=0 raw: mined_from=coal \(source observation; reach\/path unverified\) nearest=\(192\.5,8\.5\) distance=192\.7 as_of=tick:612,epoch:3 \| solid-fuel fuel_value=12MJ held=0 no_derived_source \| wood fuel_value=2MJ held=0 no_derived_source$/)
  assert.deepEqual({ machine_energy: packet.executor_facts.machine_energy, burner_machines: packet.executor_facts.burner_machines, fuel_needs: packet.executor_facts.fuel_needs }, { machine_energy: 1, burner_machines: 1, fuel_needs: 3 })
  assert.equal(packet.dropped.length, 0)
  // A packet without the new facts is unchanged: no keys, no lines.
  const plain = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts: FRESH_FACTS() })
  assert.equal('machine_energy' in plain.executor_facts, false)
  assert.ok(!plain.text.includes('machine_energy') && !plain.text.includes('fuel_needs'))

  // The deferred refresh message carries them in the same words.
  const refresh = executorFactsRefreshMessage(executorFacts)
  assert.ok(refresh.includes(line('machine_energy')) && refresh.includes(line('fuel_needs')))

  // Size control: whole records, by their named drop keys, in the documented order.
  const order = HANDOFF_DROP_ORDER
  // The energy and fuel facts drop first; the production target and its arithmetic outlive them, and the unit 6 acquisition
  // record intentionally outlives the residual rows it was derived from.
  assert.ok(order.indexOf('fresh_counts') < order.indexOf('machine_energy'))
  assert.ok(order.indexOf('machine_energy') < order.indexOf('fuel_needs'))
  assert.ok(order.indexOf('fuel_needs') < order.indexOf('residual_needs'))
  assert.ok(order.indexOf('residual_needs') < order.indexOf('raw_leaf_acquisition'))
  assert.ok(order.indexOf('raw_leaf_acquisition') < order.indexOf('roadmap_node'))
  const tiny = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts, limits: { maxChars: 1 } })
  const dropped = tiny.dropped
  // This fixture has no raw leaf with a shortfall, so raw_leaf_acquisition is absent; its place after residual_needs is asserted on the order above.
  for (const [first, second] of [['machine_energy', 'fuel_needs'], ['fuel_needs', 'residual_needs']]) {
    assert.ok(dropped.includes(first) && dropped.includes(second), `${first} and ${second} dropped`)
    assert.ok(dropped.indexOf(first) < dropped.indexOf(second), `${first} drops before ${second}: ${dropped.join(', ')}`)
  }
  assert.deepEqual({ machine_energy: tiny.executor_facts.machine_energy, burner_machines: tiny.executor_facts.burner_machines, fuel_needs: tiny.executor_facts.fuel_needs }, { machine_energy: 0, burner_machines: 0, fuel_needs: 0 })
  // Bounded rendering: many machines and many fuels cannot grow a record past its character limit (plus its fixed header).
  const crowdedMachines = { machines: Array.from({ length: 6 }, (_, index) => ({ name: `furnace-with-a-long-name-${index}`, energy_source: 'burner', fuel_categories: ['chemical'], energy_watts: 90000, status: 'craftable', held: 100000, placed: { observed: true, count: 12, via: 'historical_entities' } })), omitted: { locked: 9, unverified: 9, truncated: 3 }, burner_count: 6, fuel_categories: ['chemical'] }
  const crowdedFuel = { machines: ['furnace-0'], categories: ['chemical'], held_total: 0, unknown_held: 0, items: Array.from({ length: 6 }, (_, index) => ({ name: `${'fuel-'.repeat(8)}${index}`, category: 'chemical', fuel_value: 1000000, mined_from: [`resource-${'r'.repeat(30)}${index}`], held: 0 })), search: 'needed' }
  const crowded = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts: { machine_energy: crowdedMachines, fuel_needs: crowdedFuel }, limits: { maxChars: 100000 } })
  const crowdedLine = prefix => crowded.text.split('\n').find(item => item.startsWith(prefix))
  assert.ok(crowdedLine('machine_energy').length <= 340 + EXECUTOR_FACT_LIMITS.machineEnergyChars + 160, crowdedLine('machine_energy'))
  assert.match(crowdedLine('machine_energy'), /\(\+\d+ more\)/)
  assert.ok(crowdedLine('fuel_needs').length <= 480 + EXECUTOR_FACT_LIMITS.fuelChars + 120, crowdedLine('fuel_needs'))
  assert.match(crowdedLine('fuel_needs'), /\(\+\d+ more\)/)
  // The deferred refresh message bounds the two records with the same limits and words.
  const refreshCrowded = executorFactsRefreshMessage({ machine_energy: crowdedMachines, fuel_needs: crowdedFuel })
  assert.ok(refreshCrowded.includes(crowdedLine('machine_energy')) && refreshCrowded.includes(crowdedLine('fuel_needs')))
})

test('3a: a partial fluid read keeps coverage_complete on its anchors and the packet says the coverage was incomplete', () => {
  const partial = learnWater(waterAnswer([waterSample(22, 8)], { coverage_complete: false, ungenerated_chunk_count: 2, ordering: 'nearest_first' }))
  assert.deepEqual(partial.anchors[0], { name: 'water', fluid_name: 'water', surface_index: 1, position: { x: 22, y: 8 }, as_of: { tick: 77, epoch: 3, actor_id: 19, at_ms: 5 },
    coverage_complete: false, ungenerated_chunk_count: 2 })
  const complete = learnWater(waterAnswer([waterSample(30, 8)], { coverage_complete: true, ungenerated_chunk_count: 0, ordering: 'nearest_first' }))
  assert.equal(complete.anchors[0].coverage_complete, true)
  assert.equal(complete.anchors[0].ungenerated_chunk_count, undefined)

  const facts = { ...FRESH_FACTS(), fluid_source_hints: [...complete.anchors, ...partial.anchors] }
  const packet = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts: facts, limits: { maxChars: 100000 } })
  const line = packet.volatileText.split('\n').find(item => item.startsWith('fluid_source_hints'))
  assert.match(line, /water:water@\(22,8\) surface=1 observed [^|]*coverage=INCOMPLETE\(2 chunks ungenerated; nearer water may exist\)/)
  assert.doesNotMatch(line.split(' | ').find(part => part.includes('@(30,8)')), /coverage=/)
})


// --- Unit 9 review: one packet with a build bill, a science residual and harvest sources at full size -----------------------

test('9: a build bill, a science residual and harvest sources with full raw-leaf and fuel text fit the packet, and the drop order keeps the residual and acquisition longest', () => {
  const recipes = [
    recipeFact('offshore-pump', [['electronic-circuit', 2], ['pipe', 1], ['iron-gear-wheel', 1]], [['offshore-pump', 1]]),
    recipeFact('boiler', [['stone-furnace', 1], ['pipe', 4]], [['boiler', 1]]),
    recipeFact('steam-engine', [['iron-gear-wheel', 8], ['pipe', 5], ['iron-plate', 10]], [['steam-engine', 1]]),
    recipeFact('small-electric-pole', [['wood', 1], ['copper-cable', 1]], [['small-electric-pole', 2]]),
    recipeFact('automation-science-pack', [['copper-plate', 1], ['iron-gear-wheel', 1]], [['automation-science-pack', 1]]),
    recipeFact('pipe', [['iron-plate', 1]], [['pipe', 1]]),
    recipeFact('stone-furnace', [['stone', 5]], [['stone-furnace', 1]]),
    recipeFact('electronic-circuit', [['iron-plate', 1], ['copper-cable', 3]], [['electronic-circuit', 1]]),
    recipeFact('copper-cable', [['copper-plate', 1]], [['copper-cable', 2]]),
    recipeFact('iron-gear-wheel', [['iron-plate', 2]], [['iron-gear-wheel', 1]]),
    recipeFact('iron-plate', [['iron-ore', 1]], [['iron-plate', 1]]),
    COPPER_PLATE_FACT,
  ]
  const placing = new Map(['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole'].map(prototype => [prototype, { prototype, item: prototype, count: 1 }]))
  const builds = [
    { id: 'pump', prototype: 'offshore-pump', minimum: 1 }, { id: 'boiler', prototype: 'boiler', minimum: 1 },
    { id: 'engine', prototype: 'steam-engine', minimum: 2, state: 'powered' }, { id: 'poles', prototype: 'small-electric-pole', minimum: 2 },
  ]
  const bill = deriveBuildBill({ builds, placing, placed: new Map([['pump', 0], ['boiler', 0], ['engine', 1], ['poles', 0]]), stateCounts: new Map([['engine', 0]]) })
  assert.deepEqual(bill.unresolved, [])
  const research = researchPathFact({ ok: true, target: 'logistic-science-pack', node_count: 1, nodes: [{ name: 'logistic-science-pack', researched: false, mode: 'science', status: 'ready',
    prerequisites: [], unresolved_prerequisites: [], science: { count: 75, energy: 5, ingredients: [{ name: 'automation-science-pack', amount: 1 }], ingredients_truncated: false } }] }, 'logistic-science-pack', TAG)
  const science = scienceProductionRoots(scienceTargets([research]), new Map([['logistic-science-pack', 0.2]]), ['lab'])
  const roots = [...bill.roots, ...science.flatMap(entry => entry.roots)]
  const items = ['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole', 'automation-science-pack', 'electronic-circuit', 'pipe', 'iron-gear-wheel', 'stone-furnace', 'iron-plate', 'wood', 'copper-cable', 'stone', 'copper-plate', 'iron-ore', 'copper-ore', 'lab', 'coal', 'solid-fuel']
  const held = heldOf(Object.fromEntries(items.map(item => [item, item === 'lab' ? 1 : item === 'iron-plate' ? 15 : 0])))
  const derived = deriveResidualNeeds({ roots, recipes, held })
  assert.equal(derived.ok, true, JSON.stringify(derived))
  const found = (resource, x) => ({ resource, state: 'found', x, y: 8.5, distance: 192.7 + x / 100, radius: 1024 })
  for (const row of derived.rows) {
    if (row.item === 'iron-ore' || row.item === 'copper-ore') row.raw = { mined_from: [row.item], as_of: TAG, sources: [found(row.item, 192.5)], harvest_sources: [] }
    if (row.item === 'stone') row.raw = { mined_from: ['stone'], harvested_from: ['big-rock', 'huge-rock', 'sand-rock-big'], as_of: TAG,
      sources: [found('stone', 40.5)], harvest_sources: [found('big-rock', 61.5), { resource: 'huge-rock', state: 'none', radius: 1024 }, { resource: 'sand-rock-big', state: 'not_read' }] }
    if (row.item === 'wood') row.raw = { mined_from: [], harvested_from: ['tree-01', 'tree-02', 'tree-03', 'tree-04'], as_of: TAG, sources: [],
      harvest_sources: ['tree-01', 'tree-02', 'tree-03', 'tree-04'].map((name, index) => found(name, 100.5 + index)) }
  }
  const machineEnergy = withLabEnergy(
    deriveMachineEnergy({ recipes: [COPPER_PLATE_FACT], recipeNames: ['copper-plate'], statuses: machineStatusesFrom({ triggerReports: cacheTriggerCraftingReports(requirementResearch({ 'stone-furnace': 'craftable', 'steel-furnace': 'locked', 'electric-furnace': 'locked' }), TAG) }), held, placed: new Map() }),
    labMachineEntries({ candidates: [{ name: 'lab', energy_source: 'electric', item: 'lab', enabled_recipe: true, held_count: 1 }], held, placed: new Map() }))
  const fuelNeeds = deriveFuelNeeds({ machineEnergy, held, fuels: [
    { name: 'coal', category: 'chemical', fuel_value: 4000000, mined_from: ['coal'], harvested_from: ['huge-rock'] },
    { name: 'wood', category: 'chemical', fuel_value: 2000000, mined_from: [], harvested_from: ['tree-01', 'tree-02', 'tree-03', 'tree-04'] },
    { name: 'solid-fuel', category: 'chemical', fuel_value: 12000000, mined_from: [] },
  ] })
  fuelNeeds.items[0].raw = { mined_from: ['coal'], harvested_from: ['huge-rock'], as_of: TAG, sources: [found('coal', 192.5)], harvest_sources: [found('huge-rock', 61.5)] }
  fuelNeeds.items[1].raw = { mined_from: [], harvested_from: ['tree-01', 'tree-02', 'tree-03', 'tree-04'], as_of: TAG, sources: [], harvest_sources: ['tree-01', 'tree-02', 'tree-03', 'tree-04'].map((name, index) => found(name, 100.5 + index)) }
  const executorFacts = {
    research: [research],
    recipes: selectRecipeFacts(recipes, { wanted: ['offshore-pump', 'boiler', 'steam-engine'] }),
    counts: { items: items.map(item => ({ item, count: held.get(item), state: 'fresh' })), unavailable: [], as_of: TAG },
    residual: { roots, production: [], rows: derived.rows },
    machine_energy: machineEnergy, fuel_needs: fuelNeeds,
    historical_entities: [{ name: 'stone-furnace', count: 2, tick: 600 }],
  }
  const run = maxChars => buildHandoffPacket({ planningState: circuitState(), ...ARGS, note: 'a note', budget: 'effort low', executorFacts, actor: ACTOR, limits: { maxChars } })
  const full = run(100000)
  assert.deepEqual(full.dropped, [])
  const lineOf = (packet, prefix) => packet.text.split('\n').find(line => line.startsWith(prefix))
  assert.match(lineOf(full, 'residual_needs'), /for the step contract build:offshore-pumpx1,build:boilerx1,build:steam-enginex1,build:small-electric-polex2,science:automation-science-packx60;/)
  assert.match(lineOf(full, 'residual_needs'), /\[build steam-engine: placed=1 powered=0 of 2, 1 more to place\]/)
  assert.match(lineOf(full, 'residual_needs'), /\[science logistic-science-pack: 60 of 75 units x1 per unit, research progress 20% netted; consumed by lab\]/)
  assert.doesNotMatch(lineOf(full, 'residual_needs'), /\(\+\d+ more\)/, 'the whole bill fits the residual bound')
  assert.match(lineOf(full, 'raw_leaf_acquisition'), /wood missing=1 harvest: harvested_from=tree-01,tree-02,tree-03,tree-04 .*nearest@tree-04=/)
  assert.match(lineOf(full, 'raw_leaf_acquisition'), /stone missing=\d+ raw: mined_from=stone .*harvest: harvested_from=big-rock,huge-rock,sand-rock-big .*nearest@huge-rock=none_within_1024 nearest@sand-rock-big=not_read/)
  assert.match(lineOf(full, 'fuel_needs'), /wood fuel_value=2MJ held=0 harvest: harvested_from=tree-01,tree-02,tree-03,tree-04/)
  assert.match(lineOf(full, 'machine_energy'), /lab energy=electric status=craftable held=1 placed=not_observed consumes=research_packs/)

  // The ordinary limit is never exceeded by mandatory records alone: optional records drop whole, in the fixed order.
  const ordinary = buildHandoffPacket({ planningState: circuitState(), ...ARGS, executorFacts, actor: ACTOR })
  assert.equal(ordinary.over_limit, false)
  const group = key => key.startsWith('recipe_fact_') ? 'recipe_facts' : key.startsWith('receipt_') ? 'receipt' : key === 'held_counts' ? 'fresh_counts' : key
  const position = key => HANDOFF_DROP_ORDER.indexOf(group(key))
  const ranks = ordinary.dropped.map(position)
  assert.ok(ranks.every(rank => rank >= 0) && ranks.every((rank, index) => index === 0 || rank >= ranks[index - 1]), `dropped in the fixed order: ${ordinary.dropped.join(', ')}`)
  assert.ok(!ordinary.dropped.includes('residual_needs') && !ordinary.dropped.includes('raw_leaf_acquisition'), 'the residual and the acquisition survive the ordinary limit')

  // Squeezing further: every annotation (recipe facts, machine energy, fuel needs) is gone before the residual is, and the
  // acquisition record outlives the residual's arithmetic.
  let residualGone
  for (let max = full.chars; max > 0 && !residualGone; max -= 25) {
    const packet = run(max)
    if (packet.dropped.includes('residual_needs')) residualGone = packet
  }
  assert.ok(residualGone, 'a limit small enough drops the residual')
  for (const key of ['machine_energy', 'fuel_needs', 'recipe_fact_0', 'held_counts']) assert.ok(residualGone.dropped.includes(key), `${key} dropped before the residual`)
  assert.ok(!residualGone.dropped.includes('raw_leaf_acquisition'), 'the acquisition record outlives the residual')
})

// Unit 15: output stock in a machine read fresh is collectable stock toward a shortfall (run I: a furnace held 3 copper plates, the
// actor 9 of the 10 the contract counted, and the residual still asked for one more ore).
const SMELT_COPPER = recipeFact('copper-plate', [['copper-ore', 1]], [['copper-plate', 1]])
const furnaceStock = (unit, output, name = 'stone-furnace') => ({ name, unit_number: unit, output })

test('unit 15: machine output covers the shortfall, leaves no ore demand, and the row names the machine without changing the held count', () => {
  const roots = [{ item: 'copper-plate', count: 10 }]
  const result = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 9, 'copper-ore': 0 }), machineStock: [furnaceStock(13, { 'copper-plate': 3 })] })
  assert.equal(result.ok, true)
  assert.deepEqual(result.rows, [{ item: 'copper-plate', required: 10, held: 9, missing: 0, machine_stock: [{ name: 'stone-furnace', unit_number: 13, count: 3 }], missing_before_machine: 1, crafts: 0, recipe: 'copper-plate' }])
  const packet = buildHandoffPacket({ planningState: circuitState(), ...ARGS, limits: { maxChars: 100000 }, executorFacts: {
    recipes: [SMELT_COPPER], counts: { items: [{ item: 'copper-plate', count: 9, state: 'fresh' }, { item: 'copper-ore', count: 0, state: 'fresh' }], unavailable: [], as_of: TAG },
    residual: { roots, rows: result.rows },
  } })
  const line = packet.text.split('\n').find(item => item.startsWith('residual_needs'))
  assert.equal(line, 'residual_needs (derived from recipe_fact and fresh held_counts and FRESH placed_machines output reads for the step contract copper-plate>=10; shared stock counted once; in_machine_output is stock inside a machine, not held, and the step contract counts the actor inventory; it is counted from FRESH reads only, never from a STALE observation; move_items_exact to_entity=false transfers machine contents to the actor): copper-plate required=10 held=9 in_machine_output=3@stone-furnace unit=13 missing_after_machine=0 crafts=0 via copper-plate')
  assert.ok(!packet.text.includes('copper-ore required'))
})

test('unit 15: machine output that covers part of the shortfall is netted once, across machines, and the rest still demands ingredients', () => {
  const roots = [{ item: 'copper-plate', count: 10 }]
  const partial = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 5, 'copper-ore': 0 }), machineStock: [furnaceStock(13, { 'copper-plate': 3 })] })
  const byItem = Object.fromEntries(partial.rows.map(row => [row.item, row]))
  assert.deepEqual({ held: byItem['copper-plate'].held, missing: byItem['copper-plate'].missing, before: byItem['copper-plate'].missing_before_machine, crafts: byItem['copper-plate'].crafts }, { held: 5, missing: 2, before: 5, crafts: 2 })
  assert.equal(byItem['copper-ore'].required, 2)
  assert.equal(byItem['copper-ore'].missing, 2)
  // Two machines add up; more stock than the shortfall never pushes missing below zero.
  const two = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 2, 'copper-ore': 0 }), machineStock: [furnaceStock(13, { 'copper-plate': 3 }), furnaceStock(14, { 'copper-plate': 9 })] })
  assert.equal(two.rows.length, 1)
  assert.deepEqual({ missing: two.rows[0].missing, before: two.rows[0].missing_before_machine, stock: two.rows[0].machine_stock.map(entry => `${entry.unit_number}:${entry.count}`) }, { missing: 0, before: 8, stock: ['14:9', '13:3'] })
  // Stock for an item the actor already covers, a bad machine entry, and no stock at all leave the row exactly as it was.
  const covered = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 10 }), machineStock: [furnaceStock(13, { 'copper-plate': 3 })] })
  assert.deepEqual(covered.rows, [{ item: 'copper-plate', required: 10, held: 10, missing: 0 }])
  const without = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 9, 'copper-ore': 0 }) })
  const invalid = deriveResidualNeeds({ roots, recipes: [SMELT_COPPER], held: heldOf({ 'copper-plate': 9, 'copper-ore': 0 }), machineStock: [{ name: 'stone-furnace', output: { 'copper-plate': 3 } }, furnaceStock(15, { 'copper-plate': 0, 'iron-plate': 4 })] })
  assert.deepEqual(invalid, without)
  assert.equal(without.rows[0].missing_before_machine, undefined)
})

test('unit 15: a trigger production row never nets machine stock, while its ingredients net like any other need', () => {
  const production = [{ item: 'copper-plate', count: 10, technology: 'electronics', held_counted: false, status: 'ready' }]
  const held = heldOf({ 'copper-plate': 0, 'copper-ore': 4 })
  const plain = deriveResidualNeeds({ roots: [], production, recipes: [SMELT_COPPER], held })
  const stocked = deriveResidualNeeds({ roots: [], production, recipes: [SMELT_COPPER], held, machineStock: [furnaceStock(13, { 'copper-plate': 6, 'copper-ore': 3 })] })
  const trigger = rows => rows.find(row => row.trigger)
  assert.deepEqual(trigger(stocked.rows), trigger(plain.rows), 'the trigger row is unchanged')
  assert.equal(trigger(stocked.rows).missing, 10)
  assert.equal(trigger(stocked.rows).machine_stock, undefined)
  // The ingredient (copper-ore) is an ordinary row: 10 needed, 4 held, 3 in the machine's output as collectable stock.
  const ore = stocked.rows.find(row => row.item === 'copper-ore')
  assert.deepEqual({ required: ore.required, held: ore.held, missing: ore.missing, before: ore.missing_before_machine }, { required: 10, held: 4, missing: 3, before: 6 })
  const text = buildHandoffPacket({ planningState: circuitState(), ...ARGS, limits: { maxChars: 100000 }, executorFacts: { recipes: [SMELT_COPPER], counts: { items: [{ item: 'copper-ore', count: 4, state: 'fresh' }], unavailable: [], as_of: TAG }, residual: { roots: [], production, rows: stocked.rows } } }).text
  assert.match(text.split('\n').find(line => line.startsWith('residual_needs')), /trigger craft-item copper-plate count=10 for electronics \(counts new crafts; held stock not counted\) held=0 crafts=10 via copper-plate \| copper-ore required=10 held=4 in_machine_output=3@stone-furnace unit=13 missing_after_machine=3$/)
})

test('the planner review notes of the active step reach the executor packet, survive a snapshot restore and never cross steps', () => {
  const KEY = 'npc'
  const memory = new CanonicalTaskBoardMemory()
  memory.planningByNpc.set(KEY, committedState())
  const [first, second] = getActivePlan(memory.planningState(KEY)).steps.map(step => step.step_id)
  const NOTES = 'Planner notes: read the furnace footprint first.'
  assert.equal(memory.recordReviewNotes(KEY, first, NOTES), false, 'notes need the review round to have been claimed for the step')
  assert.equal(memory.claimReviewContinuation(KEY, first), true)
  assert.equal(memory.recordReviewNotes(KEY, first, NOTES), true)
  assert.equal(memory.recordReviewNotes(KEY, second, 'Notes for a step with no round'), false)
  const notesLine = packet => packet.text.split('\n').find(line => line.startsWith('planner_review_notes'))

  const restored = new CanonicalTaskBoardMemory()
  restored.restore(JSON.parse(JSON.stringify(memory.snapshot())))
  assert.deepEqual(restored.planningState(KEY).goal.review_notes, { [first]: NOTES })
  const packet = buildHandoffPacket({ planningState: restored.planningState(KEY), ...ARGS, limits: { maxChars: 100000 } })
  assert.equal(notesLine(packet), `planner_review_notes (the planner's reply to your review of this step; the plan is unchanged; advisory, not world evidence): ${NOTES}`)
  assert.equal(notesLine(buildHandoffPacket({ planningState: restored.planningState(KEY), ...ARGS, role: 'planner', limits: { maxChars: 100000 } })), undefined, 'executor role only')

  // The same notes do not follow the goal to another active step.
  const advanced = closeActiveStep(restored.planningState(KEY), 600)
  assert.equal(getActivePlan(advanced).steps[getActivePlan(advanced).active_step_index].step_id, second)
  assert.equal(notesLine(buildHandoffPacket({ planningState: advanced, ...ARGS, limits: { maxChars: 100000 } })), undefined)

  // Bounded, and a size-limited packet keeps them after the records that serve less of the step.
  const long = new CanonicalTaskBoardMemory()
  long.planningByNpc.set(KEY, committedState())
  long.claimReviewContinuation(KEY, first)
  long.recordReviewNotes(KEY, first, 'x'.repeat(MAX_REVIEW_NOTES_CHARS * 2))
  assert.equal(long.planningState(KEY).goal.review_notes[first].length, MAX_REVIEW_NOTES_CHARS)
  const order = HANDOFF_DROP_ORDER
  assert.ok(order.indexOf('review_notes') > order.indexOf('contract') && order.indexOf('review_notes') > order.indexOf('receipt'))
  assert.ok(order.indexOf('review_notes') < order.indexOf('step_pending'))
  const tiny = buildHandoffPacket({ planningState: restored.planningState(KEY), ...ARGS, limits: { maxChars: 1 } })
  assert.ok(tiny.dropped.includes('review_notes'), 'a packet over its limit still drops the record by its named key')
})

test('Run Y: harvested_from makes an item raw unless an answered recipe really makes it; mined_from always does', () => {
  // The mod's getRecipeDetails recipe entries (recipe_candidates lists every force recipe that has the item as a product).
  const entry = (name, ingredients, products, extra = {}) => ({ name, enabled: true, hidden: false, energy: 0.5, categories: ['crafting'], hand_craftable_category: true,
    ingredients: ingredients.map(([item, amount]) => ({ type: 'item', name: item, amount })),
    products: products.map(([item, amount, probability]) => ({ type: 'item', name: item, amount, ...(probability !== undefined ? { probability } : {}) })),
    crafting_machines: [{ name: 'assembling-machine-1', type: 'assembling-machine', crafting_speed: 0.5, seconds_per_craft: 1 }], crafting_machines_truncated: false, ...extra })
  const cable = entry('copper-cable', [['copper-plate', 1]], [['copper-cable', 2]])
  const cableRecycling = entry('copper-cable-recycling', [['copper-cable', 1]], [['copper-plate', 1, 0.25]], { categories: ['recycling'] })
  const woodRecycling = entry('wooden-chest-recycling', [['wooden-chest', 1]], [['wood', 1, 0.25]], { categories: ['recycling'] })
  const poleRecycling = entry('small-electric-pole-recycling', [['small-electric-pole', 1]], [['wood', 1, 0.25], ['copper-cable', 1, 0.25]], { categories: ['recycling'] })
  const ruins = ['fulgoran-ruin-small', 'fulgoran-ruin-medium']
  const trees = ['tree-01', 'tree-02']
  // The live Run Y shape: a plain recipe beside two harvest sources. The item is made, so it is not a raw leaf and its recipe stays.
  const crafted = { found: true, query: 'copper-cable', truncated: false, recipes: [cable], harvested_from: ruins }
  assert.equal(rawLeafFromRecipeDetails(crafted), undefined)
  const facts = recipeFactsFromDetails(crafted, { tag: TAG })
  assert.deepEqual(withoutRawLeafRecipes(facts, new Map()), facts)
  assert.deepEqual(expandableIngredients('copper-cable', facts, new Map()), ['copper-plate'], 'the craft is still expanded')
  // A recycling recipe beside the plain recipe does not turn the item into a raw leaf either.
  assert.equal(rawLeafFromRecipeDetails({ ...crafted, recipes: [cableRecycling, cable] }), undefined)
  // The Space Age shape of a harvest-only item: found:true, but every answered recipe is a probabilistic recycling product.
  const wood = { found: true, query: 'wood', truncated: false, recipes: [woodRecycling, poleRecycling], harvested_from: trees }
  assert.deepEqual(rawLeafFromRecipeDetails(wood), { item: 'wood', mined_from: [], harvested_from: trees })
  assert.deepEqual(withoutRawLeafRecipes(recipeFactsFromDetails(wood, { tag: TAG }), new Map([['wood', rawLeafFromRecipeDetails(wood)]])), [], 'the recycling recipes are noise beside the harvest source')
  // The base-game shape: no recipe at all.
  assert.deepEqual(rawLeafFromRecipeDetails({ found: false, code: 'no_recipe', query: 'wood', harvested_from: trees }), { item: 'wood', mined_from: [], harvested_from: trees })
  // A resource mines into the item whatever recipes list it, harvest sources or not.
  assert.deepEqual(rawLeafFromRecipeDetails({ found: true, query: 'stone', recipes: [cable], mined_from: ['stone'], harvested_from: ['big-rock'] }), { item: 'stone', mined_from: ['stone'], harvested_from: ['big-rock'] })
  assert.equal(rawLeafFromRecipeDetails({ found: false, code: 'no_recipe', query: 'sand' }), undefined)
})
