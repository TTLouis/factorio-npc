import { beforeEach, describe, expect, it } from 'vitest'
import {
  assert_safe_skill_id,
  canonicalize_skill_definition,
  create_skill_candidate,
  ensure_basic_skill_definitions,
  export_skill,
  find_skill_definitions,
  generate_skill_markdown,
  get_skill_definition,
  handle_skill_export_click,
  list_skill_definitions,
  MAX_DYNAMIC_SKILL_DEFINITIONS,
  serialize_skill_json,
  skill_export_relative_directory,
} from './skills'
import { edited_skill_revision, skill_detail_rows } from './skills_window'

const writes: Array<{ filename: string, data: string, append: boolean }> = []

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    revision: 1,
    id: 'automated-transport-belt-line',
    name: 'Automated Transport Belt Line',
    kind: 'production',
    status: 'candidate',
    stage: 'executable_candidate',
    summary: 'Produce transport belts from iron plate while preserving the gear intermediate as a reusable relationship.',
    source: {
      kind: 'observed_factory',
      observed_tick: 1234,
      entity_unit_numbers: [10, 11, 12],
      recipe_ids: ['iron-gear-wheel', 'transport-belt'],
      evidence_refs: ['observation:factory-area-1'],
      area: {
        surface_index: 1,
        left_top: { x: 10, y: 20 },
        right_bottom: { x: 18, y: 27 },
      },
    },
    preconditions: [
      { kind: 'item_available', subject: 'iron-plate', description: 'Iron plate input is available.' },
    ],
    inputs: [{ item: 'iron-plate', role: 'raw input' }],
    outputs: [{ item: 'transport-belt', role: 'finished output' }],
    topology: {
      nodes: [
        { id: 'gear-assembler', role: 'Produce gear intermediate', entity_name: 'assembling-machine-1', recipe: 'iron-gear-wheel' },
        { id: 'belt-assembler', role: 'Consume iron plate and gear output', entity_name: 'assembling-machine-1', recipe: 'transport-belt' },
      ],
      relations: [
        { kind: 'direct_item_output', from: 'gear-assembler', to: 'belt-assembler', description: 'Gear intermediate feeds the belt assembler.' },
        { kind: 'belt_input', to: 'belt-assembler', description: 'Iron plate arrives from the input belt.' },
      ],
    },
    constraints: [
      { kind: 'capacity', description: 'Inserter sustained throughput has not been measured for this layout.', validation: 'unvalidated', evidence_refs: [] },
    ],
    parameters: [
      { name: 'input_direction', description: 'Direction from which iron plate enters.', required: true },
    ],
    verification: {
      structural: 'passed',
      recipe_flow: 'passed',
      placement_rebuild: 'not_tested',
      production_output: 'not_tested',
      belt_capacity: 'passed',
      inserter_sustained_throughput: 'unvalidated',
      acceptance_conditions: [],
    },
    known_failure_modes: ['Gear intermediate starvation can stop belt production.'],
    confidence: { level: 'medium', basis: ['Observed machine recipes and item-transfer relationships.'] },
    examples: [{ summary: 'Observed player factory area.', notes: 'Coordinates are provenance, not the reusable placement definition.' }],
    ...overrides,
  }
}

beforeEach(() => {
  writes.length = 0
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 555 }
  ;(globalThis as any).helpers = {
    table_to_json: (value: unknown) => JSON.stringify(value),
    write_file: (filename: string, data: string, append: boolean) => writes.push({ filename, data, append }),
  }
})

