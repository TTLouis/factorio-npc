import { beforeEach, describe, expect, it } from 'vitest'
import {
  assert_safe_skill_id,
  canonicalize_skill_definition,
  create_skill_candidate,
  derive_skill_tags,
  ensure_basic_skill_definitions,
  export_skill,
  find_skill_definitions,
  generate_skill_markdown,
  get_skill_definition,
  goal_search_terms,
  handle_skill_export_click,
  list_skill_definitions,
  MAX_DYNAMIC_SKILL_DEFINITIONS,
  put_skill_definition,
  RETIRED_BASIC_SKILL_IDS,
  serialize_skill_json,
  skill_cards_for_goal,
  skill_export_relative_directory,
  skill_precondition_check,
  utf8_safe_prefix,
} from './skills'
import type { SkillNeedCheck, SkillWorldView } from './skills'
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
  it('seeds exactly eleven manual candidate patterns idempotently', () => {
    expect(ensure_basic_skill_definitions()).toEqual({ added: 11, upgraded: 0, removed: 0, total: 11 })
    const skills = list_skill_definitions()
    expect(skills).toHaveLength(11)
    expect(skills.every(skill => skill.source.kind === 'manual')).toBe(true)
    expect(skills.every(skill => skill.status === 'candidate')).toBe(true)
    expect(skills.every(skill => skill.stage === 'pattern')).toBe(true)
    expect(skills.every(skill => skill.verification.production_output === 'not_tested')).toBe(true)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 0, total: 11 })
    expect(list_skill_definitions()).toHaveLength(11)
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

    expect(ensure_basic_skill_definitions()).toEqual({ added: 10, upgraded: 0, removed: 0, total: 11 })
    expect(get_skill_definition('burner-coal-loop')?.name).toBe('Player Authored Coal Pattern')
    expect(get_skill_definition('burner-coal-loop')?.source.kind).toBe('completed_goal')
  })

  it('does not ship the retired automation-science-bootstrap skill or offer it for red science goals', () => {
    expect(RETIRED_BASIC_SKILL_IDS).toEqual(['automation-science-bootstrap'])
    ensure_basic_skill_definitions()
    expect(get_skill_definition('automation-science-bootstrap')).toBeUndefined()
    expect(skill_cards_for_goal('Automate red science packs', 5, fresh_world()).map(card => card.id)).not.toContain('automation-science-bootstrap')
    expect(find_skill_definitions('red science automation-science-pack', 5).map(result => result.id)).not.toContain('automation-science-bootstrap')
  })

  it('removes a stored unedited copy of a retired curated skill when seeding', () => {
    ensure_basic_skill_definitions()
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    registry['automation-science-bootstrap'] = { ...registry['burner-coal-loop'], id: 'automation-science-bootstrap', name: 'Automation Science Bootstrap', revision: 2 }
    expect(list_skill_definitions()).toHaveLength(12)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 1, total: 11 })
    expect(get_skill_definition('automation-science-bootstrap')).toBeUndefined()
    expect(list_skill_definitions()).toHaveLength(11)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 0, total: 11 })
  })

  it('keeps a player-edited copy of a retired curated skill', () => {
    ensure_basic_skill_definitions()
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    registry['automation-science-bootstrap'] = { ...registry['burner-coal-loop'], id: 'automation-science-bootstrap', name: 'Automation Science Bootstrap', revision: 2 }
    const edited = edited_skill_revision(registry['automation-science-bootstrap'], { name: 'House Red Science', summary: 'Ours.', status: 'candidate' }, 'owner', 907)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 0, removed: 0, total: 11 })
    expect(get_skill_definition('automation-science-bootstrap')).toEqual(edited)
    expect(get_skill_definition('automation-science-bootstrap')?.name).toBe('House Red Science')
  })

  it('keeps a learned skill that reuses a retired id and counts it as a dynamic skill', () => {
    create_skill_candidate(candidate({
      id: 'automation-science-bootstrap',
      name: 'Learned Red Science',
      source: { kind: 'completed_goal', goal_id: 'goal_learned', entity_unit_numbers: [], recipe_ids: [], evidence_refs: ['goal:learned'] },
    }))
    expect(ensure_basic_skill_definitions()).toEqual({ added: 11, upgraded: 0, removed: 0, total: 11 })
    expect(get_skill_definition('automation-science-bootstrap')?.name).toBe('Learned Red Science')
    // The retired id is not a basic id, so it uses the dynamic capacity like any learned skill.
    for (let index = 0; index < MAX_DYNAMIC_SKILL_DEFINITIONS - 1; index++) {
      create_skill_candidate(candidate({ id: `dynamic-skill-${index}`, name: `Dynamic Skill ${index}`, source: { kind: 'completed_goal', goal_id: `goal-${index}`, entity_unit_numbers: [], recipe_ids: [], evidence_refs: [`goal:${index}`] } }))
    }
    expect(() => create_skill_candidate(candidate({ id: 'dynamic-skill-overflow', name: 'Overflow' }))).toThrow(/dynamic capacity reached/i)
  })
})

