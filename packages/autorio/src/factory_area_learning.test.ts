import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  analyze_factory_area,
  get_factory_area_analysis,
  skill_candidate_definition_from_block,
} from './factory_area_learning'
import {
  create_skill_candidate,
  export_skill,
  get_skill_definition,
  handle_skill_export_click,
} from './skills'

function box(x: number, y: number, half = 0.4) {
  return { left_top: { x: x - half, y: y - half }, right_bottom: { x: x + half, y: y + half } }
}

function recipe(name: string, ingredients: string[], products: string[]) {
  return {
    name,
    ingredients: ingredients.map(item => ({ type: 'item', name: item, amount: 1 })),
    products: products.map(item => ({ type: 'item', name: item, amount: 1 })),
  }
}

function entity(name: string, type: string, unit_number: number, x: number, y: number, extra: Record<string, any> = {}) {
  const value: any = {
    valid: true,
    name,
    type,
    unit_number,
    position: { x, y },
    direction: 0,
    bounding_box: box(x, y),
    force: { name: 'player' },
    fluidbox: { length: 0, get_pipe_connections: () => [] },
    ...extra,
  }
  return value
}

function fixture(extra: any[] = []) {
  const outside_input = entity('transport-belt', 'transport-belt', 1, -1, 4)
  const input_belt = entity('transport-belt', 'transport-belt', 2, 1, 4)
  const plate_split_belt = entity('transport-belt', 'transport-belt', 3, 4, 1)
  const output_belt = entity('transport-belt', 'transport-belt', 4, 10, 4)
  const outside_output = entity('transport-belt', 'transport-belt', 5, 13, 4)
  outside_input.belt_neighbours = { inputs: [], outputs: [input_belt] }
  input_belt.belt_neighbours = { inputs: [outside_input], outputs: [] }
  plate_split_belt.belt_neighbours = { inputs: [], outputs: [] }
  output_belt.belt_neighbours = { inputs: [], outputs: [outside_output] }
  outside_output.belt_neighbours = { inputs: [output_belt], outputs: [] }

  const gear_recipe = recipe('iron-gear-wheel', ['iron-plate'], ['iron-gear-wheel'])
  const belt_recipe = recipe('transport-belt', ['iron-plate', 'iron-gear-wheel'], ['transport-belt'])
  const cable_recipe = recipe('copper-cable', ['copper-plate'], ['copper-cable'])
  const gear = entity('assembling-machine-1', 'assembling-machine', 10, 4, 4, { get_recipe: () => [gear_recipe, undefined] })
  const belt = entity('assembling-machine-1', 'assembling-machine', 11, 8, 4, { get_recipe: () => [belt_recipe, undefined] })
  const unrelated = entity('assembling-machine-1', 'assembling-machine', 12, 8, 9, { get_recipe: () => [cable_recipe, undefined] })

  const plate_to_gear = entity('inserter', 'inserter', 20, 2.5, 4, {
    pickup_position: { x: 1, y: 4 }, drop_position: { x: 4, y: 4 }, pickup_target: input_belt, drop_target: gear,
  })
  const plate_to_belt = entity('inserter', 'inserter', 21, 6, 2.5, {
    pickup_position: { x: 4, y: 1 }, drop_position: { x: 8, y: 4 }, pickup_target: plate_split_belt, drop_target: belt,
  })
  const direct = entity('inserter', 'inserter', 22, 6, 4, {
    pickup_position: { x: 4, y: 4 }, drop_position: { x: 8, y: 4 }, pickup_target: gear, drop_target: belt,
  })
  const belt_to_output = entity('inserter', 'inserter', 23, 9, 4, {
    pickup_position: { x: 8, y: 4 }, drop_position: { x: 10, y: 4 }, pickup_target: belt, drop_target: output_belt,
  })

  const inside = [input_belt, plate_split_belt, output_belt, gear, belt, unrelated, plate_to_gear, plate_to_belt, direct, belt_to_output, ...extra]
  const all = [outside_input, ...inside, outside_output]
  const surface: any = {
    index: 1,
    name: 'nauvis',
    get_tile: () => ({ name: 'grass-1' }),
    find_entities_filtered: (filter: any) => {
      if (filter.type === 'resource') return []
      const area = filter.area
      if (!area) return all
      return all.filter(candidate => candidate.position.x >= area.left_top.x && candidate.position.x <= area.right_bottom.x
        && candidate.position.y >= area.left_top.y && candidate.position.y <= area.right_bottom.y)
    },
  }
  for (const value of all) value.surface = surface
  const actor: any = {
    is_valid: true,
    position: { x: 6, y: 4 },
    surface,
    force: { name: 'player' },
    character: undefined,
  }
  return { actor, surface }
}

