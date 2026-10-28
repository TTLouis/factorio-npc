import type { ControlledActor } from './actors/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entity_reference_hint, remember_entity_reference } from './entity_reference'
import { entity_geometry_for_actor, logistics_topology_for_actor } from './knowledge'
import { inspect_charted_entity } from './map_remote'
import { throughput_capacity } from './throughput_capacity'
import { new_throughput_measurement_controller } from './throughput_measurement'

// M3 for fresh model-facing reads: facts about a model-named entity (status, inventories, I/O geometry, topology, inserter
// capacity, a measurement start, a remote inspection) cover only chunks the NPC sees now. An entity in a chunk it does not see
// is refused whether it still stands or was destroyed, nothing is scanned there and its observation hint is not refreshed.
// Pre-change (41a77583) all six resolve through resolve_exact_entity / resolve_entity_reference: a standing entity is read,
// a destroyed one is "not found", and the hint is refreshed.

const actor_state: { actor: unknown } = { actor: undefined }

vi.mock('./actors/actor_controller', () => ({
  create_actor_remote_interface: () => {},
  get_controlled_actor: () => actor_state.actor,
}))

vi.mock('./spatial_semantics', () => ({
  compact_spatial_summary: () => undefined,
}))

const G: any = globalThis

const UNIT = 301
const NEAR = { x: 10.5, y: 10.5 }

// The NPC stands in chunk (chunk_x, chunk_y) and sees the 5x5 chunks around it. extra_explored are fogged but charted.
function set_window(chunk_x: number, chunk_y: number, extra_explored: Array<{ x: number, y: number }> = []) {
  const explored: Record<string, any> = {}
  for (let x = chunk_x - 2; x <= chunk_x + 2; x++) {
    for (let y = chunk_y - 2; y <= chunk_y + 2; y++) explored[`1:${x}:${y}`] = { surface_index: 1, x, y }
  }
  for (const chunk of extra_explored) explored[`1:${chunk.x}:${chunk.y}`] = { surface_index: 1, x: chunk.x, y: chunk.y }
  G.storage.sgluna_map_knowledge = { force_index: 1, explored, visible_surface_index: 1, visible_chunk_x: chunk_x, visible_chunk_y: chunk_y, push_queue: [] }
}

const move_away = () => set_window(10, 10, [{ x: 0, y: 0 }])
const move_back = () => set_window(0, 0)

type Kind = 'furnace' | 'inserter'

interface Entry {
  name: string
  kind: Kind
  call: (world: World) => any
  refused: (result: any) => boolean
  ok: (result: any) => boolean
  not_found: (result: any) => boolean
}

interface World {
  actor: ControlledActor
  find: ReturnType<typeof vi.fn>
  lookup: Record<number, any>
  state: { standing: boolean, entity: any }
  tools: Record<string, (...args: any[]) => any>
  measurements: ReturnType<typeof new_throughput_measurement_controller>
}

function make_entity(world: { surface: any, force: any }, kind: Kind, unit_number: number, at: { x: number, y: number }) {
  const base = {
    valid: true,
    unit_number,
    position: { ...at },
    direction: 0,
    surface: world.surface,
    force: world.force,
    bounding_box: { left_top: { x: at.x - 1, y: at.y - 1 }, right_bottom: { x: at.x + 1, y: at.y + 1 } },
  }
  if (kind === 'inserter') {
    return {
      ...base,
      name: 'fast-inserter',
      type: 'inserter',
      active: true,
      held_stack: { valid_for_read: false, count: 0 },
      inserter_stack_size_override: 0,
      inserter_target_pickup_count: 4,
      pickup_from_left_lane: true,
      pickup_from_right_lane: true,
      pickup_position: { x: at.x, y: at.y - 1 },
      drop_position: { x: at.x, y: at.y + 1 },
      pickup_target: undefined,
      drop_target: undefined,
    }
  }
  return {
    ...base,
    name: 'stone-furnace',
    type: 'furnace',
    status: 1,
    fluids_count: 0,
    fluidbox: { length: 0 },
    get_max_inventory_index: () => 1,
    get_inventory: () => ({ get_contents: () => [{ name: 'iron-plate', count: 5, quality: 'normal' }] }),
    get_recipe: () => [{ name: 'iron-plate' }, undefined],
  }
}