describe('curated basic skill library', () => {
  it('seeds exactly ten manual candidate patterns idempotently', () => {
    expect(ensure_basic_skill_definitions()).toEqual({ added: 10, total: 10 })
    const skills = list_skill_definitions()
    expect(skills).toHaveLength(10)
    expect(skills.every(skill => skill.source.kind === 'manual')).toBe(true)
    expect(skills.every(skill => skill.status === 'candidate')).toBe(true)
    expect(skills.every(skill => skill.stage === 'pattern')).toBe(true)
    expect(skills.every(skill => skill.verification.production_output === 'not_tested')).toBe(true)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, total: 10 })
    expect(list_skill_definitions()).toHaveLength(10)
  })

  it('finds early patterns from English goals and Chinese player shorthand', () => {
    ensure_basic_skill_definitions()
    expect(find_skill_definitions('煤蛇', 3)[0].id).toBe('burner-coal-loop')

    const smelting = find_skill_definitions('produce iron plates smelting', 5).map(result => result.id)
    expect(smelting).toContain('direct-miner-smelting')
    expect(smelting).toContain('starter-smelting-row')

    const merging = find_skill_definitions('并线', 3).map(result => result.id)
    expect(merging).toContain('belt-side-load-merge')
    expect(() => find_skill_definitions('coal', 6)).toThrow(/at most 5/i)
  })

  it('never overwrites an existing same-id save skill while seeding builtins', () => {
    create_skill_candidate(candidate({
      id: 'burner-coal-loop',
      name: 'Player Authored Coal Pattern',
      source: {
        kind: 'completed_goal',
        goal_id: 'goal_player',
        entity_unit_numbers: [],
        recipe_ids: [],
        evidence_refs: ['goal:player'],
      },
    }))

    expect(ensure_basic_skill_definitions()).toEqual({ added: 9, total: 10 })
    expect(get_skill_definition('burner-coal-loop')?.name).toBe('Player Authored Coal Pattern')
    expect(get_skill_definition('burner-coal-loop')?.source.kind).toBe('completed_goal')
  })
})

