// The real NpcAgentLoop with deterministic control-JSON repair: a malformed control reply is repaired in code and
// admitted without a model retry, a reply whose content is wrong is not repaired, and a repair whose result still
// fails goes down today's retry path. Traces carry request_id, round and the reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { answersStepContract, FakeFactorio, gather, inventoryCheckpoint, planReply, recordingJev } from './task-loop-fixtures.mjs'

const RUN_C = JSON.parse(readFileSync(new URL('./fixtures/control-json-repair-run-c-2026-10-08.json', import.meta.url), 'utf8'))

function submitCall(argumentsText) {
  return { content: '', tool_calls: [{ id: 'p1', type: 'function', function: { name: 'submitPlan', arguments: argumentsText } }] }
}

function validPlanArguments(extra = {}) {
  return {
    plan: ['Gather 10 coal'],
    currentStep: 0,
    operations: [gather('coal', 10)],
    ...extra,
  }
}

function makeAgent(provider, { goalAnswers, extra = {} } = {}) {
  const game = new FakeFactorio()
  const jev = recordingJev(async (_state, questions) => {
    if (questions.goal_scope && goalAnswers) return { overrides: goalAnswers }
    return questions.intent ? { overrides: { intent: { choice: 'new_goal', confidence: 0.9 } } } : undefined
  })
  const traces = []
  const agent = new NpcAgentLoop({
    rcon: game,
    memory: new CanonicalTaskBoardMemory(),
    provider: answersStepContract(async (...args) => provider(...args)),
    interactionProvider: async () => ({ content: JSON.stringify({ intent: 'new_goal', queue_conflict: false, reply: '' }) }),
    interactionDecisionProvider: jev,
    steeringDecisionProvider: jev,
    systemPrompt: 'control json repair',
    stateFile: null,
    traceFile: null,
    decisionTraceFile: null,
    npcId: 'sgluna',
    ...extra,
  })
  const write = agent.traceEvent.bind(agent)
  agent.traceEvent = (event, data, options) => { traces.push({ event, data }); return write(event, data, options) }
  const rows = name => traces.filter(row => row.event === name)
  return { agent, game, traces, rows }
}

// Live run C was a later slice of a long-horizon goal, where a semantic step is allowed. A fresh goal in this
// harness world refuses semantic steps (semantic_step_in_execution_plan) whatever the repair did, so that one
// entry is swapped for a deterministic one. The over-encoded tail the test is about is left byte for byte.
const SEMANTIC_ENTRY = /\{"kind":"semantic","rationale":"[^"]*"\}/
const DETERMINISTIC_ENTRY = '{"kind":"deterministic","checkpoint":{"mode":"all","requirements":[{"id":"requirement_1","kind":"inventory_count","item_name":"iron-plate","minimum":75}]}}'

test('the run C reply is repaired and accepted with no model retry', async () => {
  let calls = 0
  const args = RUN_C.arguments.replace(SEMANTIC_ENTRY, DETERMINISTIC_ENTRY)
  assert.notEqual(args, RUN_C.arguments)
  assert.ok(args.endsWith(RUN_C.tail_verbatim))
  const { agent, game, traces, rows } = makeAgent(async () => {
    calls++
    return submitCall(args)
  })
  game.knownTechnologies.add('logistic-science-pack')
  const result = await agent.request('gather 100 iron ore', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1, 'no second model round')
  assert.equal(game.mutations.length, 1)

  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.equal(typeof repaired[0].data.request_id, 'string')
  assert.equal(repaired[0].data.round, 0)
  assert.equal(repaired[0].data.reason, 'deterministic_syntax_repair')
  assert.deepEqual(repaired[0].data.repairs, [{ kind: 'decoded_string', path: 'developmentMode' }])
  assert.equal(rows('provider.control_json_repair_failed').length, 0)
  // The model's own value reaches the plan; the truncation salvage that used to drop it never ran.
  assert.equal(rows('provider.plan_submission_salvaged').length, 0)
  assert.equal(rows('plan.accepted')[0].data.development_mode, 'vertical')
  // The repair is traced after the strict refusal it replaced and before the plan is accepted.
  // The tool-path repair is reported once the repaired plan has passed the strict parse, so after plan_submission.
  const order = traces.map(row => row.event)
  assert.ok(order.indexOf('provider.plan_submission_invalid') < order.indexOf('provider.plan_submission'))
  assert.ok(order.indexOf('provider.plan_submission') < order.indexOf('provider.control_json_repaired'))
  assert.ok(order.indexOf('provider.control_json_repaired') < order.indexOf('plan.accepted'))
})