// A fresh base-game 2.0 save: nothing held or placed; steam power and
// automation not researched, so the steam entities are locked behind
// steam-power; burner drills, stone furnaces and belts can be hand-crafted.
// Abstract subjects (coal-resource, fuel-or-energy-input) stay unknown.
function fresh_world(overrides: Partial<{ researched: string[], have: string[] }> = {}): SkillWorldView {
  const researched = overrides.researched ?? []
  const have = overrides.have ?? []
  const entity_recipes: Record<string, { via: string, technology?: string }> = {
    'offshore-pump': { via: 'offshore-pump', technology: 'steam-power' },
    'boiler': { via: 'boiler', technology: 'steam-power' },
    'generator': { via: 'steam-engine', technology: 'steam-power' },
    'mining-drill': { via: 'burner-mining-drill' },
    'burner-mining-drill': { via: 'burner-mining-drill' },
    'furnace': { via: 'stone-furnace' },
    'transport-belt': { via: 'transport-belt' },
  }
  return {
    check_technology: name => ['automation', 'steam-power', 'logistics'].includes(name)
      ? (researched.includes(name) ? { state: 'have' } : { state: 'locked', technology: name })
      : undefined,
    check_item: () => undefined,
    check_entity: (subject) => {
      const entry = entity_recipes[subject]
      if (entry === undefined) return undefined
      if (have.includes(entry.via)) return { state: 'have', via: entry.via }
      if (entry.technology !== undefined && !researched.includes(entry.technology)) return { state: 'locked', via: entry.via, technology: entry.technology }
      return { state: 'can_craft', via: entry.via }
    },
  }
}

// A learned (not curated) red-science skill: a technology precondition plus a
// real item output, for the need and tag tests that used to lean on the retired
// curated skill.
function learned_science_candidate(overrides: Record<string, unknown> = {}) {
  return candidate({
    id: 'learned-red-science',
    name: 'Learned Red Science',
    goal_tags: ['science', 'red-science'],
    preconditions: [
      { kind: 'technology_researched', subject: 'automation', description: 'Automation is researched.' },
      { kind: 'bootstrap', subject: 'science-goal', description: 'The task needs automated research supply.' },
    ],
    inputs: [{ item: 'science-ingredients', role: 'live recipe inputs' }],
    outputs: [{ item: 'automation-science-pack', role: 'science output' }],
    topology: {
      nodes: [
        { id: 'gear-assembler', role: 'Produce gear intermediate', entity_name: 'assembling-machine-1', recipe: 'iron-gear-wheel' },
        { id: 'belt-assembler', role: 'Craft the science pack', entity_name: 'assembling-machine-1', recipe: 'automation-science-pack' },
      ],
      relations: [{ kind: 'direct_item_output', from: 'gear-assembler', to: 'belt-assembler', description: 'Gears feed the science assembler.' }],
    },
    ...overrides,
  })
}

// fresh_world() whose check_item answers from a table (an item it does not list
// is not something the game knows, which is how check_item reports it).
function world_with_items(items: Record<string, SkillNeedCheck>, overrides: Partial<{ researched: string[], have: string[] }> = {}): SkillWorldView {
  return { ...fresh_world(overrides), check_item: item => items[item] }
}

