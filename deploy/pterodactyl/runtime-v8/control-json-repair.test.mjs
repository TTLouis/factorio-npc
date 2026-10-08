// Deterministic syntax repair of control replies (control-json-repair.mjs): what it repairs, and above all what it
// must never touch. The schema under test is the real planner submitPlan schema.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { repairControlJson, validatesAgainstSchema } from './control-json-repair.mjs'
import { plannerControlPayloadFromMessage, plannerControlToolDefinitions } from './structured-policy.mjs'

const SCHEMA = plannerControlToolDefinitions[0].function.parameters
const RUN_C = JSON.parse(readFileSync(new URL('./fixtures/control-json-repair-run-c-2026-10-08.json', import.meta.url), 'utf8'))

const GATHER = { name: 'gather_resource', args: { resource_name: 'iron-ore', count: 100, search_radius: 256 } }
const IRON_CHECKPOINT = { mode: 'all', requirements: [{ id: 'requirement_1', kind: 'inventory_count', item_name: 'iron-ore', minimum: 100 }] }

function submit(argumentsText) {
  return { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'submitPlan', arguments: argumentsText } }] }
}

// Every scalar and key of the repaired object must be in the model's own text, and replacing each repaired path
// in the strictly parsed original must give exactly the repaired object.
function walk(value, visit, path = '') {
  visit(value, path)
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`))
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, visit, path === '' ? key : `${path}.${key}`)
}
function getPath(root, path) {
  return path.split(/\.|(?=\[)/).filter(Boolean).reduce((value, part) => (part.startsWith('[') ? value[Number(part.slice(1, -1))] : value[part]), root)
}
function setPath(root, path, next) {
  const parts = path.split(/\.|(?=\[)/).filter(Boolean)
  const last = parts.pop()
  const holder = parts.reduce((value, part) => (part.startsWith('[') ? value[Number(part.slice(1, -1))] : value[part]), root)
  if (last.startsWith('[')) holder[Number(last.slice(1, -1))] = next
  else holder[last] = next
}
function assertOnlyTheModelsOwnValues(raw, repair) {
  const unescaped = raw.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  walk(repair.object, (value, path) => {
    if (value !== null && typeof value === 'object') {
      if (!Array.isArray(value)) for (const key of Object.keys(value)) assert.ok(raw.includes(`"${key}"`) || unescaped.includes(`"${key}"`), `key ${key} at ${path} is absent from the raw text`)
      return
    }
    const needle = typeof value === 'string' ? value : String(value)
    assert.ok(raw.includes(needle) || unescaped.includes(needle), `value ${JSON.stringify(value)} at ${path} is absent from the raw text`)
  })
  // Only the reported paths changed: put the repaired value back into the original and compare.
  let original
  try { original = JSON.parse(raw) }
  catch { return } // trailing-comma text has no strict parse; the value check above covers it
  const rebuilt = structuredClone(original)
  for (const { kind, path } of repair.repairs) if (kind === 'decoded_string') setPath(rebuilt, path, getPath(repair.object, path))
  assert.deepEqual(rebuilt, repair.object)
}

test('the run C reply (developmentMode "\\"vertical\\"") is repaired to the model\'s own value', () => {
  assert.equal(RUN_C.arguments.length, 972)
  assert.ok(RUN_C.arguments.startsWith(RUN_C.head_verbatim) && RUN_C.arguments.endsWith(RUN_C.tail_verbatim))
  assert.throws(() => plannerControlPayloadFromMessage(submit(RUN_C.arguments)), /developmentMode must be vertical/)

  const repair = repairControlJson(RUN_C.arguments, SCHEMA)
  assert.deepEqual(repair.repairs, [{ kind: 'decoded_string', path: 'developmentMode' }])
  const original = JSON.parse(RUN_C.arguments)
  assert.equal(original.developmentMode, '"vertical"')
  assert.equal(repair.object.developmentMode, 'vertical')
  assert.deepEqual({ ...repair.object, developmentMode: original.developmentMode }, original, 'nothing else moved')
  assert.deepEqual(JSON.parse(repair.text), repair.object)
  const payload = plannerControlPayloadFromMessage(submit(repair.text))
  assert.equal(payload.developmentMode, 'vertical')
  assert.deepEqual(payload.roadmapNodeIds, ['n3'])
  assert.equal(payload.stepCompletions.length, 3)
  assertOnlyTheModelsOwnValues(RUN_C.arguments, repair)
})

test('stringified operations, stepCompletions, checkpoint and other typed members are decoded once', () => {
  const raw = JSON.stringify({
    chatMessage: 'Mining.',
    plan: ['Mine 100 iron ore'],
    currentStep: '0',
    operations: JSON.stringify([GATHER]),
    stepCompletions: JSON.stringify([{ kind: 'deterministic', checkpoint: IRON_CHECKPOINT }]),
    checkpoint: JSON.stringify(IRON_CHECKPOINT),
    roadmapNodeIds: '["n3"]',
    developmentMode: '"horizontal"',
  })
  const repair = repairControlJson(raw, SCHEMA)
  assert.deepEqual(repair.repairs.map(item => item.path).sort(),
    ['checkpoint', 'currentStep', 'developmentMode', 'operations', 'roadmapNodeIds', 'stepCompletions'])
  assert.ok(repair.repairs.every(item => item.kind === 'decoded_string'))
  assert.deepEqual(repair.object, {
    chatMessage: 'Mining.',
    plan: ['Mine 100 iron ore'],
    currentStep: 0,
    operations: [GATHER],
    stepCompletions: [{ kind: 'deterministic', checkpoint: IRON_CHECKPOINT }],
    checkpoint: IRON_CHECKPOINT,
    roadmapNodeIds: ['n3'],
    developmentMode: 'horizontal',
  })
  const payload = plannerControlPayloadFromMessage(submit(repair.text))
  assert.deepEqual(payload.operations, [GATHER])
  assertOnlyTheModelsOwnValues(raw, repair)
})

test('entries and arguments that are themselves encoded are decoded where the schema describes them', () => {
  const raw = JSON.stringify({
    plan: ['a', 'b'],
    currentStep: 0,
    operations: [{ name: 'gather_resource', args: JSON.stringify(GATHER.args) }],
    stepCompletions: [
      JSON.stringify({ kind: 'deterministic', checkpoint: IRON_CHECKPOINT }),
      { kind: 'deterministic', checkpoint: JSON.stringify(IRON_CHECKPOINT) },
    ],
  })
  const repair = repairControlJson(raw, SCHEMA)
  assert.deepEqual(repair.repairs.map(item => item.path).sort(), ['operations[0].args', 'stepCompletions[0]', 'stepCompletions[1].checkpoint'])
  assert.deepEqual(repair.object.operations, [GATHER])
  assert.deepEqual(repair.object.stepCompletions, [
    { kind: 'deterministic', checkpoint: IRON_CHECKPOINT },
    { kind: 'deterministic', checkpoint: IRON_CHECKPOINT },
  ])
  assertOnlyTheModelsOwnValues(raw, repair)
})

test('free text is never decoded: a double-encoded chatMessage, plan step or rationale stays as written', () => {
  const raw = JSON.stringify({
    chatMessage: '"\\"hi\\""',
    plan: ['"quoted step"', '[1,2,3]', '{"not":"a plan"}'],
    currentStep: 0,
    operations: [],
    developmentMode: '"vertical"',
    stepCompletions: [{ kind: 'semantic', rationale: '"\\"because\\""' }],
    semanticCompletion: { stepId: '"step_2"', rationale: '[1]' },
  })
  const repair = repairControlJson(raw, SCHEMA)
  assert.deepEqual(repair.repairs, [{ kind: 'decoded_string', path: 'developmentMode' }])
  assert.equal(repair.object.chatMessage, '"\\"hi\\""')
  assert.deepEqual(repair.object.plan, ['"quoted step"', '[1,2,3]', '{"not":"a plan"}'])
  assert.equal(repair.object.stepCompletions[0].rationale, '"\\"because\\""')
  assert.deepEqual(repair.object.semanticCompletion, { stepId: '"step_2"', rationale: '[1]' })
  // With nothing else wrong there is nothing to repair at all.
  const onlyFreeText = JSON.stringify({ chatMessage: '"\\"hi\\""', plan: ['x'], currentStep: 0, operations: [] })
  assert.equal(repairControlJson(onlyFreeText, SCHEMA), undefined)
})

test('a decoded value of the wrong type, outside the enum, or invalid for its schema is not used', () => {
  const cases = {
    'enum member outside the closed set': { developmentMode: '"sideways"' },
    'a string where a closed set is expected is not decoded twice': { developmentMode: JSON.stringify(JSON.stringify('vertical')) },
    'object where an array is expected': { operations: '{"name":"gather_resource"}' },
    'array where an object is expected': { checkpoint: '[1,2]' },
    'string where an integer is expected': { currentStep: '"3"' },
    'integer outside its bounds': { currentStep: '99' },
    'noncanonical number spelling': { currentStep: '1e0' },
    'null': { checkpoint: 'null' },
    'array whose entries fail the schema (unknown operation name)': { operations: '[{"name":"rm_rf","args":{}}]' },
    'array whose entries fail the schema (extra member)': { operations: '[{"name":"gather_resource","args":{},"extra":1}]' },
    'not JSON at all': { operations: '[{name: gather}]' },
    'a stringified boolean is withheld (assessmentOnly must arrive as a real boolean)': { assessmentOnly: 'true' },
  }
  for (const [label, members] of Object.entries(cases)) {
    const raw = JSON.stringify({ plan: ['a'], currentStep: 0, operations: [], ...members })
    assert.equal(repairControlJson(raw, SCHEMA), undefined, label)
  }
})

test('a member whose raw value already satisfies the schema is left alone', () => {
  const raw = JSON.stringify({ plan: ['a'], currentStep: 0, operations: [], developmentMode: 'vertical', stepId: 'step_3' })
  assert.equal(repairControlJson(raw, SCHEMA), undefined)
})

test('trailing commas before } or ] are removed only outside strings and only when the text then parses', () => {
  const raw = '{"plan": ["a, b", "c,]"], "currentStep": 0, "operations": [{"name": "gather_resource", "args": {"resource_name": "iron-ore", "count": 100, "search_radius": 256,},},], "chatMessage": "x,}",}'
  assert.throws(() => JSON.parse(raw))
  const repair = repairControlJson(raw, SCHEMA)
  assert.deepEqual(repair.repairs, [
    { kind: 'trailing_comma', path: 'operations[0].args' },
    { kind: 'trailing_comma', path: 'operations[0]' },
    { kind: 'trailing_comma', path: 'operations' },
    { kind: 'trailing_comma', path: '' },
  ])
  assert.deepEqual(repair.object, { plan: ['a, b', 'c,]'], currentStep: 0, operations: [GATHER], chatMessage: 'x,}' })
  assert.equal(plannerControlPayloadFromMessage(submit(repair.text)).operations[0].args.search_radius, 256)
  assertOnlyTheModelsOwnValues(raw, repair)

  assert.equal(repairControlJson('{"plan": [], "currentStep": 0,, "operations": []}', SCHEMA), undefined, 'a doubled comma is not a trailing comma')
  assert.equal(repairControlJson('{"plan": ["a",], "currentStep": 0, "operations": [', SCHEMA), undefined, 'still unparseable after the repair')
  assert.equal(repairControlJson('{"a": [1, 2,}', SCHEMA), undefined, 'mismatched closer')
})

test('trailing commas and over-encoded members repair together, including inside a code fence', () => {
  const raw = '```json\n{"plan": ["a"], "currentStep": 0, "operations": "[]", "developmentMode": "\\"recover\\"",}\n```'
  const repair = repairControlJson(raw, SCHEMA)
  assert.deepEqual(repair.repairs, [
    { kind: 'trailing_comma', path: '' },
    { kind: 'decoded_string', path: 'operations' },
    { kind: 'decoded_string', path: 'developmentMode' },
  ])
  assert.deepEqual(repair.object, { plan: ['a'], currentStep: 0, operations: [], developmentMode: 'recover' })
})

test('nothing to repair, or not a JSON object, gives no repair', () => {
  assert.equal(repairControlJson(JSON.stringify({ plan: ['a'], currentStep: 0, operations: [] }), SCHEMA), undefined)
  assert.equal(repairControlJson('', SCHEMA), undefined)
  assert.equal(repairControlJson('I will mine iron now.', SCHEMA), undefined)
  assert.equal(repairControlJson('[1,2,]', SCHEMA), undefined)
  assert.equal(repairControlJson(undefined, SCHEMA), undefined)
  assert.equal(repairControlJson('{"a":1,}', undefined), undefined)
})

test('the schema validator agrees with the control tool schema on a valid and an invalid plan', () => {
  assert.equal(validatesAgainstSchema({ plan: ['a'], currentStep: 0, operations: [GATHER] }, SCHEMA), true)
  assert.equal(validatesAgainstSchema({ plan: ['a'], currentStep: 0 }, SCHEMA), false, 'required operations')
  assert.equal(validatesAgainstSchema({ plan: ['a'], currentStep: 31, operations: [] }, SCHEMA), false)
  assert.equal(validatesAgainstSchema({ plan: ['a'], currentStep: 0, operations: [], developmentMode: 'sideways' }, SCHEMA), false)
})