describe('learned skill record and export', () => {


  it('bounds dynamic skill registry growth without blocking updates to existing definitions', () => {
    for (let index = 0; index < MAX_DYNAMIC_SKILL_DEFINITIONS; index++) {
      create_skill_candidate(candidate({
        id: `dynamic-skill-${index}`,
        name: `Dynamic Skill ${index}`,
        source: {
          kind: 'completed_goal',
          goal_id: `goal-${index}`,
          entity_unit_numbers: [],
          recipe_ids: [],
          evidence_refs: [`goal:${index}`],
        },
      }))
    }

    expect(list_skill_definitions()).toHaveLength(MAX_DYNAMIC_SKILL_DEFINITIONS)

    expect(() => create_skill_candidate(candidate({
      id: 'dynamic-skill-overflow',
      name: 'Dynamic Skill Overflow',
    }))).toThrow(/dynamic capacity reached/i)

    const updated = create_skill_candidate(candidate({
      id: 'dynamic-skill-0',
      name: 'Updated Dynamic Skill 0',
      revision: 2,
    }))
    expect(updated.name).toBe('Updated Dynamic Skill 0')
    expect(get_skill_definition('dynamic-skill-0')?.revision).toBe(2)

    expect(ensure_basic_skill_definitions()).toEqual({ added: 10, total: 10 })
    expect(list_skill_definitions()).toHaveLength(MAX_DYNAMIC_SKILL_DEFINITIONS + 10)
  })
  it('creates a versioned candidate without promoting observation to verification', () => {
    const skill = create_skill_candidate(candidate({ status: 'observed', stage: 'example' }))
    expect(skill.schema_version).toBe(1)
    expect(skill.status).toBe('candidate')
    expect(skill.stage).toBe('executable_candidate')
    expect(skill.verification.structural).toBe('passed')
    expect(skill.verification.inserter_sustained_throughput).toBe('unvalidated')
  })

  it('preserves observed, candidate, and verified lifecycle states explicitly', () => {
    expect(canonicalize_skill_definition(candidate({ status: 'observed', stage: 'example' })).status).toBe('observed')
    expect(canonicalize_skill_definition(candidate()).status).toBe('candidate')
    const verified = canonicalize_skill_definition(candidate({
      status: 'verified',
      stage: 'verified_skill',
      verification: {
        structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed',
        inserter_sustained_throughput: 'unvalidated',
        acceptance_conditions: [{ id: 'rebuild', description: 'Rebuilt layout produced the expected item.', status: 'passed', evidence_refs: ['result:run-7'] }],
      },
    }))
    expect(verified.status).toBe('verified')
    expect(verified.stage).toBe('verified_skill')
  })

  it('rejects verified promotion without demonstrated acceptance evidence', () => {
    expect(() => canonicalize_skill_definition(candidate({ status: 'verified', stage: 'verified_skill' }))).toThrow(/acceptance conditions/i)
    expect(() => canonicalize_skill_definition(candidate({
      status: 'verified', stage: 'verified_skill',
      verification: {
        structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed', inserter_sustained_throughput: 'unvalidated',
        acceptance_conditions: [{ id: 'rebuild', description: 'Rebuild check', status: 'not_tested', evidence_refs: [] }],
      },
    }))).toThrow(/has not passed/i)
  })

  it('canonicalizes durable machine-readable constraint predicates while preserving legacy constraints', () => {
    const skill = canonicalize_skill_definition(candidate({
      constraints: [
        {
          kind: 'resource',
          description: 'Mining placement must cover the requested resource.',
          validation: 'validated',
          evidence_refs: ['coverage:1'],
          predicate: { type: 'resource_coverage', resource: ' iron-ore ' },
        },
        {
          kind: 'capacity',
          description: 'Legacy description-only capacity constraint.',
          validation: 'unvalidated',
          evidence_refs: [],
        },
      ],
    }))

    expect(skill.constraints[0].predicate).toEqual({
      type: 'resource_coverage',
      resource: 'iron-ore',
      minimum_entities: 1,
    })
    expect(skill.constraints[1].predicate).toBeUndefined()
    expect(generate_skill_markdown(skill)).toContain('predicate=resource_coverage|iron-ore|1|')
  })

  it('rejects arbitrary predicate schema extensions rather than silently persisting them', () => {
    expect(() => canonicalize_skill_definition(candidate({
      constraints: [{
        kind: 'custom',
        description: 'Unknown predicate must not become authority.',
        validation: 'unvalidated',
        evidence_refs: [],
        predicate: { type: 'output_delta', item: 'transport-belt', minimum_delta: 1, guess: 'llm' },
      }],
    }))).toThrow(/not supported/i)
  })

  it('keeps deterministic canonical structure and generates SKILL.md only from the structured record', () => {
    const skill = canonicalize_skill_definition(candidate())
    expect(serialize_skill_json(skill)).toBe(serialize_skill_json(skill))
    const markdown = generate_skill_markdown(skill)
    expect(markdown).toContain('# Automated Transport Belt Line')
    expect(markdown).toContain('## Procedure / Topology')
    expect(markdown).toContain('gear-assembler')
    expect(markdown).toContain('direct_item_output')
    expect(markdown).toContain('inserter sustained throughput: unvalidated')
    expect(markdown).toContain('Source coordinates and entity IDs are provenance only')
  })

  it('exports skill.json and generated SKILL.md into a fixed safe relative directory', () => {
    create_skill_candidate(candidate())
    const result = export_skill('automated-transport-belt-line')
    expect(result).toEqual({
      id: 'automated-transport-belt-line', revision: 1, duplicate: false,
      relative_path: 'script-output/sgluna-skills/automated-transport-belt-line/r1',
    })
    expect(writes.map(write => write.filename)).toEqual([
      'sgluna-skills/automated-transport-belt-line/r1/skill.json',
      'sgluna-skills/automated-transport-belt-line/r1/SKILL.md',
    ])
    expect(writes[0].data).toContain('"schema_version":1')
    expect(writes[0].data).toContain('"inserter_sustained_throughput":"unvalidated"')
    expect(writes[1].data).toContain('## Verification')
    expect(writes.every(write => write.append === false)).toBe(true)
  })

  it('rejects traversal and unsafe IDs before constructing an export path', () => {
    for (const id of ['../escape', '/absolute', 'skill/name', 'skill\\name', 'skill;rm', 'Skill Name', '-skill', 'skill-']) {
      expect(() => assert_safe_skill_id(id)).toThrow()
    }
    expect(skill_export_relative_directory({ id: 'safe-skill-1', revision: 2 })).toBe('sgluna-skills/safe-skill-1/r2')
  })

  it('treats an identical duplicate export as idempotent and refuses conflicting same-revision overwrites', () => {
    create_skill_candidate(candidate())
    expect(export_skill('automated-transport-belt-line').duplicate).toBe(false)
    expect(export_skill('automated-transport-belt-line').duplicate).toBe(true)
    expect(writes).toHaveLength(2)

    create_skill_candidate(candidate({ summary: 'Changed meaning without a revision bump.' }))
    expect(() => export_skill('automated-transport-belt-line')).toThrow(/increment revision/i)
    expect(writes).toHaveLength(2)
  })

  it('keeps definitions and duplicate-export records in Factorio storage across runtime reconstruction', () => {
    create_skill_candidate(candidate())
    const first = export_skill('automated-transport-belt-line')
    expect(first.duplicate).toBe(false)
    writes.length = 0
    const afterRestart = export_skill('automated-transport-belt-line')
    expect(afterRestart.duplicate).toBe(true)
    expect(writes).toHaveLength(0)
  })

  it('wires the UI export action to the same real export path without an LLM serialization call', () => {
    create_skill_candidate(candidate())
    const messages: string[] = []
    const player = { print: (message: string) => messages.push(message) } as any
    expect(handle_skill_export_click(player, 'airi_skill_export__automated-transport-belt-line')).toBe(true)
    expect(writes.map(write => write.filename)).toEqual([
      'sgluna-skills/automated-transport-belt-line/r1/skill.json',
      'sgluna-skills/automated-transport-belt-line/r1/SKILL.md',
    ])
    expect(messages[0]).toContain('Exported Automated Transport Belt Line r1')
    expect(messages[0]).toContain('script-output/sgluna-skills/automated-transport-belt-line/r1')
  })
})

