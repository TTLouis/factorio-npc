import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeTypedOperationCandidates,
  parseTypedProjection,
  routeTypedProjectionByRisk,
  typedProjectionOperationPolicy,
  typedProjectionPolicyCatalog,
  typedProjectionQuestions,
  typedProjectionRiskPolicy,
  typedProjectionTypeCatalog,
} from './jev-typed-projection.mjs'

import { parseOperation } from './structured-policy.mjs'

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
    freshness_token: 'entity-observation-17',
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


test('selected candidate remains a normal parseOperation value and still requires normal preflight', () => {
  const candidates = [{
    id: 'automation',
    operation: {
      name: 'research_technology',
      args: { technology_name: 'automation' },
    },
  }]
  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_1',
        probabilities: {
          candidate_1: 0.94,
          need_observation: 0.01,
          wake_planner: 0.04,
          ask_user: 0.01,
        },
        confidence: 0.9,
      },
    },
  }, { scope: 'research', candidates })

  assert.deepEqual(parseOperation(result.operation), result.operation)
  assert.equal(result.admission, 'requires_normal_preflight')
  assert.equal(Object.hasOwn(result, 'ready_for_execution'), false)
  assert.equal(Object.hasOwn(result, 'preflight_passed'), false)
})

test('missing candidate coverage exposes only explicit observation/planner/user fallbacks', () => {
  const questions = typedProjectionQuestions({ scope: 'resources', candidates: [] })
  assert.deepEqual(Object.keys(questions.projection_action.criteria), [
    'need_observation',
    'wake_planner',
    'ask_user',
  ])

  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'wake_planner',
        probabilities: {
          need_observation: 0.2,
          wake_planner: 0.7,
          ask_user: 0.1,
        },
        confidence: 0.6,
      },
    },
  }, { scope: 'resources', candidates: [] })

  assert.equal(result.route, 'wake_planner')
  assert.equal(result.operation, undefined)
})

test('M10 central projection policy calibrates only the existing low-risk live slice', () => {
  assert.deepEqual(typedProjectionRiskPolicy('low'), {
    risk: 'low',
    automatic_projection_eligible: true,
    calibration_status: 'operation_specific',
  })
  for (const risk of ['moderate', 'high', 'combat']) {
    assert.deepEqual(typedProjectionRiskPolicy(risk), {
      risk,
      automatic_projection_eligible: false,
      calibration_status: 'pending_phase9_e2e',
    })
  }

  assert.deepEqual(typedProjectionOperationPolicy('walk_to_entity_exact'), {
    operation_type: 'walk_to_entity_exact',
    risk: 'low',
    automatic_projection: true,
    minimum_confidence: 0.85,
    low_confidence_route: 'wake_planner',
    calibration_status: 'existing_m6_live_baseline',
    risk_automatic_projection_eligible: true,
  })

  const catalog = typedProjectionPolicyCatalog()
  assert.equal(catalog.walk_to_position.automatic_projection, false)
  assert.equal(catalog.walk_to_position.calibration_status, 'pending_phase9_e2e')
  assert.equal(catalog.place_entity.automatic_projection, false)
  assert.equal(catalog.attack_nearest_enemy.automatic_projection, false)
})

test('M10 calibrated low-risk navigation uses the central threshold and still requires preflight', () => {
  const candidates = [{
    id: 'furnace-1',
    operation: { name: 'walk_to_entity_exact', args: { unit_number: 7 } },
    freshness_token: 'entity-snapshot-7',
  }]
  const high = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_1',
        probabilities: { candidate_1: 0.95, need_observation: 0.02, wake_planner: 0.02, ask_user: 0.01 },
        confidence: 0.9,
      },
    },
  }, { scope: 'navigation', candidates })
  const admitted = routeTypedProjectionByRisk(high, { currentFreshnessToken: 'entity-snapshot-7' })
  assert.equal(admitted.route, 'emit_operation')
  assert.equal(admitted.confidence_policy.minimum_confidence, 0.85)
  assert.equal(admitted.admission, 'requires_normal_preflight')

  const low = { ...high, confidence: 0.6 }
  const fallback = routeTypedProjectionByRisk(low, { currentFreshnessToken: 'entity-snapshot-7' })
  assert.equal(fallback.route, 'wake_planner')
  assert.equal(fallback.operation, undefined)
  assert.equal(fallback.projection_failure, 'projection_confidence_below_policy')
  assert.equal(fallback.confidence_policy.minimum_confidence, 0.85)
})

