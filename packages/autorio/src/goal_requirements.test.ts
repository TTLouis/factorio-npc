import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { goal_requirements } from './goal_requirements'

// Fixture names are arbitrary: the module reads the force and prototypes only
// and carries no game knowledge of its own.

const originalPrototypes = (globalThis as any).prototypes
const originalPairs = (globalThis as any).pairs

interface RecipeOptions {
  enabled?: boolean
  category?: string
  ingredients?: string[]
  hidden?: boolean
}

function recipe(name: string, options: RecipeOptions = {}, product = name) {
  return {
    name,
    enabled: options.enabled ?? true,
    hidden: options.hidden ?? false,
    category: options.category ?? 'crafting',
    additional_categories: [] as string[],
    ingredients: (options.ingredients ?? []).map(ingredient => ({ type: 'item', name: ingredient, amount: 1 })),
    products: [{ type: 'item', name: product, amount: 1 }],
  }
}

function technology(name: string, options: {
  researched?: boolean
  enabled?: boolean
  prerequisites?: Record<string, any>
  unlocks?: string[]
  ingredients?: Array<{ name: string, amount: number }>
} = {}) {
  return {
    name,
    level: 1,
    researched: options.researched ?? false,
    enabled: options.enabled ?? true,
    prerequisites: options.prerequisites ?? {},
    prototype: {
      max_level: 1,
      effects: (options.unlocks ?? []).map(recipe_name => ({ type: 'unlock-recipe', recipe: recipe_name })),
    },
    research_unit_count: 10,
    research_unit_energy: 30,
    research_unit_ingredients: options.ingredients ?? [{ name: 'pack-a', amount: 1 }],
  }
}

function actorWith(recipes: any[], technologies: any[]) {
  const recipe_table: Record<string, any> = {}
  for (const entry of recipes) recipe_table[entry.name] = entry
  const technology_table: Record<string, any> = {}
  for (const entry of technologies) technology_table[entry.name] = entry
  return {
    is_valid: true,
    force: { valid: true, index: 1, research_enabled: true, recipes: recipe_table, technologies: technology_table },
  } as unknown as ControlledActor
}

interface MachineFixture { name: string, type?: string, places?: string[], categories: string[] }

function installPrototypes(options: { triggers?: Record<string, any>, machines?: MachineFixture[], items?: string[], fluids?: string[], resources?: Record<string, string[]> } = {}) {
  const machines = options.machines ?? []
  const entity: Record<string, any> = {}
  for (const machine of machines) {
    entity[machine.name] = {
      type: machine.type ?? 'assembling-machine',
      items_to_place_this: (machine.places ?? []).map(name => ({ name, count: 1 })),
    }
  }
  for (const name in options.resources ?? {}) {
    entity[name] = { type: 'resource', mineable_properties: { minable: true, products: options.resources![name].map(product => ({ type: 'item', name: product })) } }
  }
  const technology: Record<string, any> = {}
  for (const name in options.triggers ?? {}) technology[name] = { research_trigger: (options.triggers ?? {})[name] }
  const item: Record<string, any> = {}
  for (const name of options.items ?? []) item[name] = {}
  const fluid: Record<string, any> = {}
  for (const name of options.fluids ?? []) fluid[name] = {}
  ;(globalThis as any).prototypes = {
    entity,
    item,
    fluid,
    technology,
    get_entity_filtered: (filters: any[]) => {
      const category = filters[0].crafting_category
      const matches: Record<string, any> = {}
      for (const machine of machines) {
        if (machine.categories.includes(category)) matches[machine.name] = entity[machine.name]
      }
      return matches
    },
  }
}

beforeEach(() => {
  ;(globalThis as any).pairs = (value: Record<string, unknown>) => Object.entries(value)
})

afterEach(() => {
  ;(globalThis as any).prototypes = originalPrototypes
  ;(globalThis as any).pairs = originalPairs
})

