import { beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalize_skill_definition,
  put_untrusted_skill_definition,
} from './skills'

function verifiedDefinition() {
  return {
    schema_version: 1,
    revision: 2,
    id: 'trusted-verifier-skill',
    name: 'Trusted verifier skill',
    kind: 'production',
    stage: 'verified_skill',
    status: 'verified',
    summary: 'A record that is structurally verified but must not be accepted from an untrusted caller.',
    source: {
      kind: 'manual',
      entity_unit_numbers: [],
      recipe_ids: [],
      evidence_refs: ['verification-run:test'],
    },
    preconditions: [],
    inputs: [{ item: 'iron-plate' }],
    outputs: [{ item: 'iron-gear-wheel' }],
    topology: { nodes: [], relations: [] },
    constraints: [],
    parameters: [],
    verification: {
      structural: 'passed',
      recipe_flow: 'passed',
      placement_rebuild: 'passed',
      production_output: 'passed',
      belt_capacity: 'not_tested',
      inserter_sustained_throughput: 'unvalidated',
      acceptance_conditions: [
        {
          id: 'live-verification',
          description: 'Verified by the live runtime.',
          status: 'passed',
          evidence_refs: ['verification-run:test'],
        },
      ],
    },
    known_failure_modes: [],
    confidence: { level: 'high', basis: ['Live runtime evidence.'] },
    examples: [],
  }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
})

describe('verified skill promotion authority', () => {
  it('keeps verified records representable for the trusted live verifier', () => {
    expect(canonicalize_skill_definition(verifiedDefinition()).status).toBe('verified')
  })

  it('rejects caller-supplied verified records at the untrusted import boundary', () => {
    expect(() => put_untrusted_skill_definition(verifiedDefinition())).toThrow(/live runtime verifier/)
  })

  it('accepts ordinary non-verified imports', () => {
    const candidate = {
      ...verifiedDefinition(),
      revision: 1,
      stage: 'executable_candidate',
      status: 'candidate',
      verification: {
        ...verifiedDefinition().verification,
        placement_rebuild: 'not_tested',
        production_output: 'not_tested',
        acceptance_conditions: [],
      },
    }
    expect(put_untrusted_skill_definition(candidate)).toMatchObject({
      id: 'trusted-verifier-skill',
      revision: 1,
      stage: 'executable_candidate',
      status: 'candidate',
    })
  })
})
