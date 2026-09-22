import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTypedOperationCandidates,
  parseTypedProjection,
  typedProjectionQuestions,
  typedProjectionTypeCatalog,
} from './jev-typed-projection.mjs'

test('typed projection uses one coherent Choice over complete candidates and fallback routes', () => {
  const candidates = [
    {
      id: 'iron-near',
      operation: {
        name: 'gather_resource',
        args: { resource_name: 'iron-ore', count: 20, search_radius: 128 },
      },
      description: 'Gather the already-requested twenty iron ore from the observed nearby patch.',
    },
    {
      id: 'copper-near',
      operation: {
        name: 'gather_resource',
        args: { resource_name: 'copper-ore', count: 20, search_radius: 128 },
      },
    },
  ]

  const questions = typedProjectionQuestions({ scope: 'resources', candidates })
  assert.deepEqual(Object.keys(questions), ['projection_action'])
  assert.equal(questions.projection_action.type, 'choice')
  assert.deepEqual(Object.keys(questions.projection_action.criteria), [
    'candidate_1',
    'candidate_2',
    'need_observation',
    'wake_planner',
    'ask_user',
  ])
  assert.equal(Object.hasOwn(questions, 'operation_type'), false)
  assert.equal(Object.hasOwn(questions, 'operation_candidate'), false)
})

test('typed projection retrieves the exact prevalidated candidate selected by Jev', () => {
  const candidates = [{
    id: 'recipe-1',
    operation: {
      name: 'set_machine_recipe',
      args: { unit_number: 44, recipe_name: 'iron-gear-wheel' },
    },
  }]

  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_1',
        probabilities: {
          candidate_1: 0.91,
          need_observation: 0.03,
          wake_planner: 0.05,
          ask_user: 0.01,
        },
        confidence: 0.86,
      },
    },
  }, { scope: 'production', candidates })

  assert.equal(result.route, 'emit_operation')
  assert.equal(result.candidate_id, 'recipe-1')
  assert.equal(result.operation_type, 'set_machine_recipe')
  assert.deepEqual(result.operation, candidates[0].operation)
  assert.equal(result.risk, 'moderate')
  assert.equal(result.confidence, 0.86)
})

test('typed projection fallback routes carry no invented operation', () => {
  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'need_observation',
        probabilities: {
          need_observation: 0.8,
          wake_planner: 0.15,
          ask_user: 0.05,
        },
        confidence: 0.7,
      },
    },
  }, { scope: 'resources', candidates: [] })

  assert.equal(result.route, 'need_observation')
  assert.equal(result.operation, undefined)
  assert.equal(result.candidate_id, undefined)
})

test('typed projection rejects candidates outside the active scope before asking Jev', () => {
  assert.throws(
    () => normalizeTypedOperationCandidates('research', [{
      id: 'bad-scope',
      operation: {
        name: 'gather_resource',
        args: { resource_name: 'iron-ore', count: 1, search_radius: 64 },
      },
    }]),
    /outside scope research/,
  )
})

test('typed projection fails closed when the response does not select a supplied action', () => {
  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_99',
      },
    },
  }, {
    scope: 'research',
    candidates: [{
      id: 'automation',
      operation: {
        name: 'research_technology',
        args: { technology_name: 'automation' },
      },
    }],
  })

  assert.equal(result.route, 'wake_planner')
  assert.equal(result.operation, undefined)
  assert.equal(result.projection_failure, 'unknown_projection_action')
})

test('typed projection scope catalogs come from authoritative operation metadata', () => {
  const production = typedProjectionTypeCatalog('production')
  const names = production.map(entry => entry.name)
  assert.ok(names.includes('supply_entity'))
  assert.ok(names.includes('move_items_exact'))
  assert.ok(names.includes('set_machine_recipe'))
  assert.ok(names.includes('craft_item'))
  assert.ok(production.every(entry => entry.scopes.includes('production')))
  assert.ok(production.every(entry => entry.arguments && typeof entry.arguments === 'object'))
})