const writes: Array<{ filename: string, data: string, append: boolean }> = []

beforeEach(() => {
  writes.length = 0
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game = { tick: 9000, connected_players: [] }
  ;(globalThis as any).helpers = {
    table_to_json: (value: unknown) => JSON.stringify(value),
    write_file: (filename: string, data: string, append: boolean) => writes.push({ filename, data, append }),
  }
})

describe('Factory Area Learning V1', () => {
  it('reuses bounded local spatial observation and extracts live recipes without provider reasoning', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { surface_index: 1, area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.spatial_source).toBe('local_spatial_observation')
    const analysis = get_factory_area_analysis(result.analysis_id)!
    expect(analysis.entity_count).toBeLessThanOrEqual(160)
    expect(analysis.entities.find(value => value.unit_number === 10)?.recipe?.name).toBe('iron-gear-wheel')
    expect(analysis.entities.find(value => value.unit_number === 11)?.recipe?.name).toBe('transport-belt')
    expect(analysis.area).toEqual({ left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } })
  })

  it('builds engine-confirmed inserter/direct-transfer and belt boundary relations', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    if (!result.ok) throw new Error(result.error)
    const analysis = get_factory_area_analysis(result.analysis_id)!
    expect(analysis.relations.some(relation => relation.kind === 'item_transfer' && relation.from === 'entity-10' && relation.to === 'entity-11' && relation.via === 'entity-22')).toBe(true)
    expect(analysis.relations.some(relation => relation.kind === 'boundary_input' && relation.to === 'entity-2')).toBe(true)
    expect(analysis.relations.some(relation => relation.kind === 'boundary_output' && relation.from === 'entity-4')).toBe(true)
    const direct = analysis.relations.find(relation => relation.via === 'entity-22')
    expect(direct?.item_names).toContain('iron-gear-wheel')
    expect(direct?.confidence).toBe('engine_exact')
  })

  it('uses connectivity plus recipe dependency for block boundaries, not mere proximity', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    if (!result.ok) throw new Error(result.error)
    const analysis = get_factory_area_analysis(result.analysis_id)!
    const target = analysis.blocks.find(block => block.recipe_ids.includes('transport-belt'))!
    expect(target.recipe_ids).toContain('iron-gear-wheel')
    expect(target.inputs).toEqual(['iron-plate'])
    expect(target.intermediates).toEqual(['iron-gear-wheel'])
    expect(target.outputs).toEqual(['transport-belt'])
    expect(target.entity_ids).not.toContain('entity-12')
    expect(analysis.blocks.some(block => block.recipe_ids.includes('copper-cable'))).toBe(true)
  })

  it('converts an observed block into the existing SkillDefinition without promoting it to verified', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    if (!result.ok) throw new Error(result.error)
    const analysis = get_factory_area_analysis(result.analysis_id)!
    const target = analysis.blocks.find(block => block.outputs.includes('transport-belt'))!
    const candidate = skill_candidate_definition_from_block(result.analysis_id, target.id)
    expect(candidate.status).toBe('candidate')
    expect(candidate.stage).toBe('executable_candidate')
    expect(candidate.source.kind).toBe('observed_factory')
    expect(candidate.source.area).toEqual({ surface_index: 1, left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } })
    expect(candidate.inputs.map(value => value.item)).toEqual(['iron-plate'])
    expect(candidate.outputs.map(value => value.item)).toEqual(['transport-belt'])
    expect(candidate.verification.structural).toBe('passed')
    expect(candidate.verification.recipe_flow).toBe('passed')
    expect(candidate.verification.placement_rebuild).toBe('not_tested')
    expect(candidate.verification.production_output).toBe('not_tested')
    expect(candidate.verification.inserter_sustained_throughput).toBe('unvalidated')
    expect(candidate.topology.relations.some(relation => relation.description?.includes('iron-gear-wheel'))).toBe(true)
    expect(JSON.stringify(candidate.topology)).not.toContain('"x"')
    expect(JSON.stringify(candidate.topology)).not.toContain('"y"')
  })

  it('uses the existing candidate registry and export path for a learned block', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    if (!result.ok) throw new Error(result.error)
    const target = get_factory_area_analysis(result.analysis_id)!.blocks.find(block => block.outputs.includes('transport-belt'))!
    const saved = create_skill_candidate(skill_candidate_definition_from_block(result.analysis_id, target.id))
    expect(saved.status).toBe('candidate')
    expect(get_skill_definition(saved.id)?.source.kind).toBe('observed_factory')
    const exported = export_skill(saved.id)
    expect(exported.relative_path).toContain(`script-output/sgluna-skills/${saved.id}/r1`)
    expect(writes.map(write => write.filename)).toEqual([
      `sgluna-skills/${saved.id}/r1/skill.json`,
      `sgluna-skills/${saved.id}/r1/SKILL.md`,
    ])
  })

  it('lets the existing Task Board skill UI save a detected block and export that generated candidate', () => {
    const { actor, surface } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
    if (!result.ok) throw new Error(result.error)
    const target = get_factory_area_analysis(result.analysis_id)!.blocks.find(block => block.outputs.includes('transport-belt'))!
    const messages: string[] = []
    const player = { surface, position: { x: 6, y: 4 }, print: (message: string) => messages.push(message) } as any
    expect(handle_skill_export_click(player, `airi_skill_save_block__${result.analysis_id}__${target.id}`)).toBe(true)
    const saved = get_skill_definition('transport-belt-production')!
    expect(saved.status).toBe('candidate')
    expect(handle_skill_export_click(player, `airi_skill_export__${saved.id}`)).toBe(true)
    expect(writes.map(write => write.filename)).toEqual([
      `sgluna-skills/${saved.id}/r1/skill.json`,
      `sgluna-skills/${saved.id}/r1/SKILL.md`,
    ])
    expect(messages.some(message => message.includes('Saved Transport Belt Production'))).toBe(true)
    expect(messages.some(message => message.includes('Exported Transport Belt Production'))).toBe(true)
  })

  it('keeps the deterministic scanner independent from LLM/provider code and exposes Learn Area in the existing skill panel', () => {
    const source = readFileSync(new URL('./factory_area_learning.ts', import.meta.url), 'utf8')
    const ui = readFileSync(new URL('./skills.ts', import.meta.url), 'utf8')
    expect(source).toContain('local_spatial_observation')
    expect(source).not.toMatch(/providerRequest|OPENAI|chat completion|llm/i)
    expect(ui).toContain("caption: 'LEARN AREA'")
    expect(ui).toContain("caption: 'SAVE SKILL CANDIDATE'")
    expect(ui).toContain('create_skill_candidate_from_factory_block')
  })

  it('reads a chest with engine semantics: no recipe call, one typed inventory read', () => {
    // Factorio raises on get_recipe outside crafting machines, and rejects a
    // call that passes the entity as an extra argument.
    const chest = entity('wooden-chest', 'container', 30, 11, 10, {
      get_recipe: () => { throw new Error('Entity is not crafting-machine.') },
      get_inventory: (...args: unknown[]) => {
        if (args.length !== 1) throw new Error(`Expected 1 argument but ${args.length} were given`)
        return { valid: true, get_contents: () => [{ name: 'coal', count: 3, quality: 'normal' }] }
      },
    })
    const originalChest = (globalThis as any).defines.inventory.chest
    ;(globalThis as any).defines.inventory.chest = 'chest'
    try {
      const { actor } = fixture([chest])
      const result = analyze_factory_area(actor, { surface_index: 1, area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 12, y: 11 } } })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const observed = get_factory_area_analysis(result.analysis_id)!.entities.find(value => value.unit_number === 30)!
      expect(observed.recipe).toBeUndefined()
      expect(observed.inventories).toEqual([{ role: 'storage', items: [{ name: 'coal', count: 3 }] }])
    }
    finally {
      ;(globalThis as any).defines.inventory.chest = originalChest
    }
  })

  it('rejects oversized area requests instead of scanning a megabase', () => {
    const { actor } = fixture()
    const result = analyze_factory_area(actor, { area: { left_top: { x: 0, y: 0 }, right_bottom: { x: 100, y: 100 } } })
    expect(result.ok).toBe(false)
  })
})
