import test from 'node:test'
import assert from 'node:assert/strict'

import { parseOperation, renderOperation } from '../staging/structured-policy.mjs'
import { verifyDeterministicReceipt } from './canonical-task-board-memory.mjs'
import { toolCommand, toolDefinitions } from './structured-policy.mjs'

test('execute_construction_plan is a bounded operation tied to one validation id and placement count', () => {
  const operation = parseOperation({
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 3 },
  })

  assert.deepEqual(operation, {
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 3 },
  })
  assert.equal(
    renderOperation(operation),
    "remote.call('autorio_operations','execute_construction_plan',17,3)",
  )
  assert.throws(() => parseOperation({
    name: 'execute_construction_plan',
    args: { validation_id: 17, placement_count: 17 },
  }))
})

test('validateConstructionPlan emits one bounded live-world validation command', () => {
  const definition = toolDefinitions.find(tool => tool?.function?.name === 'validateConstructionPlan')
  assert.ok(definition)
  assert.equal(definition.function.parameters.properties.placements.maxItems, 16)

  assert.equal(
    toolCommand('validateConstructionPlan', {
      plan_id: 'starter-line',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0 },
      ],
    }),
    '/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","validate_construction_plan",{plan_id=\'starter-line\',placements={{entity_name=\'stone-furnace\',x=-2,y=0,direction=0},{entity_name=\'stone-furnace\',x=2,y=0}}})))',
  )
})

// Milestone 4 L2/L3: typed layout connections reach the mod request exactly, and the closed schema takes nothing else.
const FEED_PLAN = {
  plan_id: 'feed',
  placements: [
    { entity_name: 'wooden-chest', x: 0.5, y: -0.5, slot: 'src' },
    { entity_name: 'inserter', x: 0.5, y: 0.5, direction: 0, slot: 'ins' },
  ],
  connections: [{ kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'src' }, drop: { unit_number: 500 } }],
}
const validateCommand = args => toolCommand('validateConstructionPlan', args)
const lua = body => `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_planning","validate_construction_plan",${body})))`

test('validateConstructionPlan forwards slots and every connection kind to the mod request', () => {
  assert.equal(
    validateCommand(FEED_PLAN),
    lua("{plan_id='feed',placements={{entity_name='wooden-chest',x=0.5,y=-0.5,slot='src'},{entity_name='inserter',x=0.5,y=0.5,direction=0,slot='ins'}},connections={{kind='inserter',inserter={slot='ins'},pickup={slot='src'},drop={unit_number=500}}}}"),
  )
  const placements = [
    { entity_name: 'lab', x: 4.5, y: 0.5, slot: 'lab' },
    { entity_name: 'small-electric-pole', x: 7.5, y: 0.5, slot: 'pole' },
    { entity_name: 'burner-mining-drill', x: 2, y: 2, direction: 0, slot: 'drill' },
    { entity_name: 'pipe', x: 9.5, y: 0.5, slot: 'pipe' },
  ]
  assert.equal(
    validateCommand({
      plan_id: 'mixed',
      placements,
      connections: [
        { kind: 'power', pole: { slot: 'pole' }, consumer: { slot: 'lab' } },
        { kind: 'drill_output', drill: { slot: 'drill' }, receiver: { unit_number: 77 } },
        { kind: 'fluid', from: { slot: 'pipe' }, to: { unit_number: 78 } },
      ],
    }),
    lua("{plan_id='mixed',placements={{entity_name='lab',x=4.5,y=0.5,slot='lab'},{entity_name='small-electric-pole',x=7.5,y=0.5,slot='pole'},{entity_name='burner-mining-drill',x=2,y=2,direction=0,slot='drill'},{entity_name='pipe',x=9.5,y=0.5,slot='pipe'}},connections={{kind='power',pole={slot='pole'},consumer={slot='lab'}},{kind='drill_output',drill={slot='drill'},receiver={unit_number=77}},{kind='fluid',from={slot='pipe'},to={unit_number=78}}}}"),
  )
  // An empty list is the same request as none.
  const { connections: _connections, ...withoutConnections } = FEED_PLAN
  assert.equal(validateCommand({ ...FEED_PLAN, connections: [] }), validateCommand(withoutConnections))
})

