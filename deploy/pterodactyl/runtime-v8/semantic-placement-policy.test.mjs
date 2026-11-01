import test from 'node:test'
import assert from 'node:assert/strict'

import {
  parseOperation,
  parsePlan,
  renderOperation,
  toolCommand,
  toolDefinitions,
} from './structured-policy.mjs'

test('runtime-v8 exposes semantic placement candidates alongside legacy placement planning', () => {
  const names = toolDefinitions.map(tool => tool.function?.name)
  assert.ok(names.includes('getPlacementCandidates'))
  assert.ok(names.includes('planPlacement'))
})

test('getPlacementCandidates renders a bounded mod-aware candidate request', () => {
  const command = toolCommand('getPlacementCandidates', {
    entity_name: 'modded-miner',
    center: { x: 10.5, y: -2.5 },
    radius: 12,
    target_resource: 'modded-ore',
    limit: 5,
  })

  assert.match(command, /remote\.call\("autorio_tools","get_placement_candidates"/)
  assert.match(command, /entity_name='modded-miner'/)
  assert.match(command, /center=\{x=10\.5,y=-2\.5\}/)
  assert.match(command, /radius=12/)
  assert.match(command, /target_resource='modded-ore'/)
  assert.match(command, /limit=5/)
})

test('place_candidate is admitted by id and rendered without retyping coordinates', () => {
  const parsed = parseOperation({
    name: 'place_candidate',
    args: {
      candidate_set_id: 'placement-18',
      candidate_id: 'candidate-3',
    },
  })

  assert.deepEqual(parsed, {
    name: 'place_candidate',
    args: {
      candidate_set_id: 'placement-18',
      candidate_id: 'candidate-3',
    },
  })
  assert.equal(
    renderOperation(parsed),
    "remote.call('autorio_operations','place_candidate','placement-18','candidate-3')",
  )
})

test('place_candidate rejects stale-shaped or injected references', () => {
  assert.throws(() => parseOperation({
    name: 'place_candidate',
    args: { candidate_set_id: 'placement-0', candidate_id: 'candidate-1' },
  }), /candidate_set_id is invalid/)
  assert.throws(() => parseOperation({
    name: 'place_candidate',
    args: { candidate_set_id: 'placement-1', candidate_id: "candidate-1');game.print('x" },
  }), /candidate_id is invalid/)
  assert.throws(() => parseOperation({
    name: 'place_candidate',
    args: { candidate_set_id: 'placement-1', candidate_id: 'candidate-1', x: 5 },
  }), /Unexpected argument/)
})

test('v8 parsePlan accepts place_candidate while preserving base operations', () => {
  const plan = parsePlan({
    chatMessage: 'Use the locally validated miner position.',
    plan: ['Place the selected miner candidate', 'Supply fuel'],
    currentStep: 0,
    operations: [
      {
        name: 'place_candidate',
        args: { candidate_set_id: 'placement-9', candidate_id: 'candidate-2' },
      },
      {
        name: 'supply_entity',
        args: { unit_number: 744, items: [{ item_name: 'coal', count: 10 }] },
      },
    ],
  })

  assert.equal(plan.operations[0].name, 'place_candidate')
  assert.equal(plan.operations[1].name, 'supply_entity')
})
