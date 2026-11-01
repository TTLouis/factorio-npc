import { beforeEach, describe, expect, it } from 'vitest'
import {
  create_learning_opportunity,
  list_learning_opportunities,
  list_learning_verification_queue,
  queue_learning_verification,
} from './learning_opportunities'
import {
  fail_skill_verification_run,
  finish_verified,
  retry_blocked_skill_verification,
  start_next_skill_verification,
  type SkillVerificationRun,
} from './skill_verification'
import { create_skill_candidate, get_skill_definition } from './skills'

function candidate() {
  return create_skill_candidate({
    id: 'queue-transition-skill',
    name: 'Queue transition skill',
    kind: 'production',
    summary: 'Minimal candidate for verification queue lifecycle tests.',
    source: {
      kind: 'manual',
      entity_unit_numbers: [],
      recipe_ids: [],
      evidence_refs: ['test:queue-transition'],
    },
    preconditions: [],
    inputs: [{ item: 'iron-plate' }],
    outputs: [{ item: 'iron-gear-wheel' }],
    topology: {
      nodes: [
        { id: 'input', role: 'input machine' },
        { id: 'output', role: 'output machine' },
      ],
      relations: [
        { kind: 'item_transfer', from: 'input', to: 'output', description: 'test relation' },
      ],
    },
    constraints: [],
    parameters: [],
    verification: {
      structural: 'passed',
      recipe_flow: 'passed',
      placement_rebuild: 'not_tested',
      production_output: 'not_tested',
      belt_capacity: 'not_tested',
      inserter_sustained_throughput: 'unvalidated',
      acceptance_conditions: [],
    },
    known_failure_modes: [],
    confidence: { level: 'low', basis: ['test fixture'] },
    examples: [],
  })
}

function queued(skill_id: string) {
  const opportunity = create_learning_opportunity({
    source: 'manual',
    evidence_refs: ['test:queue-transition'],
    novelty_key: 'queue-transition-test',
    estimated_cost: 'moderate',
    risk: 'safe',
    reason: 'Exercise queue lifecycle.',
  })
  queue_learning_verification(opportunity.id, skill_id, 'moderate', 'safe', 'Queue transition test.')
  return opportunity
}

function terminalRun(skill_id: string, opportunity_id: string): SkillVerificationRun {
  const skill = get_skill_definition(skill_id)!
  return {
    schema_version: 1,
    id: 'skill-verification-queue-test',
    opportunity_id,
    skill_id,
    skill_revision: skill.revision,
    state: 'observing_output',
    started_tick: 100,
    updated_tick: 100,
    placements: [],
    input_routes: [],
    built_entities: [],
    baseline_output_counts: { 'iron-gear-wheel': 0 },
    observed_output_counts: { 'iron-gear-wheel': 1 },
    live_analysis_id: 'queue-test-analysis',
    topology_match: true,
    evidence_refs: ['verification-run:skill-verification-queue-test:translated-rebuild'],
    reason: 'Queue transition test run.',
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 200 }
})

describe('learning verification queue lifecycle', () => {
  it('transitions queued -> running -> blocked and blocked -> queued on explicit retry', () => {
    const skill = candidate()
    const opportunity = queued(skill.id)
    expect(list_learning_verification_queue()[0].state).toBe('queued')

    const result = start_next_skill_verification(() => undefined, { opportunity_id: opportunity.id })
    expect(result.ok).toBe(false)
    expect(result.run?.state).toBe('blocked')
    expect(list_learning_verification_queue()[0].state).toBe('blocked')
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')

    expect(retry_blocked_skill_verification(opportunity.id)).toEqual({ ok: true })
    expect(list_learning_verification_queue()[0].state).toBe('queued')
    expect(list_learning_opportunities()[0].state).toBe('awaiting_verification')
  })

  it('removes a running queue item on failed verification', () => {
    const skill = candidate()
    const opportunity = queued(skill.id)
    ;(globalThis as any).storage.sgluna_learning_verification_queue[0].state = 'running'

    const failed = fail_skill_verification_run(terminalRun(skill.id, opportunity.id), 'execution', 'test failure')
    expect(failed.state).toBe('failed')
    expect(list_learning_verification_queue()).toHaveLength(0)
    expect(list_learning_opportunities()[0]).toMatchObject({ state: 'failed', verification_run_id: failed.id })
  })

  it('removes a running queue item on verified completion while keeping lifecycle layers distinct', () => {
    const skill = candidate()
    const opportunity = queued(skill.id)
    ;(globalThis as any).storage.sgluna_learning_verification_queue[0].state = 'running'

    const verified = finish_verified(terminalRun(skill.id, opportunity.id))
    expect(verified.state).toBe('verified')
    expect(list_learning_verification_queue()).toHaveLength(0)
    expect(list_learning_opportunities()[0]).toMatchObject({ state: 'verified', verification_run_id: verified.id })
    expect(get_skill_definition(skill.id)).toMatchObject({ status: 'verified', stage: 'verified_skill', revision: skill.revision + 1 })
  })
})
