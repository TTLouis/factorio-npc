import assert from 'node:assert/strict'
import test from 'node:test'
import { repairControlJson, validatesAgainstSchema } from './control-json-repair.mjs'
import { authoredCompletionContractSupported, COMPLETION_CONTRACT_SCHEMA, evaluateCompletionContract, sanitizeStepCompletionContract } from './step-completion.mjs'
import { STEP_CONTRACT_SCHEMA, parseStepContractReply } from './luna-step-contracts.mjs'
import { executionOnlyControlToolDefinitions, plannerControlToolDefinitions, planningOnlyControlToolDefinitions } from './structured-policy.mjs'

const checkpoint = (...requirements) => ({ mode: 'all', requirements })
const engine = { kind: 'entity_count', prototype: 'steam-engine', minimum: 1 }
const surfaces = [
  plannerControlToolDefinitions[0].function.parameters.properties.checkpoint,
  planningOnlyControlToolDefinitions[0].function.parameters.properties.checkpoint,
  executionOnlyControlToolDefinitions[0].function.parameters.properties.checkpoint,
  plannerControlToolDefinitions[0].function.parameters.properties.stepCompletions.items.oneOf[0].properties.checkpoint,
  STEP_CONTRACT_SCHEMA.properties.checkpoint,
]

test('planner, executor, draft and JIT advertise one canonical contract with the native anchored-scope constraint', () => {
  const missingRadius = checkpoint({ ...engine, anchor: { x: -69.5, y: -65 } }) // exact Run AK terminal scope
  for (const schema of surfaces) {
    assert.deepEqual(schema, COMPLETION_CONTRACT_SCHEMA)
    assert.equal(validatesAgainstSchema(missingRadius, schema), false)
    assert.equal(validatesAgainstSchema(checkpoint({ ...engine, radius: 8, anchor: { x: -69.5, y: -65 } }), schema), true)
  }
  assert.equal(authoredCompletionContractSupported(missingRadius), false, 'malformed scope must remain invalid')
  assert.equal(parseStepContractReply(JSON.stringify({ stepId: 'engine', checkpoint: missingRadius }), { stepId: 'engine' }).ok, false)
})

test('every advertised canonical requirement variant is accepted by the production authoring validator', () => {
  const examples = [
    { kind: 'inventory_count', item_name: 'inserter', minimum: 1 },
    { kind: 'research_completed', technology: 'automation' },
    engine,
    { ...engine, radius: 256, state: 'powered' },
    { ...engine, radius: 1, anchor: { x: 0, y: -10000256 }, state: 'working' },
    { kind: 'entity_inventory_count', unit_number: 35, item_name: 'coal', minimum: 3 },
    { kind: 'entity_exists', unit_number: 35 },
    { kind: 'entity_state', unit_number: 35, expected: 'not_working' },
    { kind: 'authoritative_operation_receipt', operation_name: 'execute_construction_plan' },
    { kind: 'runtime_controller_state', controller: 'follow', expected: 'healthy' },
  ]
  for (const requirement of examples) {
    for (const mode of ['all', 'any']) {
      const value = { mode, requirements: [requirement] }
      assert.equal(validatesAgainstSchema(value, COMPLETION_CONTRACT_SCHEMA), true, JSON.stringify(value))
      assert.equal(authoredCompletionContractSupported(value), true, JSON.stringify(value))
    }
  }
})

