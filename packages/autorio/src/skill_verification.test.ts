import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FactoryAreaAnalysis, FactoryEntityObservation, FactoryGraphRelation, FactoryProductionBlock } from './factory_area_learning'
import { skill_candidate_definition_from_block } from './factory_area_learning'
import {
  create_learning_opportunity,
  list_learning_opportunities,
  list_learning_verification_queue,
  queue_learning_verification,
} from './learning_opportunities'
import {
  capture_skill_instance_template_from_block,
  evaluate_live_topology,
  fail_skill_verification_run,
  instantiate_skill_template,
  output_delta_satisfied,
  promote_verified_skill,
  start_next_skill_verification,
  tick_skill_verification,
  type SkillVerificationRun,
} from './skill_verification'
import { create_skill_candidate, get_skill_definition } from './skills'

function machine(id: string, unit: number, x: number, recipe: string, ingredients: Array<{ name: string, amount: number }>, products: Array<{ name: string, amount: number }>): FactoryEntityObservation {
  return {
    id,
    name: 'assembling-machine-1',
    type: 'assembling-machine',
    category: 'machine',
    unit_number: unit,
    position: { x, y: 0.5 },
    direction: 0,
    footprint: { left_top: { x: x - 1.4, y: -0.9 }, right_bottom: { x: x + 1.4, y: 1.9 } },
    recipe: {
      name: recipe,
      ingredients: ingredients.map(value => ({ type: 'item', ...value })),
      products: products.map(value => ({ type: 'item', ...value })),
    },
    inventories: [],
    fluid_connections: [],
  }
}

function inserter(id: string, unit: number, x: number, pickup: string, drop: string): FactoryEntityObservation {
  return {
    id,
    name: 'inserter',
    type: 'inserter',
    category: 'inserter',
    unit_number: unit,
    position: { x, y: 0.5 },
    direction: 4,
    footprint: { left_top: { x: x - 0.4, y: 0.1 }, right_bottom: { x: x + 0.4, y: 0.9 } },
    inventories: [],
    inserter: {
      pickup_position: { x: x - 1, y: 0.5 },
      drop_position: { x: x + 1, y: 0.5 },
      pickup_target: pickup,
      drop_target: drop,
    },
    fluid_connections: [],
  }
}

function transfer(id: string, from: string, via: string, to: string): FactoryGraphRelation {
  return {
    id,
    kind: 'item_transfer',
    from,
    via,
    to,
    item_names: ['iron-gear-wheel'],
    confidence: 'engine_exact',
    item_confidence: 'recipe_inferred',
    evidence_refs: [`engine:${id}`],
    description: 'Inserter transfers the required intermediate between recipe machines.',
  }
}

function block(entity_ids: string[], relation_ids: string[]): FactoryProductionBlock {
  return {
    id: 'block-1',
    title: 'transport-belt production',
    entity_ids,
    relation_ids,
    recipe_ids: ['iron-gear-wheel', 'transport-belt'],
    inputs: ['iron-plate'],
    intermediates: ['iron-gear-wheel'],
    outputs: ['transport-belt'],
    machine_ids: [entity_ids[0], entity_ids[entity_ids.length - 1]],
    boundary_inputs: [],
    boundary_outputs: [],
    ambiguities: [],
  }
}