test('validateConstructionPlan declares the layout fields in a closed schema and states what the result carries', () => {
  const { function: definition } = toolDefinitions.find(tool => tool?.function?.name === 'validateConstructionPlan')
  const { placements, connections } = definition.parameters.properties
  assert.equal(placements.maxItems, 16)
  assert.deepEqual(placements.items.required, ['entity_name', 'x', 'y'])
  assert.equal(placements.items.properties.slot.maxLength, 40)
  assert.equal(connections.maxItems, 8)
  assert.deepEqual(connections.items.oneOf.map(branch => branch.properties.kind.enum[0]), ['inserter', 'power', 'drill_output', 'fluid'])
  assert.ok(connections.items.oneOf.every(branch => branch.additionalProperties === false))
  assert.deepEqual(definition.parameters.required, ['plan_id', 'placements'])
  for (const field of ['planning_status', 'execution_eligible', 'eligibility_blockers', 'execution_order', 'virtual_proof', 'staged_requirement']) {
    assert.ok(definition.description.includes(field), `the description states ${field}`)
  }
})

test('validateConstructionPlan refuses malformed layouts before any command is built', () => {
  const plan = (connections, placements = FEED_PLAN.placements) => ({ plan_id: 'feed', placements, connections })
  const feed = FEED_PLAN.connections[0]
  const bad = [
    ['unknown slot', plan([{ ...feed, pickup: { slot: 'nope' } }])],
    ['the driver as a unit_number', plan([{ ...feed, inserter: { unit_number: 9 } }])],
    ['an endpoint with both keys', plan([{ ...feed, drop: { slot: 'src', unit_number: 5 } }])],
    ['an empty endpoint', plan([{ ...feed, drop: {} }])],
    ['a zero unit_number', plan([{ ...feed, drop: { unit_number: 0 } }])],
    ['a fractional unit_number', plan([{ ...feed, drop: { unit_number: 1.5 } }])],
    ['an unknown kind', plan([{ kind: 'belt', from: { slot: 'src' }, to: { slot: 'ins' } }])],
    ['a missing role', plan([{ kind: 'inserter', inserter: { slot: 'ins' }, pickup: { slot: 'src' } }])],
    ['an extra key', plan([{ ...feed, speed: 2 }])],
    ['a non-array list', plan(feed)],
    ['nine connections', plan(new Array(9).fill(feed))],
    ['a bad slot name', plan([feed], [{ ...FEED_PLAN.placements[0], slot: 'Src Chest' }, FEED_PLAN.placements[1]])],
    ['a 41-character slot', plan([feed], [{ ...FEED_PLAN.placements[0], slot: 'a'.repeat(41) }, FEED_PLAN.placements[1]])],
    ['a repeated slot', plan([feed], [FEED_PLAN.placements[0], { ...FEED_PLAN.placements[1], slot: 'src' }])],
    ['seven placements with a connection', plan([feed], [...FEED_PLAN.placements, ...Array.from({ length: 5 }, (_, index) => ({ entity_name: 'wooden-chest', x: index + 0.5, y: -4.5 }))])],
    ['an unknown top-level key', { ...plan([feed]), extra: true }],
  ]
  for (const [label, args] of bad) assert.throws(() => validateCommand(args), undefined, label)
  // Six placements with a connection and sixteen without are both inside the caps.
  const chests = count => Array.from({ length: count }, (_, index) => ({ entity_name: 'wooden-chest', x: index + 0.5, y: -4.5 }))
  assert.doesNotThrow(() => validateCommand(plan([feed], [...FEED_PLAN.placements, ...chests(4)])))
  assert.doesNotThrow(() => validateCommand({ plan_id: 'many', placements: chests(16) }))
})

test('completed execute_construction_plan receipt proves exactly the validated number of placement tasks', () => {
  const state = {
    last_operations: [
      'execute_construction_plan {"validation_id":17,"placement_count":3}',
    ],
  }
  const evidence = {
    kind: 'operation_receipt',
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 31,
      task_count: 3,
      task_types: ['placing', 'placing', 'placing'],
    }),
  }

  assert.deepEqual(verifyDeterministicReceipt(state, evidence), {
    verified: true,
    batchId: 31,
    taskTypes: ['placing', 'placing', 'placing'],
    operationNames: ['execute_construction_plan'],
  })

  const mismatched = {
    ...evidence,
    summary: JSON.stringify({
      outcome: 'completed',
      task_state: 'idle',
      queue_length: 0,
      batch_id: 32,
      task_count: 2,
      task_types: ['placing', 'placing'],
    }),
  }
  assert.deepEqual(verifyDeterministicReceipt(state, mismatched), {
    verified: false,
    reason: 'receipt_operation_mismatch',
  })
})