const ENTRIES: Entry[] = [
  {
    name: 'get_entity_status (exact)',
    kind: 'furnace',
    call: world => world.tools.get_entity_status(undefined, undefined, UNIT),
    refused: result => result.found === false && result.error === 'entity_not_visible',
    ok: result => result.found === true && result.entity.unit_number === UNIT,
    not_found: result => result.found === false && result.error === 'exact_entity_not_found',
  },
  {
    name: 'entity_geometry_for_actor',
    kind: 'furnace',
    call: world => entity_geometry_for_actor(world.actor, UNIT),
    refused: result => result.found === false && result.code === 'entity_not_visible',
    ok: result => result.found === true && result.entity.unit_number === UNIT,
    not_found: result => result.found === false && result.error === 'entity not found',
  },
  {
    name: 'logistics_topology_for_actor',
    kind: 'furnace',
    call: world => logistics_topology_for_actor(world.actor, UNIT, 8),
    refused: result => result.found === false && result.code === 'entity_not_visible',
    ok: result => result.found === true && result.center.unit_number === UNIT,
    not_found: result => result.found === false && result.error === 'entity not found',
  },
  {
    name: 'throughput_capacity (inserter_instance)',
    kind: 'inserter',
    call: world => throughput_capacity(world.actor, { kind: 'inserter_instance', unit_number: UNIT }),
    refused: result => result.ok === false && result.error.message.startsWith('entity_not_visible'),
    ok: result => result.ok === true && result.unit_number === UNIT,
    not_found: result => result.ok === false && result.error.message === `entity not found: ${UNIT}`,
  },
  {
    name: 'throughput measurement start',
    kind: 'inserter',
    call: world => world.measurements.start({ kind: 'inserter_instance', unit_number: UNIT }),
    refused: result => result.ok === false && result.error.code === 'ENTITY_NOT_VISIBLE',
    ok: result => result.ok === true && result.unit_number === UNIT,
    not_found: result => result.ok === false && result.error.message === `entity not found: ${UNIT}`,
  },
  {
    name: 'inspect_charted_entity (map remote)',
    kind: 'furnace',
    call: world => inspect_charted_entity(world.actor, UNIT),
    refused: result => result.ok === false && result.code === 'area_not_visible',
    ok: result => result.ok === true && result.entity.unit_number === UNIT,
    not_found: result => result.ok === false && result.code === 'entity_not_found',
  },
]

async function build_tools() {
  const interfaces: Record<string, Record<string, (...args: any[]) => any>> = {}
  G.remote.add_interface = (name: string, functions: Record<string, (...args: any[]) => any>) => {
    interfaces[name] = functions
  }
  const { create_tools_remote_interface } = await import('./tools')
  create_tools_remote_interface()
  return interfaces.autorio_tools
}

