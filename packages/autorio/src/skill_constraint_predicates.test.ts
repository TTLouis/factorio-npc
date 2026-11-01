import { describe, expect, it } from 'vitest'
import {
  canonicalize_skill_constraint_predicate,
  skill_constraint_predicate_signature,
} from './skill_constraint_predicates'

describe('skill constraint predicates', () => {
  it('canonicalizes supported finite predicate variants with stable defaults', () => {
    expect(canonicalize_skill_constraint_predicate({
      type: 'resource_coverage',
      resource: ' iron-ore ',
    })).toEqual({
      type: 'resource_coverage',
      resource: 'iron-ore',
      minimum_entities: 1,
    })

    expect(canonicalize_skill_constraint_predicate({
      type: 'output_delta',
      item: 'transport-belt',
    })).toEqual({
      type: 'output_delta',
      item: 'transport-belt',
      minimum_delta: 1,
    })
  })

  it('rejects arbitrary predicate fields and malformed topology predicates', () => {
    expect(() => canonicalize_skill_constraint_predicate({
      type: 'output_delta',
      item: 'transport-belt',
      arbitrary: true,
    })).toThrow(/not supported/i)

    expect(() => canonicalize_skill_constraint_predicate({
      type: 'required_topology_relation',
      relation_kind: 'item_transfer',
    })).toThrow(/topology endpoint/i)
  })

  it('produces a deterministic semantic signature independent of object field order', () => {
    const first = canonicalize_skill_constraint_predicate({
      type: 'required_topology_relation',
      relation_kind: 'item_transfer',
      from: 'gear-machine',
      to: 'belt-machine',
      via: 'inserter',
    })
    const second = canonicalize_skill_constraint_predicate({
      via: 'inserter',
      to: 'belt-machine',
      relation_kind: 'item_transfer',
      from: 'gear-machine',
      type: 'required_topology_relation',
    })

    expect(first).toEqual(second)
    expect(skill_constraint_predicate_signature(first)).toBe(skill_constraint_predicate_signature(second))
  })
})
