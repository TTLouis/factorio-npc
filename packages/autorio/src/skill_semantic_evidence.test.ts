import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mark_skill_revision_reverified,
  record_skill_evidence,
  skill_constraint_semantic_signature,
  skill_revision_trust,
} from './skill_semantic_evidence'

describe('skill semantic evidence', () => {
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

  it('distinguishes constraints with the same kind/validation but different semantics', () => {
    const weak = skill_constraint_semantic_signature({
      kind: 'resource',
      description: 'Mining placement must satisfy deterministic target resource coverage.',
      validation: 'validated',
      evidence_refs: [],
      predicate: { type: 'resource_coverage', resource: 'iron-ore', minimum_entities: 1 },
    })
    const strong = skill_constraint_semantic_signature({
      kind: 'resource',
      description: 'Mining placement must satisfy deterministic target resource coverage.',
      validation: 'validated',
      evidence_refs: [],
      predicate: { type: 'resource_coverage', resource: 'iron-ore', minimum_entities: 8 },
    })

    expect(weak).not.toBe(strong)
  })

  it('keeps legacy description-only constraints semantically distinct', () => {
    const weak = skill_constraint_semantic_signature({
      kind: 'resource',
      description: 'Must overlap at least one target resource tile.',
      validation: 'validated',
      evidence_refs: [],
    })
    const strong = skill_constraint_semantic_signature({
      kind: 'resource',
      description: 'Must cover at least eight target resource tiles.',
      validation: 'validated',
      evidence_refs: [],
    })

    expect(weak).not.toBe(strong)
  })

  it('quarantines semantic failures but not transient execution failures', () => {
    record_skill_evidence('miner-layout', 3, 'execution_failure', 'Actor path was temporarily blocked.', ['run-1'])
    expect(skill_revision_trust('miner-layout', 3).state).toBe('active')

    ;(globalThis as any).game.tick = 120
    record_skill_evidence('miner-layout', 3, 'semantic_failure', 'Receiver did not intersect the observed direct item output.', ['run-2'])
    expect(skill_revision_trust('miner-layout', 3)).toMatchObject({
      state: 'quarantined',
      reason: 'Receiver did not intersect the observed direct item output.',
      evidence_refs: ['run-2'],
    })
  })

  it('reactivates only after an explicit re-verification transition', () => {
    record_skill_evidence('fluid-layout', 2, 'mechanic_correction', 'Observed modded fluid ports contradict the stored assumption.', ['counterexample'])
    expect(skill_revision_trust('fluid-layout', 2).state).toBe('quarantined')

    ;(globalThis as any).game.tick = 200
    mark_skill_revision_reverified('fluid-layout', 2, ['verification-7'])
    expect(skill_revision_trust('fluid-layout', 2)).toMatchObject({
      state: 'active',
      evidence_refs: ['verification-7'],
    })
  })
})