describe('skill lookup: tags, scoring, preconditions and cards (plan 2.8)', () => {
  it('derives tags from outputs, topology entities and recipes, and technology preconditions, plus the short goal_tags list', () => {
    ensure_basic_skill_definitions()
    const steam = derive_skill_tags(get_skill_definition('steam-power-bootstrap')!)
    expect(steam.filter(tag => tag.source === 'goal').map(tag => tag.tag)).toEqual(['power', 'electricity', 'electric', 'steam', 'steam-power', 'electric-network'])
    expect(steam.filter(tag => tag.source === 'output').map(tag => tag.tag)).toEqual(['electric-power'])
    expect(steam.filter(tag => tag.source === 'entity').map(tag => tag.tag)).toEqual(['offshore-pump', 'boiler', 'steam-engine', 'small-electric-pole'])

    const science = derive_skill_tags(canonicalize_skill_definition(learned_science_candidate()))
    expect(science).toContainEqual({ tag: 'automation', source: 'technology' })
    expect(science).toContainEqual({ tag: 'automation-science-pack', source: 'output' })
    expect(science).toContainEqual({ tag: 'assembling-machine-1', source: 'entity' })
    // A tag is listed once, under its first (strongest) source.
    expect(science.filter(tag => tag.tag === 'automation-science-pack')).toHaveLength(1)

    // A learned skill without goal_tags still gets derived tags.
    const learned = derive_skill_tags(canonicalize_skill_definition(candidate()))
    expect(learned.map(tag => tag.tag)).toEqual(['transport-belt', 'assembling-machine-1', 'iron-gear-wheel'])
  })

  it('normalizes goal_tags and omits the field when a skill has none, so older canonical JSON is unchanged', () => {
    const tagged = canonicalize_skill_definition(candidate({ goal_tags: ['Belt Line', 'belt_line', ' logistics '] }))
    expect(tagged.goal_tags).toEqual(['belt-line', 'logistics'])
    const untagged = canonicalize_skill_definition(candidate())
    expect('goal_tags' in untagged).toBe(false)
    expect(() => canonicalize_skill_definition(candidate({ goal_tags: Array.from({ length: 17 }, (_, index) => `tag-${index}`) }))).toThrow(/goal_tags exceeds/)
  })

  it('reads goal text into words, singulars and adjacent phrases', () => {
    const goal = goal_search_terms('Automate red science packs, please!')
    expect(goal.terms).toContain('red-science')
    expect(goal.terms).toContain('science-pack')
    expect(goal.terms).toContain('red-science-pack')
    expect(goal.terms).not.toContain('please')
  })

  // Eval (plan 2.8 d): fixed goal texts must put the expected skill in the top 3.
  const eval_goals: Array<[string, string]> = [
    ['Get steam power running so we have electricity', 'steam-power-bootstrap'],
    ['Set up a burner coal loop to fuel the drills', 'burner-coal-loop'],
    ['Build a smelting row for iron plates', 'starter-smelting-row'],
  ]
  for (const [goal, expected] of eval_goals) {
    it(`eval: "${goal}" offers ${expected} in the top 3`, () => {
      ensure_basic_skill_definitions()
      const offered = skill_cards_for_goal(goal, 5, fresh_world()).map(card => card.id)
      expect(offered.slice(0, 3)).toContain(expected)
      expect(offered[0]).toBe(expected)
    })
  }

  it('reports each need as have, can_craft, locked (naming the technology) or unknown; only locked lowers the score', () => {
    ensure_basic_skill_definitions()
    const science = canonicalize_skill_definition(learned_science_candidate())
    const automation = science.preconditions.find(condition => condition.subject === 'automation')!
    expect(skill_precondition_check(automation, fresh_world())).toEqual({ state: 'locked', technology: 'automation' })
    expect(skill_precondition_check(automation, fresh_world({ researched: ['automation'] }))).toEqual({ state: 'have' })
    expect(skill_precondition_check(automation, undefined)).toEqual({ state: 'unknown' })
    const coal = get_skill_definition('burner-coal-loop')!.preconditions.find(condition => condition.subject === 'coal-resource')!
    expect(skill_precondition_check(coal, fresh_world())).toEqual({ state: 'unknown' })

    put_skill_definition(learned_science_candidate())
    const before = skill_cards_for_goal('Automate red science packs', 5, fresh_world())[0]
    const after = skill_cards_for_goal('Automate red science packs', 5, fresh_world({ researched: ['automation'] }))[0]
    expect(before.needs).toEqual([
      { subject: 'automation', state: 'locked', technology: 'automation' },
      { subject: 'science-goal', state: 'unknown' },
    ])
    expect(after.needs[0]).toEqual({ subject: 'automation', state: 'have' })
    expect(after.score).toBe(before.score + 0.25)

    // Researching the unlock flips locked to can_craft; placing one makes it have.
    const steam_goal = 'Get steam power running so we have electricity'
    const locked = skill_cards_for_goal(steam_goal, 1, fresh_world())[0]
    const craftable = skill_cards_for_goal(steam_goal, 1, fresh_world({ researched: ['steam-power'] }))[0]
    const held = skill_cards_for_goal(steam_goal, 1, fresh_world({ researched: ['steam-power'], have: ['offshore-pump', 'boiler', 'steam-engine'] }))[0]
    expect(locked.needs[0]).toEqual({ subject: 'offshore-pump', state: 'locked', technology: 'steam-power' })
    expect(craftable.needs.slice(0, 3).map(need => need.state)).toEqual(['can_craft', 'can_craft', 'can_craft'])
    expect(held.needs.slice(0, 3).map(need => need.state)).toEqual(['have', 'have', 'have'])
    // have and can_craft carry no penalty; three locked needs cost 0.75.
    expect(craftable.score).toBe(held.score)
    expect(craftable.score).toBe(locked.score + 0.75)

    // A burner coal loop on a fresh save: the drill is hand-craftable, so nothing is penalized.
    const coal_card = skill_cards_for_goal('Set up a burner coal loop', 1, fresh_world())[0]
    expect(coal_card.needs[0]).toEqual({ subject: 'burner-mining-drill', state: 'can_craft' })
    expect(coal_card.score).toBe(skill_cards_for_goal('Set up a burner coal loop', 1)[0].score)
  })

  it('adds a locked need naming the technology when the skill\'s own output recipe is locked', () => {
    put_skill_definition(learned_science_candidate())
    const goal = 'Automate red science packs'
    const locked_world = world_with_items({ 'automation-science-pack': { state: 'locked', via: 'automation-science-pack', technology: 'automation-science-pack' } }, { researched: ['automation'] })
    const unlocked_world = world_with_items({ 'automation-science-pack': { state: 'can_craft', via: 'automation-science-pack' } }, { researched: ['automation'] })
    const [locked] = skill_cards_for_goal(goal, 5, locked_world)
    const [unlocked] = skill_cards_for_goal(goal, 5, unlocked_world)
    // The machine technology is researched, yet the science-pack recipe is still locked: the card says so.
    expect(locked.needs).toEqual([
      { subject: 'automation', state: 'have' },
      { subject: 'science-goal', state: 'unknown' },
      { subject: 'automation-science-pack', state: 'locked', technology: 'automation-science-pack' },
    ])
    expect(locked.score).toBe(unlocked.score - 0.25)
    // The find results carry the same needs.
    expect(find_skill_definitions('red science', 3, locked_world)[0].needs).toEqual(locked.needs)
  })

  it('adds no need for an output that is held, craftable or not something the game knows', () => {
    put_skill_definition(learned_science_candidate())
    const goal = 'Automate red science packs'
    const baseline = skill_cards_for_goal(goal, 5, fresh_world({ researched: ['automation'] }))[0]
    expect(baseline.needs.map(need => need.subject)).toEqual(['automation', 'science-goal'])
    for (const check of [{ state: 'have', via: 'automation-science-pack' }, { state: 'can_craft', via: 'automation-science-pack' }, { state: 'unknown' }, undefined] as Array<SkillNeedCheck | undefined>) {
      const items: Record<string, SkillNeedCheck> = {}
      if (check !== undefined) items['automation-science-pack'] = check
      const card = skill_cards_for_goal(goal, 5, world_with_items(items, { researched: ['automation'] }))[0]
      expect(card.needs).toEqual(baseline.needs)
      expect(card.score).toBe(baseline.score)
    }
    // Without a world view nothing is checked.
    expect(skill_cards_for_goal(goal, 5)[0].needs.map(need => need.subject)).toEqual(['automation', 'science-goal'])
    // An abstract curated output (electric-power) is never an item, so it stays silent.
    ensure_basic_skill_definitions()
    const steam = skill_cards_for_goal('Get steam power running so we have electricity', 1, world_with_items({}))[0]
    expect(steam.needs.map(need => need.subject)).not.toContain('electric-power')
  })

  it('keeps a locked output need visible when the card needs are cut to five', () => {
    const subjects = ['one', 'two', 'three', 'four', 'five']
    put_skill_definition(learned_science_candidate({
      preconditions: subjects.map(subject => ({ kind: 'custom', subject, description: subject })),
    }))
    const goal = 'Automate red science packs'
    const locked_items = { 'automation-science-pack': { state: 'locked', via: 'automation-science-pack', technology: 'research-x' } } as Record<string, SkillNeedCheck>
    const cards = skill_cards_for_goal(goal, 5, world_with_items(locked_items))
    expect(cards[0].needs.map(need => need.subject)).toEqual(['one', 'two', 'three', 'four', 'automation-science-pack'])
    expect(cards[0].needs[4]).toEqual({ subject: 'automation-science-pack', state: 'locked', technology: 'research-x' })
    const results = find_skill_definitions('red science', 3, world_with_items(locked_items))
    expect(results[0].needs.map(need => need.subject)).toEqual(['one', 'two', 'three', 'four', 'automation-science-pack'])
    // Unlocked: the first five preconditions are shown, as before.
    expect(skill_cards_for_goal(goal, 5, world_with_items({}))[0].needs.map(need => need.subject)).toEqual(subjects)
  })

  it('needs at least one tag match, or two text hits, before a skill is offered', () => {
    put_skill_definition(candidate({ id: 'belt-line-a', name: 'A Belt Line' }))
    // candidate() has tags transport-belt, assembling-machine-1, iron-gear-wheel;
    // "preserving" and "relationship" appear only in its text.
    expect(skill_cards_for_goal('preserving things', 5)).toEqual([])
    expect(skill_cards_for_goal('preserving relationship', 5).map(card => card.id)).toEqual(['belt-line-a'])
    expect(skill_cards_for_goal('gear', 5)).toEqual([])
    expect(skill_cards_for_goal('iron-gear-wheel', 5).map(card => card.id)).toEqual(['belt-line-a'])
  })

  it('cuts long goals by UTF-8 bytes instead of refusing them, never splitting a character', () => {
    ensure_basic_skill_definitions()
    const long_chinese = `${'我们需要尽快建一个煤蛇'.repeat(60)}`
    expect(() => skill_cards_for_goal(long_chinese, 5)).not.toThrow()
    expect(skill_cards_for_goal(long_chinese, 5)[0].id).toBe('burner-coal-loop')
    expect(() => find_skill_definitions(long_chinese, 3)).not.toThrow()

    // In Lua a string is bytes; simulate that with one char per UTF-8 byte.
    const as_lua_bytes = (value: string) => Buffer.from(value, 'utf8').toString('latin1')
    const from_lua_bytes = (value: string) => Buffer.from(value, 'latin1').toString('utf8')
    expect(from_lua_bytes(utf8_safe_prefix(as_lua_bytes('煤蛇'), 4))).toBe('煤')
    expect(from_lua_bytes(utf8_safe_prefix(as_lua_bytes('煤蛇'), 6))).toBe('煤蛇')
    expect(from_lua_bytes(utf8_safe_prefix(as_lua_bytes('ab煤'), 3))).toBe('ab')
  })

  it('ranks a verified skill above a candidate with the same match', () => {
    const verified_fields = {
      status: 'verified',
      stage: 'verified_skill',
      verification: {
        structural: 'passed', recipe_flow: 'passed', placement_rebuild: 'passed', production_output: 'passed', belt_capacity: 'passed',
        inserter_sustained_throughput: 'unvalidated',
        acceptance_conditions: [{ id: 'rebuild', description: 'Rebuilt layout produced the expected item.', status: 'passed', evidence_refs: ['result:run-7'] }],
      },
    }
    put_skill_definition(candidate({ id: 'belt-line-a', name: 'A Belt Line' }))
    put_skill_definition(candidate({ id: 'belt-line-b', name: 'B Belt Line', ...verified_fields }))
    const offered = skill_cards_for_goal('make transport belts', 5, fresh_world())
    expect(offered.map(card => card.id)).toEqual(['belt-line-b', 'belt-line-a'])
    expect(offered[0].status).toBe('verified')
  })

  it('builds one bounded card: id, name, one-line summary, produces, needs, status and why it matched', () => {
    ensure_basic_skill_definitions()
    const [card] = skill_cards_for_goal('Get steam power running so we have electricity', 1, fresh_world())
    expect(card).toEqual({
      id: 'steam-power-bootstrap',
      name: 'Steam Power Bootstrap',
      status: 'candidate',
      summary: 'Bring up the first reliable electric power with the smallest live-compatible water-to-steam-to-generator chain, then connect the electrical network and fuel ...',
      produces: ['electric-power'],
      needs: [
        { subject: 'offshore-pump', state: 'locked', technology: 'steam-power' },
        { subject: 'boiler', state: 'locked', technology: 'steam-power' },
        { subject: 'generator', state: 'locked', technology: 'steam-power', via: 'steam-engine' },
        { subject: 'fuel-or-energy-input', state: 'unknown' },
      ],
      matched: ['power', 'electricity', 'steam', 'steam-power', 'text:running'],
      score: 16.25,
    })
    expect(JSON.stringify(card).length).toBeLessThan(900)
    expect(skill_cards_for_goal('coal', 5).length).toBeLessThanOrEqual(5)
    expect(() => skill_cards_for_goal('coal', 6)).toThrow(/at most 5/)
    expect(skill_cards_for_goal('zzzz unrelated words', 5)).toEqual([])
  })

  it('offers the scale-out pattern for rate, deadline and scale-out goals, and the smelting cells point to it (plan 2.1)', () => {
    ensure_basic_skill_definitions()
    for (const goal of ['Produce 60 iron plates per minute', 'Scale out iron smelting to more furnaces', 'Make 400 copper plates faster, before the deadline']) {
      expect(skill_cards_for_goal(goal, 5, fresh_world()).slice(0, 3).map(card => card.id), goal).toContain('scale-out-production-line')
    }
    // It does not crowd out the eval goals' own skills.
    expect(skill_cards_for_goal('Build a smelting row for iron plates', 5, fresh_world())[0].id).toBe('starter-smelting-row')

    const scale = get_skill_definition('scale-out-production-line')!
    expect(scale.stage).toBe('pattern')
    expect(scale.status).toBe('candidate')
    const guidance = JSON.stringify(scale)
    for (const tool of ['getRecipeDetails', 'getMiningDetails', 'estimateProductionTime', 'getPlacementCandidates', 'covers_position', 'getTransportCapacity']) expect(guidance).toContain(tool)
    for (const id of ['direct-miner-smelting', 'starter-smelting-row']) {
      expect(JSON.stringify(get_skill_definition(id)!.examples)).toContain('scale-out-production-line')
    }
  })

  it('never offers a deprecated skill', () => {
    put_skill_definition(candidate({ id: 'old-belt-line', name: 'Old Belt Line', status: 'deprecated', stage: 'pattern' }))
    expect(skill_cards_for_goal('transport belt', 5).map(card => card.id)).not.toContain('old-belt-line')
  })

  it('upgrades an unedited curated copy to a newer curated revision and keeps edited or learned copies', () => {
    ensure_basic_skill_definitions()
    const registry = (globalThis as any).storage.sgluna_skill_definitions
    registry['steam-power-bootstrap'] = { ...registry['steam-power-bootstrap'], revision: 1, goal_tags: undefined }
    const edited = edited_skill_revision({ ...registry['burner-coal-loop'], revision: 0 }, { name: 'House Coal Loop', summary: 'Ours.', status: 'candidate' }, 'owner', 906)
    expect(edited.revision).toBe(1)
    expect(ensure_basic_skill_definitions()).toEqual({ added: 0, upgraded: 1, removed: 0, total: 11 })
    expect(get_skill_definition('steam-power-bootstrap')?.goal_tags).toContain('power')
    expect(get_skill_definition('burner-coal-loop')?.name).toBe('House Coal Loop')
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

    expect(ensure_basic_skill_definitions()).toEqual({ added: 11, upgraded: 0, removed: 0, total: 11 })
    expect(list_skill_definitions()).toHaveLength(MAX_DYNAMIC_SKILL_DEFINITIONS + 11)
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
    expect(handle_skill_export_click(player, 'sgluna_skill_export__automated-transport-belt-line')).toBe(true)
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
