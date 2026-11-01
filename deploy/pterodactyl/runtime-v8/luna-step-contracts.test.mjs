import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildStepContractPacket,
  completionContractSignature,
  normalizeStepCompletions,
  parseStepContractReply,
  STEP_CONTRACT_MARKER,
  stepContractCorrectionMessage,
  stepContractUserMessage,
} from './luna-step-contracts.mjs'
import { validatesAgainstSchema } from './control-json-repair.mjs'
import { applyPlanningEvent, createEmptyPlanningState, getActivePlan, PLANNING_EVENT } from './planning-state.mjs'
import { plannerControlToolDefinitions } from './structured-policy.mjs'

const inventory = { mode: 'all', requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] }

test('step completion declarations remain aligned to authored descriptions and do not mutate the draft', () => {
  const values = [{ kind: 'deterministic', checkpoint: inventory }, { kind: 'semantic', rationale: '  Assess the observed site constraints.  ' }]
  const before = JSON.stringify(values)
  const result = normalizeStepCompletions(['Gather copper', 'Assess a site'], values)
  assert.equal(result[0].kind, 'deterministic')
  assert.equal(result[0].checkpoint.requirements[0].item_name, 'copper-ore')
  assert.equal(result[0].checkpoint.requirements[0].minimum, 10)
  assert.deepEqual(result[1], { kind: 'semantic', rationale: 'Assess the observed site constraints.' })
  assert.equal(JSON.stringify(values), before)
})

test('every new plan step requires exactly one explicit declaration', () => {
  for (const values of [undefined, null, {}, [], [{ kind: 'semantic', rationale: 'Assess' }, { kind: 'semantic', rationale: 'Extra' }]]) {
    assert.throws(() => normalizeStepCompletions(['One step'], values), /exactly one completion declaration per plan step/)
  }
  assert.deepEqual(normalizeStepCompletions([], []), [])
})

test('unsupported or malformed deterministic predicates are not silently downgraded to prose', () => {
  // A deterministic entry with NO checkpoint is a later step whose contract is bound when it starts (tested below); a checkpoint
  // that is present but null, empty or unsupported is still refused and never downgraded to "pending".
  for (const checkpoint of [null, {}, { mode: 'all', requirements: [] }, { mode: 'all', requirements: [{ kind: 'invented_kind' }] }]) {
    assert.throws(() => normalizeStepCompletions(['Gather copper'], [{ kind: 'deterministic', checkpoint }]), /requires a supported checkpoint/)
  }
})

test('research completion remains a world-state predicate rather than an accepted request receipt', () => {
  const checkpoint = { mode: 'all', requirements: [{ kind: 'research_completed', technology: 'logistic-science-pack' }] }
  const result = normalizeStepCompletions(['Complete logistic research'], [{ kind: 'deterministic', checkpoint }])
  assert.equal(result[0].checkpoint.requirements[0].kind, 'research_completed')
  assert.equal(result[0].checkpoint.requirements[0].technology, 'logistic-science-pack')
})

test('new receipt declarations reject operations requiring world verification and preserve assessment-only declarations', () => {
  for (const operation_name of ['wait', 'research_technology']) {
    const checkpoint = { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name }] }
    assert.throws(() => normalizeStepCompletions(['Execute action'], [{ kind: 'deterministic', checkpoint }]), /requires a supported checkpoint/)
  }
  const checkpoint = { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name: 'craft_item' }] }
  assert.equal(normalizeStepCompletions(['Craft an item'], [{ kind: 'deterministic', checkpoint }])[0].checkpoint.requirements[0].operation_name, 'craft_item')
  assert.deepEqual(normalizeStepCompletions(['Assess current observations'], [{ kind: 'semantic', rationale: 'Assess fresh authoritative observations without operations.' }]),
    [{ kind: 'semantic', rationale: 'Assess fresh authoritative observations without operations.' }])
})

test('semantic assessments require an explicit nonempty rationale, not a completion guess', () => {
  for (const value of [null, 'done', { kind: 'semantic' }, { kind: 'semantic', rationale: '' }, { kind: 'semantic', rationale: '  ' }, { kind: 'semantic', rationale: 1 }, { kind: 'automatic', rationale: 'Assume done' }]) {
    assert.throws(() => normalizeStepCompletions(['Assess a site'], [value]), /must declare deterministic completion or a semantic assessment rationale/)
  }
  assert.equal(normalizeStepCompletions(['Assess'], [{ kind: 'semantic', rationale: 'x'.repeat(700) }])[0].rationale.length, 600)
})