describe('player edits from the skills window', () => {
  const verified_fields = {
    status: 'verified',
    stage: 'verified_skill',
    verification: {
      structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed',
      inserter_sustained_throughput: 'unvalidated',
      acceptance_conditions: [{ id: 'rebuild', description: 'Rebuilt layout produced the expected item.', status: 'passed', evidence_refs: ['result:run-7'] }],
    },
  }

  it('saves an edit as the next revision, records the editor and is what the LLM reads next', () => {
    const skill = create_skill_candidate(candidate())
    const saved = edited_skill_revision(skill, { name: 'Belt Line', summary: 'Make belts from plates and gears.', status: 'candidate' }, 'owner', 900)
    expect(saved.revision).toBe(skill.revision + 1)
    expect(saved.name).toBe('Belt Line')
    expect(saved.summary).toBe('Make belts from plates and gears.')
    expect(saved.source.evidence_refs).toEqual([...skill.source.evidence_refs, 'player-edit:owner@900'])
    // getSkillDetails reads the stored definition, so the model sees the edit.
    expect(get_skill_definition(skill.id)).toEqual(saved)
  })

  it('turns an edited verified skill back into a candidate, and never lets a player verify', () => {
    const skill = canonicalize_skill_definition(candidate(verified_fields))
    const saved = edited_skill_revision(skill, { name: skill.name, summary: 'Reworded.', status: 'candidate' }, 'owner', 901)
    expect(saved.status).toBe('candidate')
    expect(saved.stage).toBe('executable_candidate')
    expect(edited_skill_revision(skill, { name: skill.name, summary: skill.summary, status: 'deprecated' }, 'owner', 902).stage).toBe('verified_skill')
    expect(() => edited_skill_revision(skill, { name: skill.name, summary: skill.summary, status: 'verified' }, 'owner', 903)).toThrow(/runtime verifier/)
  })

  it('refuses an invalid edit and leaves the stored skill as it was', () => {
    const skill = create_skill_candidate(candidate())
    expect(() => edited_skill_revision(skill, { name: '   ', summary: skill.summary, status: 'candidate' }, 'owner', 904)).toThrow(/name must not be empty/)
    expect(get_skill_definition(skill.id)).toEqual(skill)
  })

  it('edits a curated skill as a stored revision that reseeding keeps', () => {
    ensure_basic_skill_definitions()
    const curated = get_skill_definition('burner-coal-loop')!
    const saved = edited_skill_revision(curated, { name: 'Burner Coal Loop (house rules)', summary: curated.summary, status: 'candidate' }, 'owner', 905)
    ensure_basic_skill_definitions()
    expect(get_skill_definition('burner-coal-loop')).toEqual(saved)
  })

  it('shows every part of a skill the model can read, in order', () => {
    const rows = skill_detail_rows(create_skill_candidate(candidate()))
    expect(rows.map(([key]) => key)).toEqual(['ID', 'KIND', 'SOURCE', 'SUMMARY', 'INPUTS', 'OUTPUTS', 'NEEDS', 'MACHINES', 'LINKS', 'RULES', 'PARAMS', 'CHECKED', 'FAILS', 'CONFIDENCE', 'EXAMPLES'])
    expect(rows.find(([key]) => key === 'LINKS')?.[1]).toContain('direct_item_output gear-assembler → belt-assembler')
  })
})