test('a deeper over-encoding (stringified stepCompletions) is repaired on the content path with the same trace', async () => {
  let calls = 0
  const checkpoint = inventoryCheckpoint('coal', 10)
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    return submitCall(JSON.stringify(validPlanArguments({
      stepCompletions: JSON.stringify([{ kind: 'deterministic', checkpoint }]),
    })))
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1)
  assert.equal(game.mutations.length, 1)
  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].data.source, 'content')
  assert.equal(repaired[0].data.reason, 'deterministic_syntax_repair')
  assert.equal(typeof repaired[0].data.request_id, 'string')
  assert.equal(repaired[0].data.round, 0)
  assert.deepEqual(repaired[0].data.repairs, [{ kind: 'decoded_string', path: 'stepCompletions' }])
})

test('a JSON control object with trailing commas in assistant content is repaired without a retry', async () => {
  let calls = 0
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    const body = JSON.stringify({ chatMessage: 'Gathering', ...validPlanArguments({ checkpoint: inventoryCheckpoint('coal', 10) }) })
    return { content: `${body.replace('}}]', '}},]').slice(0, -1)},}` }
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1)
  assert.equal(game.mutations.length, 1)
  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].data.source, 'content')
  assert.ok(repaired[0].data.repairs.length >= 1 && repaired[0].data.repairs.every(item => item.kind === 'trailing_comma'))
})

test('a reply whose content is wrong (invalid enum value) is not repaired and goes to the retry path', async () => {
  let calls = 0
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    if (calls === 1) {
      return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10), developmentMode: 'sideways' })
    }
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10), developmentMode: 'vertical' })
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 2, 'the model was asked again')
  assert.equal(game.mutations.length, 1)
  assert.equal(rows('provider.control_json_repaired').length, 0)
  assert.equal(rows('provider.control_json_repair_failed').length, 0)
})

test('a repair whose result still fails validation is traced as failed and the old retry runs', async () => {
  let calls = 0
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    if (calls === 1) {
      // The stringified operations decode to an array the control schema accepts, but gather_resource without its
      // arguments is refused by the strict operation parser, exactly as it would be if sent unencoded.
      return planReply({ plan: ['Gather 10 coal'], operations: JSON.stringify([{ name: 'gather_resource', args: {} }]), checkpoint: inventoryCheckpoint('coal', 10) })
    }
    return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 2, 'the failed repair falls through to the existing retry')
  assert.equal(game.mutations.length, 1)
  assert.equal(rows('provider.control_json_repaired').length, 0)
  const failed = rows('provider.control_json_repair_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.reason, 'repaired_form_still_invalid')
  assert.equal(typeof failed[0].data.request_id, 'string')
  assert.equal(failed[0].data.round, 0)
  assert.deepEqual(failed[0].data.repairs, [{ kind: 'decoded_string', path: 'operations' }])
})

test('submitPlan arguments with trailing commas are repaired before the truncation salvage, keeping every member', async () => {
  let calls = 0
  const arguments_ = `${JSON.stringify(validPlanArguments({ checkpoint: inventoryCheckpoint('coal', 10), developmentMode: 'maintain' })).replace('}}]', '}},]').slice(0, -1)},}`
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    return submitCall(arguments_)
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 1)
  assert.equal(game.mutations.length, 1)
  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.equal(repaired[0].data.source, 'submit_plan_arguments')
  assert.equal(repaired[0].data.round, 0)
  assert.deepEqual(repaired[0].data.repairs.map(item => item.kind), ['trailing_comma', 'trailing_comma'])
  assert.equal(rows('provider.plan_submission_salvaged').length, 0)
  assert.equal(rows('plan.accepted')[0].data.development_mode, 'maintain', 'the last member survives; salvage would have dropped it')
})

