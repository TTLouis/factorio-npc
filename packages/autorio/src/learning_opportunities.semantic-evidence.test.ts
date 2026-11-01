import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  create_learning_opportunity,
  update_learning_opportunity,
} from './learning_opportunities'
import {
  list_skill_evidence,
  skill_revision_trust,
} from './skill_semantic_evidence'

describe('learning verification semantic evidence bridge', () => {
  const originalStorage = (globalThis as any).storage
  const originalGame = (globalThis as any).game

  beforeEach(() => {
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game = { tick: 100 }
  })

  afterEach(() => {
    ;(globalThis as any).storage = originalStorage
    ;(globalThis as any).game = originalGame
  })

  function opportunity(skill_id: string) {
    return create_learning_opportunity({
      source: 'observed_factory',
      evidence_refs: ['factory:source'],
      novelty_key: `novelty:${skill_id}`,
      estimated_cost: 'moderate',
      risk: 'safe',
      reason: 'Reusable structure observed.',
      skill_id,
    })
  }

  it('quarantines the exact failed revision only for semantic verification failure', () => {
    const created = opportunity('miner-layout')
    ;(globalThis as any).storage.sgluna_skill_verification_runs = {
      'run-semantic': {
        id: 'run-semantic',
        skill_id: 'miner-layout',
        skill_revision: 4,
        state: 'failed',
        failure_kind: 'semantic',
        reason: 'Live topology did not deliver the declared output.',
        evidence_refs: ['verification:topology'],
      },
    }

    update_learning_opportunity(created.id, {
      state: 'failed',
      verification_run_id: 'run-semantic',
      evidence_refs: ['verification:output'],
      reason: 'Verification semantic failure.',
    })

    expect(skill_revision_trust('miner-layout', 4)).toMatchObject({
      state: 'quarantined',
      reason: 'Live topology did not deliver the declared output.',
    })
    expect(skill_revision_trust('miner-layout', 5).state).toBe('active')
    expect(list_skill_evidence('miner-layout', 4)[0]).toMatchObject({
      kind: 'semantic_failure',
      revision: 4,
    })
  })

  it('records transient execution failure without quarantining the skill revision', () => {
    const created = opportunity('belt-layout')
    ;(globalThis as any).storage.sgluna_skill_verification_runs = {
      'run-execution': {
        id: 'run-execution',
        skill_id: 'belt-layout',
        skill_revision: 2,
        state: 'failed',
        failure_kind: 'execution',
        reason: 'Actor could not reach the translated verification site.',
        evidence_refs: ['verification:path'],
      },
    }

    update_learning_opportunity(created.id, {
      state: 'failed',
      verification_run_id: 'run-execution',
    })

    expect(skill_revision_trust('belt-layout', 2).state).toBe('active')
    expect(list_skill_evidence('belt-layout', 2)[0]).toMatchObject({
      kind: 'execution_failure',
      revision: 2,
    })
  })

  it('records success on the promoted revision and deduplicates repeated terminal updates', () => {
    const created = opportunity('fluid-layout')
    ;(globalThis as any).storage.sgluna_skill_verification_runs = {
      'run-success': {
        id: 'run-success',
        skill_id: 'fluid-layout',
        skill_revision: 7,
        state: 'verified',
        reason: 'Translated rebuild produced the declared output.',
        evidence_refs: ['verification:live'],
      },
    }
    ;(globalThis as any).storage.sgluna_skill_definitions = {
      'fluid-layout': {
        id: 'fluid-layout',
        revision: 8,
        status: 'verified',
      },
    }

    update_learning_opportunity(created.id, {
      state: 'verified',
      verification_run_id: 'run-success',
      evidence_refs: ['verification:output'],
    })
    update_learning_opportunity(created.id, {
      state: 'verified',
      verification_run_id: 'run-success',
      evidence_refs: ['verification:output'],
    })

    expect(skill_revision_trust('fluid-layout', 7).state).toBe('active')
    expect(skill_revision_trust('fluid-layout', 8).state).toBe('active')
    expect(list_skill_evidence('fluid-layout', 8)).toHaveLength(1)
    expect(list_skill_evidence('fluid-layout', 8)[0]).toMatchObject({
      kind: 'success',
      revision: 8,
    })
  })
})