function analysis(id: string, offset: number, connected = true): FactoryAreaAnalysis {
  const gear = machine(`${id}-gear`, offset + 1, offset + 0.5, 'iron-gear-wheel', [{ name: 'iron-plate', amount: 2 }], [{ name: 'iron-gear-wheel', amount: 1 }])
  const arm = inserter(`${id}-arm`, offset + 2, offset + 3.5, gear.id, `${id}-belt`)
  const belt = machine(`${id}-belt`, offset + 3, offset + 6.5, 'transport-belt', [
    { name: 'iron-gear-wheel', amount: 1 },
    { name: 'iron-plate', amount: 1 },
  ], [{ name: 'transport-belt', amount: 2 }])
  const relation = transfer(`${id}-transfer`, gear.id, arm.id, belt.id)
  const entities = [gear, arm, belt]
  const relations = connected ? [relation] : []
  const blocks = connected
    ? [block(entities.map(entity => entity.id), [relation.id])]
    : [
        {
          ...block([gear.id], []),
          id: 'block-gear',
          title: 'gear only',
          recipe_ids: ['iron-gear-wheel'],
          inputs: ['iron-plate'],
          intermediates: [],
          outputs: ['iron-gear-wheel'],
          machine_ids: [gear.id],
        },
        {
          ...block([belt.id], []),
          id: 'block-belt',
          title: 'belt machine without intermediate transfer',
          recipe_ids: ['transport-belt'],
          inputs: ['iron-gear-wheel', 'iron-plate'],
          intermediates: [],
          outputs: ['transport-belt'],
          machine_ids: [belt.id],
        },
      ]
  return {
    schema_version: 1,
    id,
    tick: 100,
    surface_index: 1,
    surface_name: 'nauvis',
    area: { left_top: { x: offset - 2, y: -3 }, right_bottom: { x: offset + 9, y: 4 } },
    spatial_source: 'local_spatial_observation',
    spatial: {
      center: { x: offset + 3.5, y: 0.5 },
      bounds: { left_top: { x: offset - 2, y: -3 }, right_bottom: { x: offset + 9, y: 4 } },
      blocking_terrain: {},
      entities_truncated: false,
    },
    entities,
    relations,
    blocks,
    entity_count: entities.length,
    relations_truncated: false,
    blocks_truncated: false,
  }
}

function store_analysis(value: FactoryAreaAnalysis) {
  const state = (globalThis as any).storage
  state.sgluna_factory_area_analyses = state.sgluna_factory_area_analyses ?? {}
  state.sgluna_factory_area_order = state.sgluna_factory_area_order ?? []
  state.sgluna_factory_area_analyses[value.id] = value
  state.sgluna_factory_area_order.push(value.id)
}

function candidate_from_source() {
  store_analysis(analysis('source-analysis', 0, true))
  return create_skill_candidate(skill_candidate_definition_from_block('source-analysis', 'block-1'))
}

function queued_opportunity(skill_id: string) {
  const opportunity = create_learning_opportunity({
    source: 'manual',
    evidence_refs: ['test:verification'],
    novelty_key: 'test-verification',
    estimated_cost: 'moderate',
    risk: 'safe',
    reason: 'Test candidate verification.',
  })
  queue_learning_verification(opportunity.id, skill_id, 'moderate', 'safe', 'Run translated rebuild verification.')
  return opportunity
}

function store_active_verification_run(run: SkillVerificationRun) {
  const state = (globalThis as any).storage
  state.sgluna_skill_verification_runs = { [run.id]: run }
  state.sgluna_skill_verification_run_order = [run.id]
  state.sgluna_skill_verification_active_run_id = run.id
}

function run_for(skill_id: string, opportunity_id: string, topology_match: boolean, current_output: number): SkillVerificationRun {
  const skill = get_skill_definition(skill_id)!
  return {
    schema_version: 1,
    id: 'skill-verification-test',
    opportunity_id,
    skill_id,
    skill_revision: skill.revision,
    state: 'observing_output',
    started_tick: 1000,
    updated_tick: 1000,
    target_surface_index: 1,
    target_origin: { x: 40, y: 40 },
    instance_bounds: { left_top: { x: 36, y: 37 }, right_bottom: { x: 44, y: 43 } },
    placements: [
      { entity_name: 'assembling-machine-1', x: 37, y: 40 },
      { entity_name: 'inserter', x: 40, y: 40, direction: 4 },
      { entity_name: 'assembling-machine-1', x: 43, y: 40 },
    ],
    input_routes: [],
    built_entities: [
      { template_id: 'template-1', unit_number: 101 },
      { template_id: 'template-2', unit_number: 102 },
      { template_id: 'template-3', unit_number: 103 },
    ],
    baseline_output_counts: { 'transport-belt': 0 },
    observed_output_counts: { 'transport-belt': current_output },
    live_analysis_id: topology_match ? 'translated-analysis' : 'broken-analysis',
    topology_match,
    evidence_refs: ['verification-run:skill-verification-test:translated-rebuild'],
    reason: 'Test verification run.',
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 1200 }
  ;(globalThis as any).remote.call = () => undefined
})