test('a tool-path repair whose plan then fails the strict parse is reported as failed, not repaired', async () => {
  let calls = 0
  // Trailing comma (repairable) plus a stepCompletions entry the strict parser refuses (a deterministic checkpoint with no
  // requirements; a deterministic entry with NO checkpoint is a valid later step since step contracts bind just in time).
  const broken = `${JSON.stringify(validPlanArguments({ stepCompletions: [{ kind: 'deterministic', checkpoint: { mode: 'all', requirements: [] } }] })).slice(0, -1)},}`
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    return calls === 1 ? submitCall(broken) : planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
  })
  const result = await agent.request('gather 10 coal', { sender: 'Louis' })

  assert.equal(result.goalStatus, 'active')
  assert.equal(calls, 2)
  assert.equal(game.mutations.length, 1)
  assert.equal(rows('provider.control_json_repaired').length, 0)
  const failed = rows('provider.control_json_repair_failed')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.source, 'submit_plan_arguments')
  assert.equal(failed[0].data.reason, 'repaired_form_still_invalid')
  assert.equal(typeof failed[0].data.request_id, 'string')
  assert.equal(failed[0].data.round, 0)
})

test('sibling tool calls are never silently dropped: no repair and no truncation salvage on a multi-call reply', async () => {
  let calls = 0
  const overEncoded = JSON.stringify(validPlanArguments({ developmentMode: '"vertical"' }))
  const truncated = '{"chatMessage":"Harvesting wood","plan":["Harvest 3 wood"],"currentStep":0,"operations":[{"name":"harvest_product","args":{"product_name":"wood","count":3,"search_radius":256}}],"checkpoint"::'
  for (const args of [overEncoded, truncated]) {
    calls = 0
    const { agent, game, rows } = makeAgent(async () => {
      calls++
      if (calls === 1) {
        return { content: '', tool_calls: [
          { id: 'p1', type: 'function', function: { name: 'submitPlan', arguments: args } },
          { id: 'o1', type: 'function', function: { name: 'getInventoryItems', arguments: '{}' } },
        ] }
      }
      return planReply({ plan: ['Gather 10 coal'], operations: [gather('coal', 10)], checkpoint: inventoryCheckpoint('coal', 10) })
    })
    const result = await agent.request('gather 10 coal', { sender: 'Louis' })
    assert.equal(result.goalStatus, 'active')
    assert.equal(game.mutations.length, 1)
    assert.equal(rows('provider.control_json_repaired').length, 0, args.slice(0, 40))
    assert.equal(rows('provider.control_json_repair_failed').length, 0)
    assert.equal(rows('provider.plan_submission_salvaged').length, 0)
    assert.equal(rows('provider.plan_submission_invalid').length, 1)
  }
})

// --- stateful checks: repair must never re-run a parse that already touched goal-definition state -----------------

const FINITE_ROCKET = { scope: 'finite', summary: 'Launch one rocket from this save.', doneWhen: [{ id: 'rocket', kind: 'rockets_launched', minimum: 1 }] }
const GOAL_REQUIRED = { goalDefinitionPolicy: 'required' }
const goalReply = (extra = {}) => planReply({
  plan: ['Gather 10 iron ore'], operations: [gather('iron-ore', 10)], checkpoint: inventoryCheckpoint('iron-ore', 10), ...extra,
})