test('completion declaration kinds refuse extra members instead of accepting hidden authority', () => {
  assert.throws(() => normalizeStepCompletions(['Gather'], [{ kind: 'deterministic', checkpoint: inventory, rationale: 'Skip verification' }]), /unexpected fields/)
  assert.throws(() => normalizeStepCompletions(['Assess'], [{ kind: 'semantic', rationale: 'Assess evidence', checkpoint: inventory }]), /unexpected fields/)
})

test('contract signature normalizes the same predicate shape consistently', () => {
  const reordered = { requirements: [{ minimum: 10, item_name: 'copper-ore', kind: 'inventory_count' }], mode: 'all' }
  assert.equal(completionContractSignature(inventory), completionContractSignature(reordered))
  const other = { ...inventory, requirements: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 11 }] }
  assert.notEqual(completionContractSignature(inventory), completionContractSignature(other))
})

// --- later steps declare {kind:"deterministic"} with no checkpoint (step contracts bind just in time) ----------------

test('a deterministic declaration with no checkpoint is a later step: accepted as is, refused with any extra member', () => {
  assert.deepEqual(normalizeStepCompletions(['Now', 'Later'], [{ kind: 'deterministic', checkpoint: inventory }, { kind: 'deterministic' }])[1], { kind: 'deterministic' })
  assert.deepEqual(normalizeStepCompletions(['Later'], [{ kind: 'deterministic', checkpoint: undefined }]), [{ kind: 'deterministic' }])
  assert.throws(() => normalizeStepCompletions(['Later'], [{ kind: 'deterministic', rationale: 'because' }]), /unexpected fields/)
  assert.throws(() => normalizeStepCompletions(['Later'], [{ kind: 'deterministic', checkpoint: null }]), /requires a supported checkpoint/)
})

test('normalizer and the submitPlan stepCompletions schema accept and refuse the same declarations', () => {
  const items = plannerControlToolDefinitions[0].function.parameters.properties.stepCompletions.items
  const table = [
    { kind: 'deterministic' },
    { kind: 'deterministic', checkpoint: inventory },
    { kind: 'semantic', rationale: 'Assess the observed site constraints.' },
    { kind: 'deterministic', checkpoint: null },
    { kind: 'deterministic', checkpoint: { mode: 'all', requirements: [] } },
    { kind: 'deterministic', checkpoint: { mode: 'all', requirements: [{ kind: 'invented_kind' }] } },
    { kind: 'deterministic', rationale: 'because' },
    { kind: 'semantic' },
    { kind: 'semantic', rationale: 'Assess.', checkpoint: inventory },
    { kind: 'automatic' },
    { checkpoint: inventory },
  ]
  for (const value of table) {
    let normalizerAccepts = true
    try { normalizeStepCompletions(['step'], [value]) }
    catch { normalizerAccepts = false }
    assert.equal(validatesAgainstSchema(value, items), normalizerAccepts, JSON.stringify(value))
  }
})

// --- the step contract call: packet and reply ---------------------------------------------------------------------

function committedSlice() {
  let state = applyPlanningEvent(createEmptyPlanningState(), { type: PLANNING_EVENT.GOAL_ACCEPTED, now: 1000, owner: 'louis', objective: 'Build toward a rocket-capable factory' })
  state = applyPlanningEvent(state, {
    type: PLANNING_EVENT.DRAFT_CREATED,
    now: 1200,
    steps: [
      { description: 'Gather ten iron ore', completion_mode: 'deterministic', completion_contract: inventory },
      { description: 'Smelt twenty iron plates', completion_mode: 'deterministic', contract_status: 'pending' },
      { description: 'Craft a pickaxe', completion_mode: 'deterministic', contract_status: 'pending' },
    ],
  })
  return applyPlanningEvent(state, { type: PLANNING_EVENT.PLAN_COMMITTED, now: 1300, runtime_validation: { passed: true } })
}

