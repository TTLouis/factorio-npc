import assert from 'node:assert/strict'
import test from 'node:test'

import { CanonicalTaskBoardMemory } from './canonical-task-board-memory.mjs'
import { NpcAgentLoop } from './npc-agent-loop.mjs'
import { COMPACT_CONTINUATION_PROMPT } from './provider-base.mjs'
import { RUNTIME_RELIABILITY_GUIDANCE } from './supervisor.mjs'
import {
  approvedOperationListText,
  approvedOperationNames,
  plannerControlToolDefinitions,
} from './structured-policy.mjs'

// "What the model is told", finding 1: the full and the compact prompt render
// their operation list from the runtime catalog, so neither can drift from it.

function fullPrompt() {
  const agent = new NpcAgentLoop({
    rcon: { command: async () => '{}' },
    provider: async () => { throw new Error('no provider call') },
    memory: new CanonicalTaskBoardMemory(),
    systemPrompt: 'base prompt',
    stateFile: null,
    traceFile: null,
  })
  return agent.systemPrompt
}

test('operation list names every approved operation with its argument keys', () => {
  const text = approvedOperationListText()
  for (const name of approvedOperationNames()) {
    assert.ok(text.includes(`${name} {`), `${name} missing from the generated list`)
  }
  // The three operations the hand-written full prompt used to omit.
  assert.match(text, /place_candidate \{candidate_set_id,candidate_id\}/)
  assert.match(text, /execute_construction_plan \{validation_id,placement_count\}/)
  assert.match(text, /launch_rocket \{unit_number\}/)
  assert.match(text, /supply_entity \{unit_number,items:\[\{item_name,count\}\]\}/)
  assert.match(text, /place_entity \{entity_name,x\?,y\?,direction\?\}/)
})

test('operation list is deterministic, so the prompt prefix stays byte-stable', () => {
  assert.equal(approvedOperationListText(), approvedOperationListText())
  assert.equal(fullPrompt(), fullPrompt())
})

test('full and compact prompts carry the identical generated list', () => {
  const text = approvedOperationListText()
  assert.ok(fullPrompt().includes(text), 'full prompt must include the generated list')
  assert.ok(COMPACT_CONTINUATION_PROMPT.includes(text), 'compact prompt must include the generated list')
})

test('compact prompt names the planner protocol and the time tools, and says SGLuna', () => {
  for (const term of ['submitPlan', 'checkpoint', 'semanticCompletion', 'estimateProductionTime', 'getMiningDetails']) {
    assert.ok(COMPACT_CONTINUATION_PROMPT.includes(term), `${term} missing from the compact prompt`)
  }
  assert.ok(COMPACT_CONTINUATION_PROMPT.startsWith('You are SGLuna,'))
  assert.doesNotMatch(COMPACT_CONTINUATION_PROMPT, /AIRI/)
})

test('the model is told how many observations a decision allows and that gather operations find their own target', () => {
  assert.match(RUNTIME_RELIABILITY_GUIDANCE, /Observation budget: a decision allows only about 3 rounds of fresh read-only calls, at most 4 calls per turn/)
  assert.match(RUNTIME_RELIABILITY_GUIDANCE, /gather_resource, harvest_product and walk_to_entity find their own target within search_radius/)
  assert.match(RUNTIME_RELIABILITY_GUIDANCE, /observation_budget_remaining/)
})

test('submitPlan.operations[].name is an enum of the approved operation names', () => {
  const submitPlan = plannerControlToolDefinitions.find(tool => tool.function.name === 'submitPlan')
  const name = submitPlan.function.parameters.properties.operations.items.properties.name
  assert.deepEqual(name.enum, approvedOperationNames())
})