test('a goal challenge is not bypassed by a repair: the challenge fails once and is not re-run on a repaired copy', async () => {
  const prompts = []
  let calls = 0
  // roadmapNodeIds as a string would be repaired, but the strict parse only ignores it, so it never fails by itself.
  const { agent, game, rows } = makeAgent(async (messages) => {
    calls++
    prompts.push(messages.map(message => String(message?.content ?? '')).join('\n'))
    return goalReply({ goal: FINITE_ROCKET, roadmapNodeIds: '["n3"]' })
  }, {
    goalAnswers: { goal_scope: { choice: 'long_horizon', confidence: 0.85 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } },
    extra: GOAL_REQUIRED,
  })
  const result = await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2, 'the single corrective challenge costs one model round')
  assert.match(prompts[1], /goal_reading_disagreement/)
  assert.equal(result.goalStatus, 'active', 'the planner then has the last word')
  assert.equal(game.mutations.length, 1)
  assert.equal(rows('provider.control_json_repaired').length, 0)
  assert.equal(rows('provider.control_json_repair_failed').length, 0)
})

test('one corrective goal retry is not turned into a goal block by a repair', async () => {
  let calls = 0
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    return calls === 1
      ? goalReply({ roadmapNodeIds: '["n3"]' }) // no goal on a first plan: goal_definition_required, once
      : goalReply({ goal: FINITE_ROCKET })
  }, { extra: GOAL_REQUIRED })
  const result = await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.notEqual(result.blocked, true)
  assert.equal(result.goalStatus, 'active')
  assert.equal(agent.goalDefinitionBlock ?? null, null)
  assert.equal(game.mutations.length, 1)
  assert.equal(rows('provider.control_json_repaired').length, 0)
})

test('a pure shape error under the goal policy is still repaired, and the repaired plan meets the goal checks once', async () => {
  let calls = 0
  const { agent, game, rows } = makeAgent(async () => {
    calls++
    return goalReply({ goal: FINITE_ROCKET, developmentMode: '"vertical"' })
  }, {
    goalAnswers: { goal_scope: { choice: 'finite', confidence: 0.9 }, goal_family: { choice: 'rocket_launch', confidence: 0.9 } },
    extra: GOAL_REQUIRED,
  })
  const result = await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 1)
  assert.equal(result.goalStatus, 'active')
  assert.equal(game.mutations.length, 1)
  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.deepEqual(repaired[0].data.repairs, [{ kind: 'decoded_string', path: 'developmentMode' }])
})

test('a repaired copy refused by an early goal-definition error is treated as if the model sent it: the goal error stands, counted once', async () => {
  const prompts = []
  const seen = []
  let calls = 0
  const checkpoint = inventoryCheckpoint('iron-ore', 10)
  const { agent, game, rows } = makeAgent(async (messages) => {
    calls++
    prompts.push(messages.map(message => String(message?.content ?? '')).join('\n'))
    seen.push({ retries: agent.goalDefinitionRetries, block: agent.goalDefinitionBlock })
    return calls === 1
      // Stringified stepCompletions fails the shape half first; once repaired, the invalid goal scope is the real problem.
      ? goalReply({ goal: { ...FINITE_ROCKET, scope: 'bogus' }, stepCompletions: JSON.stringify([{ kind: 'deterministic', checkpoint }]) })
      : goalReply({ goal: FINITE_ROCKET })
  }, { extra: GOAL_REQUIRED })
  const result = await agent.request('launch a rocket', { sender: 'Louis' })

  assert.equal(calls, 2)
  assert.match(prompts[1], /goal\.scope must be/, 'the model is told about the goal error, not the hidden shape error')
  assert.equal(seen[1].retries, 1, 'one goal error counted once')
  assert.ok(!seen[1].block, 'no block after a single goal correction')
  assert.equal(result.goalStatus, 'active')
  assert.equal(game.mutations.length, 1)
  const repaired = rows('provider.control_json_repaired')
  assert.equal(repaired.length, 1)
  assert.deepEqual(repaired[0].data.repairs, [{ kind: 'decoded_string', path: 'stepCompletions' }])
  assert.equal(rows('provider.control_json_repair_failed').length, 0)
})