test('the packet is facts only: goal, step intents and statuses, verified results, the target and the facts; no strategy and no contracts of other steps', () => {
  const state = committedSlice()
  const plan = getActivePlan(state)
  const facts = { inventory: { 'iron-ore': 130 }, as_of: { tick: 5000 } }
  const packet = buildStepContractPacket({ planningState: state, stepId: plan.steps[1].step_id, facts })
  assert.deepEqual(Object.keys(packet), ['goal', 'done_when', 'slice', 'verified_results', 'target', 'facts'])
  assert.equal(packet.goal.objective, 'Build toward a rocket-capable factory')
  assert.deepEqual(packet.slice.steps.map(step => [step.description, step.status, step.contract]), [
    ['Gather ten iron ore', 'active', 'bound'],
    ['Smelt twenty iron plates', 'pending', 'pending'],
    ['Craft a pickaxe', 'pending', 'pending'],
  ])
  assert.deepEqual(packet.target, { step_id: plan.steps[1].step_id, index: 1, description: 'Smelt twenty iron plates' })
  assert.deepEqual(packet.facts, facts)
  assert.equal(JSON.stringify(packet).includes('minimum'), false, 'no contract content of any step is sent')
  assert.equal(Object.hasOwn(packet, 'assumed_outcome'), false)
  // A prediction call (later unit) states the outcome it assumes; the parameter is carried verbatim.
  const predicted = buildStepContractPacket({ planningState: state, stepId: plan.steps[1].step_id, facts, assumedOutcome: { active_step_contract_met: true } })
  assert.deepEqual(predicted.assumed_outcome, { active_step_contract_met: true })
  assert.equal(buildStepContractPacket({ planningState: state, stepId: 'nope' }), undefined)
  const message = stepContractUserMessage(packet)
  assert.ok(message.startsWith(`${STEP_CONTRACT_MARKER} `))
  assert.deepEqual(JSON.parse(message.slice(message.indexOf(' {"goal"') + 1)), packet)
  assert.match(stepContractCorrectionMessage('checkpoint_not_supported:x'), /^\[HARNESS\] checkpoint_not_supported:x; nothing was bound\.$/)
})

test('a contract reply is one JSON object for the target step with a supported deterministic checkpoint, repaired only in syntax', () => {
  const reply = { stepId: 'step_2', checkpoint: inventory }
  const ok = parseStepContractReply(JSON.stringify(reply), { stepId: 'step_2' })
  assert.equal(ok.ok, true)
  assert.equal(ok.checkpoint.requirements[0].item_name, 'copper-ore')
  assert.deepEqual(ok.repairs, [])
  assert.equal(parseStepContractReply(`\`\`\`json\n${JSON.stringify(reply)}\n\`\`\``, { stepId: 'step_2' }).ok, true, 'a fenced reply is unwrapped')
  const trailing = parseStepContractReply(`${JSON.stringify(reply).slice(0, -1)},}`, { stepId: 'step_2' })
  assert.equal(trailing.ok, true)
  assert.equal(trailing.repairs[0].kind, 'trailing_comma')
  const encoded = parseStepContractReply(JSON.stringify({ stepId: 'step_2', checkpoint: JSON.stringify(inventory) }), { stepId: 'step_2' })
  assert.equal(encoded.ok, true, 'a checkpoint sent as a JSON-encoded string is decoded once')
  assert.equal(encoded.repairs[0].kind, 'decoded_string')
  const refusals = {
    'empty reply': '',
    'not JSON': 'the checkpoint is ten copper ore',
    'an array': '[]',
    'another step': JSON.stringify({ stepId: 'step_3', checkpoint: inventory }),
    'no step id': JSON.stringify({ checkpoint: inventory }),
    'extra member': JSON.stringify({ stepId: 'step_2', checkpoint: inventory, rationale: 'x' }),
    'no checkpoint': JSON.stringify({ stepId: 'step_2' }),
    'checkpoint not an object': JSON.stringify({ stepId: 'step_2', checkpoint: 'ten copper ore' }),
    'unsupported predicate': JSON.stringify({ stepId: 'step_2', checkpoint: { mode: 'all', requirements: [{ kind: 'invented_kind' }] } }),
    'receipt that needs world verification': JSON.stringify({ stepId: 'step_2', checkpoint: { mode: 'all', requirements: [{ kind: 'authoritative_operation_receipt', operation_name: 'wait' }] } }),
  }
  for (const [name, content] of Object.entries(refusals)) {
    const result = parseStepContractReply(content, { stepId: 'step_2' })
    assert.equal(result.ok, false, name)
    assert.equal(typeof result.reason, 'string', name)
  }
})