describe('fresh reads of a model-named entity cover only what the NPC sees now (M3)', () => {
  const original = {
    pairs: G.pairs,
    storage: G.storage,
    lookup: G.game.get_entity_by_unit_number,
    get_surface: G.game.get_surface,
    tick: G.game.tick,
    entity_status: G.defines.entity_status,
    prototypes: G.prototypes,
  }

  let force: any
  let surface: any
  let state: World['state']
  let find: ReturnType<typeof vi.fn>
  let lookup: Record<number, any>
  let actor: ControlledActor
  let tools: World['tools']

  beforeEach(async () => {
    G.pairs = Object.entries
    G.storage = {}
    G.game.tick = 500
    G.defines.entity_status = { working: 1 }
    G.prototypes = {
      item: { 'iron-plate': { stack_size: 100 } },
      entity: { 'fast-inserter': { name: 'fast-inserter', type: 'inserter', bulk: false } },
    }
    lookup = {}
    G.game.get_entity_by_unit_number = (unit: number) => lookup[unit]
    state = { standing: true, entity: undefined }
    // Ordinary buildings are not indexed by unit number: they resolve through the observation hint and a scan at its position.
    find = vi.fn((filter: any) => filter?.type === 'inserter' ? [] : state.standing ? [state.entity] : [])
    force = { index: 1, name: 'player', is_chunk_visible: () => false, is_chunk_charted: () => false }
    surface = { index: 1, name: 'nauvis', valid: true, find_entities_filtered: find }
    G.game.get_surface = (index: number) => index === 1 ? surface : undefined
    actor = {
      is_valid: true,
      position: { x: 0, y: 0 },
      force,
      surface,
      status_snapshot: () => ({ actor_id: 9, kind: 'standalone_character' }),
    } as unknown as ControlledActor
    actor_state.actor = actor
    tools = await build_tools()
    set_window(0, 0)
  })

  afterEach(() => {
    G.pairs = original.pairs
    G.storage = original.storage
    G.game.get_entity_by_unit_number = original.lookup
    G.game.get_surface = original.get_surface
    G.game.tick = original.tick
    G.defines.entity_status = original.entity_status
    G.prototypes = original.prototypes
    actor_state.actor = undefined
  })

  function world(): World {
    return { actor, find, lookup, state, tools, measurements: new_throughput_measurement_controller(() => actor) }
  }

  // The NPC observed the entity at tick 500, then walked away and the clock moved on.
  function observed(kind: Kind) {
    const entity = make_entity({ surface, force }, kind, UNIT, NEAR)
    state.entity = entity
    remember_entity_reference(entity as any)
    move_away()
    G.game.tick = 900
    return entity
  }

  describe.each(ENTRIES)('$name', (entry) => {
    it('is refused once the NPC walked away, nothing is scanned and the observation is not refreshed', () => {
      observed(entry.kind)
      const result = entry.call(world())
      expect(entry.refused(result)).toBe(true)
      expect(find).not.toHaveBeenCalled()
      expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 500, position: NEAR })
    })

    it('answers the same whether the entity still stands in the fog or was destroyed', () => {
      observed(entry.kind)
      const standing = entry.call(world())
      state.standing = false
      const destroyed = entry.call(world())
      expect(entry.refused(standing)).toBe(true)
      expect(destroyed).toEqual(standing)
      expect(find).not.toHaveBeenCalled()
      expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 500 })
    })

    it('reads a standing entity once it is seen again, and a destroyed one is not found', () => {
      observed(entry.kind)
      move_back()
      expect(entry.ok(entry.call(world()))).toBe(true)
      state.standing = false
      const gone = entry.call(world())
      expect(entry.refused(gone)).toBe(false)
      expect(entry.not_found(gone)).toBe(true)
    })
  })

  it('a remote inspection of a fogged entity in an uncharted chunk is area_uncharted, standing or destroyed', () => {
    const entity = make_entity({ surface, force }, 'furnace', UNIT, NEAR)
    state.entity = entity
    remember_entity_reference(entity as any)
    // Chunk (0, 0) is neither visible nor charted once the window is far away.
    set_window(10, 10)
    G.game.tick = 900
    const standing = inspect_charted_entity(actor, UNIT)
    state.standing = false
    const destroyed = inspect_charted_entity(actor, UNIT)
    expect(standing).toEqual({ ok: false, code: 'area_uncharted', unit_number: UNIT })
    expect(destroyed).toEqual(standing)
    expect(find).not.toHaveBeenCalled()
    expect(entity_reference_hint(UNIT)).toMatchObject({ observed_tick: 500 })
  })

  describe('logistics topology scan area', () => {
    // Window (0, 0) sees tiles -64..95. The furnace at x = 90.5 is seen (box 89.5..91.5, chunk 2); a 12 tile reach goes to
    // 103.5 (chunk 3), which is not seen. The engine indexes it directly here so that only the neighbour scan could run.
    function at(x: number) {
      const entity = make_entity({ surface, force }, 'furnace', UNIT, { x, y: 10.5 })
      lookup[UNIT] = entity
      state.entity = entity
      return entity
    }

    it('refuses a seen centre whose scan area reaches an unseen chunk, before any scan', () => {
      at(90.5)
      expect(entity_geometry_for_actor(actor, UNIT)).toMatchObject({ found: true })
      const result: any = logistics_topology_for_actor(actor, UNIT, 8)
      expect(result).toMatchObject({ found: false, unit_number: UNIT, radius: 8, code: 'area_not_visible' })
      expect(result.error).toContain('does not see now')
      // The reach is at least 12 tiles even for a 1 tile radius (pipe-to-ground neighbours are read up to 10 tiles away).
      expect(logistics_topology_for_actor(actor, UNIT, 1)).toMatchObject({ found: false, code: 'area_not_visible' })
      expect(find).not.toHaveBeenCalled()
    })

    it('scans once the whole area is seen', () => {
      at(40.5)
      expect(logistics_topology_for_actor(actor, UNIT, 8)).toMatchObject({ found: true, center: { unit_number: UNIT } })
      expect(find).toHaveBeenCalledWith(expect.objectContaining({ type: 'inserter', radius: 8 }))
    })
  })
})