test('M10 uncalibrated moderate high and combat projections wake the planner regardless of confidence', () => {
  for (const projection of [
    {
      route: 'emit_operation',
      scope: 'production',
      operation_type: 'set_machine_recipe',
      candidate_id: 'recipe',
      operation: { name: 'set_machine_recipe', args: { unit_number: 4, recipe_name: 'iron-gear-wheel' } },
      risk: 'moderate',
      freshness_required: false,
      confidence: 1,
      probabilities: {},
      admission: 'requires_normal_preflight',
    },
    {
      route: 'emit_operation',
      scope: 'construction',
      operation_type: 'place_entity',
      candidate_id: 'place',
      operation: { name: 'place_entity', args: { entity_name: 'stone-furnace' } },
      risk: 'high',
      freshness_required: false,
      confidence: 1,
      probabilities: {},
      admission: 'requires_normal_preflight',
    },
    {
      route: 'emit_operation',
      scope: 'combat',
      operation_type: 'attack_nearest_enemy',
      candidate_id: 'combat',
      operation: { name: 'attack_nearest_enemy', args: { search_radius: 20 } },
      risk: 'combat',
      freshness_required: false,
      confidence: 1,
      probabilities: {},
      admission: 'requires_normal_preflight',
    },
  ]) {
    const result = routeTypedProjectionByRisk(projection)
    assert.equal(result.route, 'wake_planner')
    assert.equal(result.operation, undefined)
    assert.equal(result.projection_failure, 'projection_operation_not_calibrated')
    assert.equal(result.confidence_policy.calibration_status, 'pending_phase9_e2e')
  }
})

test('exact entity identity candidates require and revalidate an opaque freshness token', () => {
  assert.throws(
    () => normalizeTypedOperationCandidates('resources', [{
      id: 'exact-tree',
      operation: { name: 'mine_entity_exact', args: { unit_number: 99 } },
    }]),
    /requires a valid freshness_token/,
  )

  const candidates = [{
    id: 'exact-tree',
    operation: { name: 'mine_entity_exact', args: { unit_number: 99 } },
    freshness_token: 'entity-snapshot-42',
  }]
  const projection = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_1',
        probabilities: {
          candidate_1: 0.95,
          need_observation: 0.02,
          wake_planner: 0.02,
          ask_user: 0.01,
        },
        confidence: 0.93,
      },
    },
  }, { scope: 'resources', candidates })

  const stale = routeTypedProjectionByRisk(projection, {
    currentFreshnessToken: 'entity-snapshot-43',
  })
  assert.equal(stale.route, 'need_observation')
  assert.equal(stale.operation, undefined)
  assert.equal(stale.projection_failure, 'stale_exact_identity')

  const fresh = routeTypedProjectionByRisk(projection, {
    currentFreshnessToken: 'entity-snapshot-42',
  })
  assert.equal(fresh.route, 'wake_planner')
  assert.equal(fresh.operation, undefined)
  assert.equal(fresh.projection_failure, 'projection_operation_not_calibrated')
})

test('malformed Jev results fail closed without mutating candidate or planning-like caller state', () => {
  const planningState = Object.freeze({
    active_step: 2,
    completed_prefix: Object.freeze(['step-1']),
  })
  const candidate = Object.freeze({
    id: 'iron',
    operation: Object.freeze({
      name: 'gather_resource',
      args: Object.freeze({ resource_name: 'iron-ore', count: 10, search_radius: 64 }),
    }),
  })
  const before = JSON.stringify({ planningState, candidate })

  const result = parseTypedProjection({
    answers: {
      projection_action: Object.freeze({
        type: 'choice',
        choice: 'candidate_999',
      }),
    },
  }, { scope: 'resources', candidates: [candidate] })

  assert.equal(result.route, 'wake_planner')
  assert.equal(result.operation, undefined)
  assert.equal(JSON.stringify({ planningState, candidate }), before)
  assert.equal(planningState.active_step, 2)
})

test('projection contract has no plan-completion authority', () => {
  const candidates = [{
    id: 'wait',
    operation: { name: 'wait', args: { ticks: 60 } },
  }]
  const result = parseTypedProjection({
    answers: {
      projection_action: {
        type: 'choice',
        choice: 'candidate_1',
        probabilities: {
          candidate_1: 1,
          need_observation: 0,
          wake_planner: 0,
          ask_user: 0,
        },
        confidence: 1,
      },
    },
  }, { scope: 'runtime', candidates })

  for (const forbidden of [
    'complete',
    'completed',
    'step_complete',
    'plan_complete',
    'planning_state',
    'advance_step',
  ]) {
    assert.equal(Object.hasOwn(result, forbidden), false)
  }
  assert.equal(result.admission, 'requires_normal_preflight')
})