// The shape of the live goal_052327n_1 run: the target recipe is locked behind
// a trigger technology that itself waits on a science prerequisite.
function lockedTargetFixture() {
  installPrototypes({
    triggers: { 'unlock-tech': { type: 'craft-item', item: { name: 'plate-a' }, count: 10 } },
    items: ['plate-a', 'gear', 'target-pack'],
  })
  const base = technology('base-tech', { ingredients: [{ name: 'pack-a', amount: 1 }] })
  const unlock = technology('unlock-tech', { prerequisites: { 'base-tech': base }, unlocks: ['target-pack'] })
  return actorWith(
    [
      recipe('target-pack', { enabled: false, ingredients: ['plate-b', 'gear'] }),
      recipe('plate-b', { category: 'smelting', ingredients: ['ore-b'] }),
      recipe('gear', { ingredients: ['plate-a'] }),
      recipe('plate-a', { category: 'smelting', ingredients: ['ore-a'] }),
    ],
    [base, unlock],
  )
}

describe('goal requirements query', () => {
  it('does not require an alternate locked recipe for an ore mined from a resource', () => {
    installPrototypes({ items: ['ore-a', 'plate-a'], resources: { 'deposit-a': ['ore-a'] } })
    const alternate = technology('orbital-tech', { unlocks: ['orbital-ore'] })
    const actor = actorWith([
      recipe('plate-a', { ingredients: ['ore-a'] }),
      recipe('orbital-ore', { enabled: false, ingredients: ['chunk-a'] }, 'ore-a'),
    ], [alternate])
    for (const item of ['plate-a', 'ore-a']) {
      const result: any = goal_requirements(actor, { items: [item] })
      expect(result.ok).toBe(true)
      expect(result.locked).toEqual([])
      expect(result.research).toEqual({})
      expect(result.counts.raw_items).toBe(1)
      expect(result.truncated.paths).toBe(false)
    }
  })

  it('does not treat reclaiming a placed machine as raw-resource acquisition', () => {
    installPrototypes({ items: ['machine-a'], machines: [{ name: 'machine-a', places: ['machine-a'], categories: [] }] })
    ;(globalThis as any).prototypes.entity['machine-a'].mineable_properties = { minable: true, products: [{ type: 'item', name: 'machine-a' }] }
    const actor = actorWith([recipe('machine-a', { enabled: false })], [technology('machine-tech', { unlocks: ['machine-a'] })])
    const result: any = goal_requirements(actor, { items: ['machine-a'] })
    expect(result.locked[0]).toMatchObject({ subject: 'machine-a', unlocked_by: 'machine-tech' })
  })

  it('reports a locked target recipe, its trigger technology and the pending science prerequisite first', () => {
    const actor = lockedTargetFixture()
    const result: any = goal_requirements(actor, { items: [{ name: 'target-pack', machine_output: false }] })

    expect(result.ok).toBe(true)
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]).toMatchObject({
      subject: 'target-pack',
      role: 'target_recipe',
      recipe: 'target-pack',
      unlocked_by: 'unlock-tech',
      path: ['base-tech', 'unlock-tech'],
    })
    expect(result.research['unlock-tech']).toMatchObject({
      mode: 'trigger',
      status: 'blocked_by_prerequisites',
      trigger: { type: 'craft-item', item: 'plate-a', count: 10 },
      requires: ['base-tech'],
    })
    expect(result.research['base-tech']).toMatchObject({
      mode: 'science',
      status: 'ready',
      science: { count: 10, ingredients: [{ name: 'pack-a', amount: 1 }] },
    })
    // Unlocked ingredients are only counted, never listed.
    expect(result.counts).toMatchObject({ locked: 1, unlocked_recipes: 3, raw_items: 2 })
    expect(JSON.stringify(result)).not.toContain('"gear"')
    expect(result.truncated.walk_depth).toBe(false)
    expect(result.truncated.walk_nodes).toBe(false)
  })

  it('reports nothing locked when the target recipe is enabled', () => {
    const actor = lockedTargetFixture()
    ;(actor.force.recipes as any)['target-pack'].enabled = true
    const result: any = goal_requirements(actor, { items: ['target-pack'] })
    expect(result.ok).toBe(true)
    expect(result.locked).toEqual([])
    expect(result.research).toEqual({})
  })

  it('picks the unlocking technology with the fewest pending nodes, then the name', () => {
    installPrototypes({ items: ['target-pack'] })
    const far_prerequisite = technology('far-prerequisite')
    const far = technology('a-far-tech', { prerequisites: { 'far-prerequisite': far_prerequisite }, unlocks: ['target-pack'] })
    const near = technology('z-near-tech', { unlocks: ['target-pack'] })
    const tied = technology('b-near-tech', { unlocks: ['target-pack'] })
    const actor = actorWith([recipe('target-pack', { enabled: false })], [far_prerequisite, far, near, tied])
    const result: any = goal_requirements(actor, { items: ['target-pack'] })
    expect(result.locked[0].unlocked_by).toBe('b-near-tech')
    expect(result.locked[0].path).toEqual(['b-near-tech'])
  })

  it('resolves an item through the recipe that lists it as a product when no recipe has its name', () => {
    installPrototypes({ items: ['fuel-thing'] })
    const unlock = technology('fuel-tech', { unlocks: ['fuel-thing-from-gas'] })
    const actor = actorWith([recipe('fuel-thing-from-gas', { enabled: false }, 'fuel-thing')], [unlock])
    const result: any = goal_requirements(actor, { items: ['fuel-thing'] })
    expect(result.locked[0]).toMatchObject({ subject: 'fuel-thing', recipe: 'fuel-thing-from-gas', unlocked_by: 'fuel-tech' })
  })

  it('reports a locked ingredient recipe with what needs it', () => {
    installPrototypes({ items: ['product', 'part'] })
    const part_tech = technology('part-tech', { unlocks: ['part'] })
    const actor = actorWith(
      [
        recipe('product', { ingredients: ['part', 'plate'] }),
        recipe('part', { enabled: false, ingredients: ['plate'] }),
        recipe('plate', { category: 'smelting' }),
      ],
      [part_tech],
    )
    const result: any = goal_requirements(actor, { items: ['product'] })
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]).toMatchObject({ subject: 'part', role: 'ingredient_recipe', needed_for: 'product', unlocked_by: 'part-tech', path: ['part-tech'] })
  })

  it('marks a locked recipe that no technology unlocks instead of inventing one', () => {
    installPrototypes({ items: ['orphan'] })
    const actor = actorWith([recipe('orphan', { enabled: false })], [])
    const result: any = goal_requirements(actor, { items: ['orphan'] })
    expect(result.locked[0]).toMatchObject({ subject: 'orphan', unlock_unknown: true, path: [] })
    expect(result.locked[0].unlocked_by).toBeUndefined()
  })

  it('machine_output lists crafting machines by category and reports a locked machine with its unlock path', () => {
    installPrototypes({
      triggers: { 'machine-tech': { type: 'build-entity', entity: { name: 'furnace-x' } } },
      machines: [
        { name: 'assembler-1', places: ['assembler-1'], categories: ['crafting'] },
        { name: 'assembler-2', places: ['assembler-2'], categories: ['crafting'] },
        { name: 'furnace-x', type: 'furnace', places: ['furnace-x'], categories: ['smelting'] },
        // Hand crafting and entities that cannot be placed are never machine options.
        { name: 'character', type: 'character', places: [], categories: ['crafting'] },
        { name: 'ghost-machine', places: [], categories: ['crafting'] },
      ],
      items: ['product'],
    })
    const prerequisite = technology('machine-prerequisite')
    const machine_tech = technology('machine-tech', { prerequisites: { 'machine-prerequisite': prerequisite }, unlocks: ['assembler-1'] })
    const second_tech = technology('second-machine-tech', { prerequisites: { 'machine-tech': machine_tech }, unlocks: ['assembler-2'] })
    const actor = actorWith(
      [
        recipe('product', { ingredients: ['plate'] }),
        recipe('plate', { category: 'smelting' }),
        recipe('assembler-1', { enabled: false, ingredients: ['plate'] }),
        recipe('assembler-2', { enabled: false, ingredients: ['plate'] }),
      ],
      [prerequisite, machine_tech, second_tech],
    )

    const hand_only: any = goal_requirements(actor, { items: [{ name: 'product', machine_output: false }] })
    expect(hand_only.machines).toEqual([])
    expect(hand_only.locked).toEqual([])

    const result: any = goal_requirements(actor, { items: [{ name: 'product', machine_output: true }] })
    expect(result.machines).toHaveLength(1)
    expect(result.machines[0]).toMatchObject({ for_item: 'product', recipe: 'product', craftable: false, truncated: false })
    expect(result.machines[0].options.map((option: any) => option.entity)).toEqual(['assembler-1', 'assembler-2'])
    expect(result.machines[0].options[0]).toMatchObject({ item: 'assembler-1', status: 'locked', unlocked_by: 'machine-tech' })
    expect(result.locked.map((entry: any) => [entry.role, entry.subject, entry.unlocked_by])).toEqual([
      ['machine', 'assembler-1', 'machine-tech'],
      ['machine', 'assembler-2', 'second-machine-tech'],
    ])
    expect(result.locked[0].path).toEqual(['machine-prerequisite', 'machine-tech'])
    expect(result.research['machine-tech'].trigger).toEqual({ type: 'build-entity', entity: 'furnace-x' })
  })

  it('does not report machines as locked once one of them is craftable, and still walks its ingredients', () => {
    installPrototypes({
      machines: [
        { name: 'assembler-1', places: ['assembler-1'], categories: ['crafting'] },
        { name: 'assembler-2', places: ['assembler-2'], categories: ['crafting'] },
      ],
      items: ['product'],
    })
    const second_tech = technology('second-machine-tech', { unlocks: ['assembler-2'] })
    const circuit_tech = technology('circuit-tech', { unlocks: ['circuit'] })
    const actor = actorWith(
      [
        recipe('product'),
        recipe('assembler-1', { ingredients: ['circuit'] }),
        recipe('assembler-2', { enabled: false }),
        recipe('circuit', { enabled: false }),
      ],
      [second_tech, circuit_tech],
    )
    const result: any = goal_requirements(actor, { items: [{ name: 'product', machine_output: true }] })
    expect(result.machines[0]).toMatchObject({ craftable: true })
    expect(result.machines[0].options.map((option: any) => option.status)).toEqual(['craftable', 'locked'])
    expect(result.locked.map((entry: any) => [entry.role, entry.subject, entry.needed_for])).toEqual([['ingredient_recipe', 'circuit', 'assembler-1']])
  })

  it('gives a target technology its dependency-first pending path and skips researched ones', () => {
    installPrototypes({ triggers: { 'trigger-prerequisite': { type: 'mine-entity', entity: 'rock-a' } } })
    const trigger_prerequisite = technology('trigger-prerequisite')
    const target = technology('target-tech', { prerequisites: { 'trigger-prerequisite': trigger_prerequisite } })
    const done = technology('done-tech', { researched: true })
    const actor = actorWith([], [trigger_prerequisite, target, done])
    const result: any = goal_requirements(actor, { technologies: ['target-tech', 'done-tech', 'missing-tech'] })
    expect(result.ok).toBe(true)
    expect(result.locked).toHaveLength(1)
    expect(result.locked[0]).toMatchObject({ subject: 'target-tech', role: 'target_technology', unlocked_by: 'target-tech', path: ['trigger-prerequisite', 'target-tech'] })
    expect(result.research['trigger-prerequisite']).toMatchObject({ mode: 'trigger', trigger: { type: 'mine-entity', entity: 'rock-a' } })
    expect(result.unknown).toEqual(['missing-tech'])
  })

  it('treats a target entity as the item that places it', () => {
    installPrototypes({ machines: [{ name: 'drill-e', type: 'mining-drill', places: ['drill-e'], categories: [] }], items: ['drill-e'] })
    const drill_tech = technology('drill-tech', { unlocks: ['drill-e'] })
    const actor = actorWith([recipe('drill-e', { enabled: false })], [drill_tech])
    const result: any = goal_requirements(actor, { entities: ['drill-e', 'not-an-entity'] })
    expect(result.locked[0]).toMatchObject({ subject: 'drill-e', role: 'target_entity', recipe: 'drill-e', unlocked_by: 'drill-tech' })
    expect(result.unknown).toEqual(['not-an-entity'])
  })

  it('is cycle-safe: recipes that need each other terminate and are visited once', () => {
    installPrototypes({ items: ['loop-a'] })
    const actor = actorWith(
      [
        recipe('loop-a', { ingredients: ['loop-b'] }),
        recipe('loop-b', { ingredients: ['loop-c'] }),
        recipe('loop-c', { ingredients: ['loop-a', 'loop-b'] }),
      ],
      [],
    )
    const result: any = goal_requirements(actor, { items: ['loop-a'] })
    expect(result.ok).toBe(true)
    expect(result.counts.recipes_walked).toBe(3)
    expect(result.truncated.walk_depth).toBe(false)
  })

  it('stops a long ingredient chain at the depth bound and says so', () => {
    installPrototypes({ items: ['link-0'] })
    const recipes = []
    for (let index = 0; index < 12; index++) recipes.push(recipe(`link-${index}`, { ingredients: [`link-${index + 1}`] }))
    const actor = actorWith(recipes, [])
    const result: any = goal_requirements(actor, { items: ['link-0'] })
    expect(result.ok).toBe(true)
    expect(result.truncated.walk_depth).toBe(true)
    expect(result.counts.recipes_walked).toBeLessThanOrEqual(6)
  })

  it('stops a wide ingredient fan-out at the node bound and says so', () => {
    installPrototypes({ items: ['wide'] })
    const ingredients = []
    const recipes = []
    for (let index = 0; index < 80; index++) {
      ingredients.push(`part-${index}`)
      recipes.push(recipe(`part-${index}`, { ingredients: [`leaf-${index}`] }))
      recipes.push(recipe(`leaf-${index}`))
    }
    recipes.push(recipe('wide', { ingredients }))
    const actor = actorWith(recipes, [])
    const result: any = goal_requirements(actor, { items: ['wide'] })
    expect(result.ok).toBe(true)
    expect(result.truncated.walk_nodes).toBe(true)
    expect(result.counts.recipes_walked).toBe(64)
  })

  it('caps locked entries and research nodes with explicit truncation flags', () => {
    installPrototypes({ items: ['root'] })
    const recipes = [] as any[]
    const technologies = [] as any[]
    const ingredients = []
    for (let index = 0; index < 20; index++) {
      const name = `locked-${String(index).padStart(2, '0')}`
      ingredients.push(name)
      recipes.push(recipe(name, { enabled: false }))
      technologies.push(technology(`tech-${name}`, { unlocks: [name] }))
    }
    recipes.push(recipe('root', { ingredients }))
    const actor = actorWith(recipes, technologies)
    const result: any = goal_requirements(actor, { items: ['root'] })
    expect(result.locked).toHaveLength(12)
    expect(result.truncated.locked).toBe(true)
    expect(Object.keys(result.research).length).toBeLessThanOrEqual(24)
  })

  it('bounds the targets and merges a repeated item', () => {
    installPrototypes({ items: [] })
    const items = []
    for (let index = 0; index < 12; index++) items.push({ name: `thing-${index}` })
    const result: any = goal_requirements(actorWith([], []), { items })
    expect(result.ok).toBe(true)
    expect(result.targets.items).toBe(8)
    expect(result.truncated.targets).toBe(true)
    expect(result.unknown).toHaveLength(8)

    const merged: any = goal_requirements(actorWith([recipe('x')], []), { items: [{ name: 'x' }, { name: 'x', machine_output: true }] })
    expect(merged.targets.items).toBe(1)
  })

  it('refuses a missing actor and malformed requests without touching the world', () => {
    installPrototypes()
    expect((goal_requirements(undefined, { items: ['x'] }) as any).error.code).toBe('NO_ACTOR')
    expect((goal_requirements({ is_valid: false } as any, { items: ['x'] }) as any).error.code).toBe('NO_ACTOR')
    const actor = actorWith([], [])
    expect((goal_requirements(actor, 'steam') as any).error.code).toBe('INVALID_REQUEST')
    expect((goal_requirements(actor, {}) as any).error.code).toBe('INVALID_REQUEST')
    expect((goal_requirements(actor, { items: [42] }) as any).error.code).toBe('INVALID_NAME')
    expect((goal_requirements(actor, { technologies: ['bad\nname'] }) as any).error.code).toBe('INVALID_NAME')
  })
})