describe('Skill Verification / Instance Layer V1', () => {
  it('captures relative source geometry and instantiates it in a different area without making source coordinates authoritative', () => {
    const skill = candidate_from_source()
    const captured = capture_skill_instance_template_from_block(skill.id, skill.revision, 'source-analysis', 'block-1')
    expect(captured.ok).toBe(true)
    if (!captured.ok) return
    const instance = instantiate_skill_template(captured.template, { x: 50, y: 60 })
    expect(instance.placements).toHaveLength(3)
    expect(instance.placements.map(value => value.x)).not.toEqual([0.5, 3.5, 6.5])
    expect(instance.placements[1].x - instance.placements[0].x).toBe(3)
    expect(instance.placements[2].x - instance.placements[1].x).toBe(3)
    expect(skill.topology.relations[0].kind).toBe('item_transfer')
  })

  it('accepts a translated live observation only when reusable topology still matches', () => {
    const skill = candidate_from_source()
    store_analysis(analysis('translated-analysis', 40, true))
    store_analysis(analysis('broken-analysis', 80, false))
    expect(evaluate_live_topology(skill, 'translated-analysis').match).toBe(true)
    expect(evaluate_live_topology(skill, 'broken-analysis').match).toBe(false)
  })

  it('promotes only after live topology and positive output delta evidence while leaving throughput unvalidated', () => {
    const skill = candidate_from_source()
    const opportunity = queued_opportunity(skill.id)
    store_analysis(analysis('translated-analysis', 40, true))
    const run = run_for(skill.id, opportunity.id, true, 2)
    expect(output_delta_satisfied(skill, run.baseline_output_counts, run.observed_output_counts)).toBe(true)
    const verified = promote_verified_skill(run)
    expect(verified.status).toBe('verified')
    expect(verified.stage).toBe('verified_skill')
    expect(verified.verification.placement_rebuild).toBe('passed')
    expect(verified.verification.production_output).toBe('passed')
    expect(verified.verification.inserter_sustained_throughput).toBe('unvalidated')
    expect(verified.constraints.find(value => value.kind === 'placement')?.validation).toBe('validated')
    expect(verified.verification.acceptance_conditions).toHaveLength(3)
    expect(verified.verification.acceptance_conditions.every(value => value.status === 'passed' && value.evidence_refs.length > 0)).toBe(true)
  })

  it('turns a semantic counterexample into a revised candidate and automatically requeues verification', () => {
    const skill = candidate_from_source()
    const opportunity = queued_opportunity(skill.id)
    store_analysis(analysis('broken-analysis', 80, false))
    expect(evaluate_live_topology(skill, 'broken-analysis').match).toBe(false)
    const run = run_for(skill.id, opportunity.id, false, 0)
    expect(run.placements).toHaveLength(3)
    expect(output_delta_satisfied(skill, run.baseline_output_counts, run.observed_output_counts)).toBe(false)
    const failed = fail_skill_verification_run(
      run,
      'semantic',
      'required intermediate transfer was absent and transport-belt output never increased during the bounded window',
      ['factory-analysis:broken-analysis', 'verification-run:skill-verification-test:output-delta:transport-belt:0->0'],
    )
    expect(failed.state).toBe('failed')
    expect(failed.failure_kind).toBe('semantic')
    const revised = get_skill_definition(skill.id)
    expect(revised?.status).toBe('candidate')
    expect(revised?.stage).toBe('executable_candidate')
    expect(revised?.revision).toBe(skill.revision + 1)
    expect(revised?.constraints.some(value => value.predicate?.type === 'required_topology_relation')).toBe(true)
    expect(revised?.constraints.some(value => value.predicate?.type === 'output_delta')).toBe(true)
    expect(list_learning_opportunities()[0]).toMatchObject({
      state: 'awaiting_verification',
      skill_id: skill.id,
    })
    expect(list_learning_verification_queue()).toHaveLength(1)
    expect(list_learning_verification_queue()[0].skill_id).toBe(skill.id)
  })

  it('keeps an unavailable actor as blocked rather than failed and retains the verification queue item', () => {
    const skill = candidate_from_source()
    const opportunity = queued_opportunity(skill.id)
    const result = start_next_skill_verification(() => undefined, { opportunity_id: opportunity.id })
    expect(result.ok).toBe(false)
    expect(result.run?.state).toBe('blocked')
    expect(get_skill_definition(skill.id)?.status).toBe('candidate')
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
    expect(list_learning_verification_queue()[0].state).toBe('blocked')
  })

  it('blocks a persisted pending verifier when the task-manager generation changed after reload', () => {
    const skill = candidate_from_source()
    const opportunity = queued_opportunity(skill.id)
    capture_skill_instance_template_from_block(skill.id, skill.revision, 'source-analysis', 'block-1')
    const run: SkillVerificationRun = {
      ...run_for(skill.id, opportunity.id, true, 0),
      state: 'constructing',
      active_batch_id: 7,
      active_batch_generation: 3,
      active_batch_ref: 'batch-g3-7',
    }
    store_active_verification_run(run)
    ;(globalThis as any).remote.call = vi.fn(() => ({
      batch_generation: 4,
      active_batch: { batch_id: 8, batch_generation: 4, batch_ref: 'batch-g4-8' },
    }))

    tick_skill_verification()

    const blocked = (globalThis as any).storage.sgluna_skill_verification_runs[run.id]
    expect(blocked.state).toBe('blocked')
    expect(blocked.failure_kind).toBeUndefined()
    expect(blocked.reason).toMatch(/interrupted by runtime reload/)
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
    expect(list_learning_verification_queue()[0].state).toBe('blocked')
  })

  it('fails closed to retryable blocked for a legacy pending verifier with only numeric batch_id', () => {
    const skill = candidate_from_source()
    const opportunity = queued_opportunity(skill.id)
    capture_skill_instance_template_from_block(skill.id, skill.revision, 'source-analysis', 'block-1')
    const run: SkillVerificationRun = {
      ...run_for(skill.id, opportunity.id, true, 0),
      state: 'constructing',
      active_batch_id: 7,
      active_batch_generation: undefined,
      active_batch_ref: undefined,
    }
    store_active_verification_run(run)

    tick_skill_verification()

    const blocked = (globalThis as any).storage.sgluna_skill_verification_runs[run.id]
    expect(blocked.state).toBe('blocked')
    expect(blocked.failure_kind).toBeUndefined()
    expect(blocked.reason).toMatch(/legacy pending batch 7 has no restart-safe identity/)
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
    expect(list_learning_verification_queue()[0].state).toBe('blocked')
  })

  it('contains no cheat construction or free-item path and explicitly uses normal NPC operations', () => {
    const source = readFileSync(new URL('./skill_verification.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/create_entity|teleport/i)
    expect(source).not.toMatch(/\.insert\s*\(/)
    expect(source).toContain("operation_result('execute_construction_plan'")
    expect(source).toContain("operation_result('set_machine_recipe'")
    expect(source).toContain("operation_result('move_items_exact'")
    expect(source).toContain('validate_construction_execution_plan')
  })
})