test('canonical schemas reject malformed field combinations and limits before they can become completion claims', () => {
  const invalid = [
    { kind: 'inventory_count', minimum: 1 },
    { kind: 'inventory_count', item_name: '  ', minimum: 1 },
    { kind: 'research_completed', technology: 'not a native name' },
    { ...engine, prototype: 'not a native name' },
    { ...engine, radius: 0 }, { ...engine, radius: 257 }, { ...engine, radius: 2.5 },
    { ...engine, radius: 8, anchor: { x: 10000257, y: 0 } },
    { ...engine, radius: 8, anchor: { x: 1 } },
    { ...engine, state: 'connected' },
    { ...engine, minimum: 0 }, { ...engine, minimum: 1.5 }, { ...engine, minimum: Number.MAX_SAFE_INTEGER + 1 },
    { kind: 'entity_exists', prototype: 'boiler', minimum: 1 },
    { kind: 'entity_state', unit_number: 35, expected: 'powered' },
    { kind: 'entity_inventory_count', item_name: 'coal', minimum: 1 },
    { kind: 'runtime_controller_state', controller: 'follow', expected: 'started' },
    { kind: 'authoritative_operation_receipt', operation_name: 'wait' },
    { kind: 'fluid_connected', unit_number: 35 },
  ]
  for (const requirement of invalid) {
    const value = checkpoint(requirement)
    assert.equal(validatesAgainstSchema(value, COMPLETION_CONTRACT_SCHEMA), false, JSON.stringify(value))
    assert.equal(authoredCompletionContractSupported(value), false, JSON.stringify(value))
  }
})

test('a six-item construction kit can declare all materials; one missing inserter prevents completion', () => {
  const kit = [['offshore-pump', 1], ['boiler', 1], ['pipe', 8], ['small-electric-pole', 4], ['inserter', 1], ['wooden-chest', 1]]
  const value = checkpoint(...kit.map(([item_name, minimum]) => ({ kind: 'inventory_count', item_name, minimum })))
  assert.equal(validatesAgainstSchema(value, COMPLETION_CONTRACT_SCHEMA), true)
  const normalized = sanitizeStepCompletionContract(value)
  const facts = Object.fromEntries(normalized.requirements.map(r => [r.id, { kind: r.kind, item_name: r.item_name, current: r.minimum }]))
  facts.requirement_5.current = 0
  assert.equal(evaluateCompletionContract(value, facts).satisfied, false)
  facts.requirement_5.current = 1
  assert.equal(evaluateCompletionContract(value, facts).satisfied, true)
  for (const size of [0, 9]) {
    const tooMany = checkpoint(...Array.from({ length: size }, (_, i) => ({ ...engine, id: `r${i}` })))
    assert.equal(validatesAgainstSchema(tooMany, COMPLETION_CONTRACT_SCHEMA), false)
    assert.equal(authoredCompletionContractSupported(tooMany), false)
  }
})

test('legacy unambiguous aliases remain readable without widening the canonical model schema', () => {
  const historical = checkpoint({ kind: 'inventory_count', item: 'coal', count: '20' })
  assert.equal(authoredCompletionContractSupported(historical), true)
  assert.equal(validatesAgainstSchema(historical, COMPLETION_CONTRACT_SCHEMA), false)
  assert.equal(sanitizeStepCompletionContract(historical).requirements[0].minimum, 20)
})

test('canonical union schemas preserve one-level encoded discriminators and anchors without changing scope', () => {
  const schema = { type: 'object', properties: { checkpoint: COMPLETION_CONTRACT_SCHEMA } }
  const anchored = { ...engine, kind: '"entity_count"', radius: 8, anchor: '{"x":-69.5,"y":-65}' }
  const repaired = repairControlJson(JSON.stringify({ checkpoint: checkpoint(anchored) }), schema)
  assert.ok(repaired)
  assert.deepEqual(repaired.object.checkpoint.requirements[0], { ...engine, radius: 8, anchor: { x: -69.5, y: -65 } })
  assert.deepEqual(repaired.repairs.map(r => r.path).sort(), ['checkpoint.requirements[0].anchor', 'checkpoint.requirements[0].kind'])
  assert.equal(authoredCompletionContractSupported(repaired.object.checkpoint), true)
  const inventory = repairControlJson(JSON.stringify({ checkpoint: checkpoint({ kind: '"inventory_count"', item_name: 'coal', minimum: 20 }) }), schema)
  assert.equal(inventory.object.checkpoint.requirements[0].kind, 'inventory_count')
  const missingRadius = { ...anchored }; delete missingRadius.radius
  const refused = repairControlJson(JSON.stringify({ checkpoint: checkpoint(missingRadius) }), schema)
  assert.equal(authoredCompletionContractSupported(refused?.object.checkpoint ?? checkpoint(missingRadius)), false)
})
