import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fluid_source_observation } from './fluid_source_observation'
import { create_placement_candidate_set, execute_placement_candidate, placement_candidate_preflight, placement_candidates_for_actor, freeze_fluid_preservation_candidate, placement_candidate_matches, placement_preservation_execution_allowed, placement_preservation_queue_binding } from './placement_candidates'
import { new_basic_operation_controller } from './basic_operations'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_task_manager } from './task_manager'
import { new_operation_admission } from './operation_admission'
import { placement_footprint, snap_placement_center } from './placement_geometry'

// Geometry fixtures still establish the native water-read prerequisite.
function observe_water(actor: any) {
  actor.is_valid = true
  actor.status_snapshot = () => ({ actor_id: 18 })
  actor.surface.is_chunk_generated = () => true
  actor.surface.find_tiles_filtered = (args: any) => args.has_hidden_tile ? [] : [{ name: 'water', position: { x: 0, y: 0 }, prototype: { fluid: { name: 'water' } }, surface: { index: actor.surface.index } }]
  ;(globalThis as any).prototypes.fluid = { water: {} }
  ;(globalThis as any).prototypes.tile = { water: { fluid: { name: 'water' } } }
  fluid_source_observation(actor, { fluid_name: 'water' })
  return actor
}

// Prototype shapes follow Factorio 2.0: fluidbox_prototypes[].pipe_connections[]
// carry a base `direction` and four cardinal-relative `positions` (north, east,
// south, west). A connection with base direction d on an entity turned by r faces
// (d + r) % 16 and sits at the offset turned by r.

function turn(offset: { x: number, y: number }, quarter_turns: number) {
  const { x, y } = offset
  const turned = quarter_turns === 0 ? { x, y }
    : quarter_turns === 1 ? { x: -y, y: x }
      : quarter_turns === 2 ? { x: -x, y: -y }
        : { x: y, y: -x }
  return { x: turned.x + 0, y: turned.y + 0 }
}

function connection(direction: number, offset: { x: number, y: number }, flow_direction: string) {
  return {
    connection_type: 'normal',
    flow_direction,
    direction,
    positions: [0, 1, 2, 3].map(quarter => turn(offset, quarter)),
  }
}

// 3x2 boiler facing north: water ports at both ends of the south row, steam in the middle of the north row.
const boiler = {
  name: 'boiler',
  type: 'boiler',
  tile_width: 3,
  tile_height: 2,
  fluidbox_prototypes: [
    { index: 1, volume: 200, production_type: 'input-output', filter: { name: 'water' }, pipe_connections: [
      connection(12, { x: -1, y: 0.5 }, 'input-output'),
      connection(4, { x: 1, y: 0.5 }, 'input-output'),
    ] },
    { index: 2, volume: 200, production_type: 'output', filter: { name: 'steam' }, pipe_connections: [
      connection(0, { x: 0, y: -0.5 }, 'output'),
    ] },
  ],
}

// 3x5 steam engine facing north: one steam port at each end of the long axis.
const steam_engine = {
  name: 'steam-engine',
  type: 'generator',
  tile_width: 3,
  tile_height: 5,
  fluidbox_prototypes: [
    { index: 1, volume: 200, production_type: 'input-output', filter: { name: 'steam' }, pipe_connections: [
      connection(0, { x: 0, y: -2 }, 'input-output'),
      connection(8, { x: 0, y: 2 }, 'input-output'),
    ] },
  ],
}

// 1x1 offshore pump: its output port sits on its own tile; direction 8 is the base facing.
const offshore_pump = {
  name: 'offshore-pump',
  type: 'offshore-pump',
  tile_width: 1,
  tile_height: 1,
  fluidbox_prototypes: [
    { index: 1, volume: 100, production_type: 'output', filter: { name: 'water' }, pipe_connections: [
      connection(8, { x: 0, y: 0 }, 'output'),
    ] },
  ],
}

interface LivePort { position: { x: number, y: number }, target_position: { x: number, y: number }, flow_direction: string, connected?: boolean }

function live_entity(unit_number: number, name: string, storages: Array<{ filter: string, ports: LivePort[] }>) {
  return {
    valid: true,
    unit_number,
    name,
    position: { x: 0, y: 0 },
    bounding_box: { left_top: { x: -1, y: -1 }, right_bottom: { x: 1, y: 1 } },
    surface: { index: 1 },
    force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
    fluidbox: {
      length: storages.length,
      get_pipe_connections: (index: number) => storages[index - 1].ports.map(port => ({
        connection_type: 'normal',
        flow_direction: port.flow_direction,
        position: port.position,
        target_position: port.target_position,
        target: port.connected ? { owner: {} } : undefined,
      })),
      get_prototype: (index: number) => ({ index, production_type: 'input-output', filter: { name: storages[index - 1].filter } }),
    },
  }
}

describe('placement candidates that join a live fluid port', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes.entity
  const originalGame = { get_entity_by_unit_number: (globalThis as any).game.get_entity_by_unit_number, tick: (globalThis as any).game.tick }
  let world: Record<number, any>
  let place_calls: any[]

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes.entity = { boiler, 'steam-engine': steam_engine, 'offshore-pump': offshore_pump }
    ;(globalThis as any).storage = {}
    ;(globalThis as any).game.tick = 500
    world = {}
    place_calls = []
    ;(globalThis as any).game.get_entity_by_unit_number = (unit_number: number) => world[unit_number]
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalPrototypes
    ;(globalThis as any).game.get_entity_by_unit_number = originalGame.get_entity_by_unit_number
    ;(globalThis as any).game.tick = originalGame.tick
  })

  function actor_at(x: number, y: number) {
    return observe_water({
      position: { x, y },
      force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      surface: {
        index: 1,
        can_place_entity: (args: any) => { place_calls.push(args); return true },
        find_entities_filtered: () => [],
      },
    } as any)
  }

  // A pump already built with its output port on (8.5, 20.5) opening east onto (9.5, 20.5).
  function build_pump() {
    world[100] = live_entity(100, 'offshore-pump', [{ filter: 'water', ports: [
      { position: { x: 8.5, y: 20.5 }, target_position: { x: 9.5, y: 20.5 }, flow_direction: 'output' },
    ] }])
  }

  it('certifies the exact native candidate join only while every nearby possible connection is proved', () => {
    build_pump()
    ;(globalThis as any).prototypes.item['fluid-proof-test-kit'] = {}
    ;(globalThis as any).prototypes.entity.boiler = { ...boiler, items_to_place_this: [{ name: 'fluid-proof-test-kit', count: 1 }] }
    const actor = actor_at(0, 0)
    actor.is_valid = true
    actor.status_snapshot = () => ({ actor_id: 18 })
    actor.get_main_inventory = () => ({ get_item_count: () => 1 })
    actor.surface.find_entities_filtered = () => Object.values(world)
    const set: any = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } })
    const read = () => placement_candidate_preflight(actor, set.candidate_set_id, 'candidate-1') as any
    try {
      expect(read()).toMatchObject({ ok: true, preservation_join: { version: 2, complete: true,
        candidate_storages: [{ index: 1, production_type: 'input-output', filter: 'water' }, { index: 2, production_type: 'output', filter: 'steam' }],
        actor_id: 18, surface_index: 1, force_index: 1, entity_name: 'boiler',
        connects_to: { unit_number: 100, target_port: { storage_index: 1, connection_index: 1 } } } })
      // The other boiler water port must not silently join an existing object.
      world[101] = live_entity(101, 'pipe', [{ filter: 'water', ports: [
        { position: { x: 12.5, y: 20.5 }, target_position: { x: 11.5, y: 20.5 }, flow_direction: 'input-output' },
      ] }])
      expect(read().preservation_join).toMatchObject({ complete: false, reason: 'additional_or_changed_connection' })
      delete world[101]
      actor.surface.find_entities_filtered = () => Array.from({ length: 65 }, () => world[100])
      expect(read().preservation_join).toMatchObject({ complete: false, reason: 'neighbour_scan_truncated' })
      actor.surface.find_entities_filtered = () => Object.values(world)
      const original = world[100].fluidbox.get_pipe_connections
      world[100].fluidbox.get_pipe_connections = () => Array.from({ length: 9 }, () => original(1)[0])
      expect(read().preservation_join).toMatchObject({ complete: false, reason: 'neighbour_ports_incomplete' })
    } finally { delete (globalThis as any).prototypes.item['fluid-proof-test-kit'] }
  })

  it('permits a virgin empty claim registry but refuses initialized missing history at queue and create', () => {
    const actor = actor_at(10, 20)
    expect(placement_preservation_queue_binding(actor, 'boiler', 10, 20, 0)).toEqual({ required: false })
    expect(placement_preservation_execution_allowed(actor, 'boiler', 10, 20, 0, undefined, undefined, {})).toBe(true)
    expect(placement_preservation_execution_allowed(actor, 'boiler', 10, 20, 0, undefined, {} as any, {})).toBe(false)
    ;(globalThis as any).storage.sgluna_fluid_preservation_claims_initialized = true
    expect(placement_preservation_queue_binding(actor, 'boiler', 10, 20, 0)).toEqual({ required: true })
    expect(placement_preservation_execution_allowed(actor, 'boiler', 10, 20, 0, undefined, undefined, {})).toBe(false)
  })

  it('distinguishes supported anchor-only missing relation from unknown/unsupported native fluid facts', () => {
    build_pump()
    ;(globalThis as any).prototypes.item['fluid-proof-test-kit'] = {}
    ;(globalThis as any).prototypes.entity.boiler = { ...boiler, fluidbox_prototypes: boiler.fluidbox_prototypes.map(row => ({ ...row })),
      items_to_place_this: [{ name: 'fluid-proof-test-kit', count: 1 }] }
    const actor = actor_at(0, 0)
    actor.is_valid = true; actor.status_snapshot = () => ({ actor_id: 18 })
    actor.get_main_inventory = () => ({ get_item_count: () => 1 })
    actor.surface.find_entities_filtered = () => Object.values(world)
    try {
      const set: any = create_placement_candidate_set(actor, { entity_name: 'boiler', anchor: { unit_number: 100 }, limit: 1 })
      const read = () => placement_candidate_preflight(actor, set.candidate_set_id, set.candidates[0].id) as any
      expect(read()).toMatchObject({ ok: true, preservation_clears_count: 0, preservation_eligibility: {
        version: 1, kind: 'relation_required', actor_id: 18, entity_name: 'boiler', candidate_set_id: set.candidate_set_id,
        candidate_id: set.candidates[0].id, fluid_port_count: 3 } })
      expect(read().preservation_join).toBeUndefined()
      ;(globalThis as any).prototypes.entity.boiler.fluidbox_prototypes[0].volume = undefined
      expect(read().preservation_eligibility).toBeUndefined()
    } finally { delete (globalThis as any).prototypes.item['fluid-proof-test-kit'] }
  })

  it('carries a nonrenewable native guard through the real queued boiler task and refuses a late second neighbour before mutation', () => {
    build_pump()
    Object.assign(world[100], { type: 'offshore-pump', direction: 0, fluids_count: 1, get_fluid: () => undefined })
    world[100].fluidbox.get_capacity = () => 100
    const heldPrototype = world[100].fluidbox.get_prototype
    world[100].fluidbox.get_prototype = (index: number) => ({ ...heldPrototype(index), volume: 100 })
    ;(globalThis as any).prototypes.item['fluid-proof-test-kit'] = {}
    ;(globalThis as any).prototypes.entity.boiler = { ...boiler, collision_box: { left_top: { x: -1.29, y: -0.79 }, right_bottom: { x: 1.29, y: 0.79 } },
      items_to_place_this: [{ name: 'fluid-proof-test-kit', count: 1 }] }
    const actor = actor_at(10, 20)
    actor.character = { valid: true }
    actor.status_snapshot = () => ({ actor_id: 18, kind: 'standalone_character' })
    const remove = vi.fn(); const create = vi.fn()
    actor.get_main_inventory = () => ({ get_item_count: () => 1, remove })
    actor.surface.create_entity = create
    actor.surface.find_entities_filtered = () => Object.values(world)
    const manager = new_task_manager(() => actor)
    const basic = new_basic_operation_controller(() => actor, manager)
    const runtime = new_basic_operation_runtime(manager, basic)
    const journal = new_operation_admission(() => actor, () => manager.get_status_snapshot())
    const owner = { goal_id: 'goal_native', plan_id: 'goal_native_p1', plan_version: 1, step_id: 'native_step',
      semantic_step_id: 'native_step', actor_id: 18, actor_epoch: 3, session: 'native-session' }
    const context = { signature: 'native-exact-signature', owner }
    const originalRemote = (globalThis as any).remote
    let nativeEpoch = 3; let nativeSession = 'native-session'
    ;(globalThis as any).remote = { interfaces: { sgluna_deployment: { status: true, authorize: true }, autorio_operations: { status: true }, autorio_crafting: { status: true } },
      call: (scope: string, method: string, epoch: number) => scope === 'autorio_operations'
        ? { ...manager.get_status_snapshot(), actor: {}, follow: { active: false } }
        : scope === 'autorio_crafting' ? { task_active: false, native_queue: [] }
          : method === 'authorize' ? epoch === nativeEpoch : ({ allowed: true, actor_id: 18, epoch: nativeEpoch, session: nativeSession }) }
    const set: any = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } })
    const candidate = set.candidates[0]
    try {
      const frozen: any = freeze_fluid_preservation_candidate(actor, set.candidate_set_id, candidate.id, 'req/first', [100], context)
      expect(frozen.ok).toBe(true)
      expect(frozen.preservation_join).toMatchObject({ version: 4, operation_key: 'req/first', owner })
      const firstTick = frozen.preservation_join.tick
      ;(globalThis as any).game.tick++
      expect((freeze_fluid_preservation_candidate(actor, set.candidate_set_id, candidate.id, 'req/first', [100], context) as any).preservation_join.tick).toBe(firstTick)
      expect(freeze_fluid_preservation_candidate(actor, set.candidate_set_id, candidate.id, 'req/other', [100], context)).toMatchObject({ ok: false, code: 'preservation_guard_already_claimed' })
      expect(basic.submit_placement('boiler', candidate.position.x, candidate.position.y, candidate.direction)).toBe(false)
      expect(execute_placement_candidate(actor, set.candidate_set_id, candidate.id, basic.submit_placement)[0]).toBe(false, 'a frozen witness is not an active admission caller')
      expect(journal.begin({ operation_key: 'req/first', attempt_id: 'attempt', signature: context.signature, actor_id: 18, epoch: 3,
        ordinal: 1, operation_count: 1, fluid_preservation: owner }).ok).toBe(true)
      expect(execute_placement_candidate(actor, set.candidate_set_id, candidate.id, basic.submit_placement)[0]).toBe(true)
      expect(manager.player_state.parameters_place_entity?.placement_candidate).toEqual({ candidate_set_id: set.candidate_set_id, candidate_id: candidate.id })
      const batch = manager.get_status_snapshot().active_batch!
      expect(journal.slot('req/first', 1, { ok: true, operation: 'place_candidate', batch_refs: [batch] }).ok).toBe(true)
      expect(journal.finish('req/first', { ok: true }).ok).toBe(true)
      const queued = JSON.stringify((globalThis as any).storage)
      const task = manager.player_state.parameters_place_entity!
      expect(placement_preservation_execution_allowed(actor, task.entity_name, task.position?.x, task.position?.y, task.direction,
        task.placement_candidate, task.preservation_binding, manager.get_status_snapshot())).toBe(true)
      const tiny = { name: 'tiny-box', type: 'container', tile_width: 1, tile_height: 1,
        collision_box: { left_top: { x: -0.05, y: -0.05 }, right_bottom: { x: 0.05, y: 0.05 } },
        items_to_place_this: [{ name: 'fluid-proof-test-kit', count: 1 }] }
      ;(globalThis as any).prototypes.entity['tiny-box'] = tiny
      const offGrid = { x: candidate.position.x + 1.45, y: candidate.position.y + 0.5 }
      const heldBox = placement_footprint((globalThis as any).prototypes.entity.boiler, candidate.position, candidate.direction).world_box
      const rawBox = placement_footprint(tiny, offGrid, 0).world_box
      const snappedBox = placement_footprint(tiny, snap_placement_center(tiny, offGrid, 0), 0).world_box
      expect(rawBox.left_top.x).toBeGreaterThan(heldBox.right_bottom.x)
      expect(snappedBox.left_top.x).toBeLessThan(heldBox.right_bottom.x)
      expect(basic.submit_placement('tiny-box', offGrid.x, offGrid.y, 0)).toBe(false)
      // Inject the same legacy/raw queued task to exercise pre-clear residual
      // detection. A late blocker would require clearing at the snapped tile.
      ;(globalThis as any).storage = JSON.parse(queued)
      const rawTask = manager.player_state.parameters_place_entity!
      rawTask.entity_name = 'tiny-box'; rawTask.position = offGrid; rawTask.direction = 0
      rawTask.placement_candidate = undefined; rawTask.preservation_binding = undefined
      const query = vi.fn(() => [])
      actor.surface.find_entities_filtered = query
      actor.surface.can_place_entity = () => false
      runtime.state_placing(actor)
      expect(basic.status().last_result).toMatchObject({ code: 'placement_candidate_unavailable', completed: false })
      expect(query).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
      actor.surface.find_entities_filtered = () => Object.values(world)
      actor.surface.can_place_entity = () => true
      for (const fault of ['epoch', 'session', 'goal', 'semantic_step', 'signature', 'operation', 'generation', 'proof_omission', 'binding_omission', 'missing_journal', 'registry_whole_loss', 'registry_inventory_loss', 'registry_count_loss']) {
        ;(globalThis as any).storage = JSON.parse(queued)
        nativeEpoch = 3; nativeSession = 'native-session'
        const held = manager.player_state.parameters_place_entity!
        if (fault === 'epoch') nativeEpoch++
        if (fault === 'session') nativeSession = 'new-session'
        if (fault === 'goal') held.preservation_binding!.owner.goal_id = 'copied-goal'
        if (fault === 'semantic_step') held.preservation_binding!.owner.semantic_step_id = 'copied-step'
        if (fault === 'signature') held.preservation_binding!.signature = 'wrong'
        if (fault === 'operation') held.preservation_binding!.operation_key = 'wrong'
        if (fault === 'generation') held.preservation_binding!.batch_generation++
        if (fault === 'proof_omission') held.placement_candidate = undefined
        if (fault === 'binding_omission') held.preservation_binding = undefined
        if (fault === 'missing_journal') (globalThis as any).storage.sgluna_operation_admissions = []
        if (fault === 'registry_whole_loss') (globalThis as any).storage.sgluna_fluid_preservation_claims = {}
        if (fault === 'registry_inventory_loss') delete (globalThis as any).storage.sgluna_fluid_preservation_claim_inventory
        if (fault === 'registry_count_loss') delete (globalThis as any).storage.sgluna_fluid_preservation_claim_count
        runtime.state_placing(actor)
        expect(basic.status().last_result, fault).toMatchObject({ code: 'placement_candidate_unavailable', completed: false })
        expect(create, fault).not.toHaveBeenCalled(); expect(remove, fault).not.toHaveBeenCalled()
      }
      nativeEpoch = 3; nativeSession = 'native-session'
      // Native persisted candidate registry can be restored without weakening its claim.
      ;(globalThis as any).storage = JSON.parse(queued)
      world[101] = live_entity(101, 'pipe', [{ filter: 'water', ports: [
        { position: { x: 12.5, y: 20.5 }, target_position: { x: 11.5, y: 20.5 }, flow_direction: 'input-output' },
      ] }])
      runtime.state_placing(actor)
      expect(basic.status().last_result).toMatchObject({ code: 'placement_candidate_unavailable', completed: false })
      expect(create).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
      expect(placement_candidate_matches(actor, { candidate_set_id: set.candidate_set_id, candidate_id: candidate.id }, 'boiler', candidate.position.x, candidate.position.y, candidate.direction)).toBe(false)
      delete world[101]
      // A second disjoint genuine claim makes partial loss distinguishable
      // from the already-covered entirely-empty registry case.
      world[102] = live_entity(102, 'offshore-pump', [{ filter: 'water', ports: [
        { position: { x: 48.5, y: 20.5 }, target_position: { x: 49.5, y: 20.5 }, flow_direction: 'output' },
      ] }])
      Object.assign(world[102], { type: 'offshore-pump', direction: 0, position: { x: 48.5, y: 20.5 }, fluids_count: 1, get_fluid: () => undefined })
      world[102].fluidbox.get_capacity = () => 100
      world[102].fluidbox.get_prototype = () => ({ index: 1, volume: 100, production_type: 'output', filter: { name: 'water' } })
      const second: any = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 102 } })
      expect(freeze_fluid_preservation_candidate(actor, second.candidate_set_id, second.candidates[0].id, 'req/second', [102], context)).toMatchObject({ ok: true })
      expect(Object.keys((globalThis as any).storage.sgluna_fluid_preservation_claims)).toHaveLength(2)
      delete (globalThis as any).storage.sgluna_fluid_preservation_claims['req/first']
      expect(Object.keys((globalThis as any).storage.sgluna_fluid_preservation_claims)).toHaveLength(1)
      expect(basic.submit_placement('boiler', candidate.position.x, candidate.position.y, candidate.direction)).toBe(false)
      expect(create).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled()
    } finally { delete (globalThis as any).prototypes.item['fluid-proof-test-kit']; (globalThis as any).remote = originalRemote }
  })

  it('reports fresh bounded rejected-join witnesses then admits a newly cleared layout using native checks', () => {
    build_pump()
    const actor = actor_at(0, 0)
    actor.status_snapshot = () => ({ actor_id: 9 })
    let blocked = true
    actor.surface.can_place_entity = () => !blocked
    actor.surface.get_tile = () => ({ name: 'water', collides_with: (layer: string) => layer === 'water_tile' })
    ;(boiler as any).collision_mask = { layers: { water_tile: true } }
    try {
      const rejected: any = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } })
      expect(rejected.candidates).toEqual([])
      expect(rejected.obstructions).toMatchObject({ source: 'native_placement_checks', actor_id: 9, observed_tick: 500, surface_index: 1, force_index: 1, rejected_count: 2, examined_count: 2 })
      expect(rejected.obstructions.samples[0].terrain_tiles[0].reason).toBe('terrain_collision_mask')
      blocked = false
      ;(globalThis as any).game.tick = 501
      const fresh: any = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } })
      expect(fresh.obstructions).toMatchObject({ observed_tick: 501, rejected_count: 0, samples: [] })
      expect(fresh.candidates).toHaveLength(2)
      const submit = () => true
      blocked = true
      expect(execute_placement_candidate(actor, fresh.candidate_set_id, fresh.candidates[0].id, submit)[0]).toBe(false)
    }
    finally { delete (boiler as any).collision_mask }
  })

  it('returns only boiler footprints whose water port lands on the pump port, each naming the port it joins', () => {
    build_pump()
    const result = placement_candidates_for_actor(actor_at(0, 0), {
      entity_name: 'boiler',
      connects_to: { unit_number: 100 },
    }) as any

    expect(result.ok).toBe(true)
    expect(result.connects_to).toMatchObject({ unit_number: 100, entity_name: 'offshore-pump' })
    expect(result.connects_to.target_ports).toEqual([
      { storage_index: 1, connection_index: 1, tile: { x: 9.5, y: 20.5 }, own_tile: { x: 8.5, y: 20.5 }, filter: 'water', flow_direction: 'output' },
    ])
    // North-facing (west water port) and south-facing (east water port) boilers. The steam port
    // of a turned boiler can also sit west-facing on the tile, but it is not water and is an output too.
    expect(result.candidates.map((candidate: any) => ({ position: candidate.position, direction: candidate.direction }))).toEqual([
      { position: { x: 10.5, y: 20 }, direction: 0 },
      { position: { x: 10.5, y: 21 }, direction: 8 },
    ])
    expect(result.candidates[0].connects_to).toEqual({
      unit_number: 100,
      entity_name: 'offshore-pump',
      target_port: { storage_index: 1, connection_index: 1 },
      candidate_port: { storage_index: 1, connection_index: 1, direction: 12, filter: 'water', flow_direction: 'input-output' },
      tile: { x: 9.5, y: 20.5 },
    })
    expect(result.candidates[1].connects_to.candidate_port).toMatchObject({ storage_index: 1, connection_index: 2, direction: 12 })
    for (const candidate of result.candidates) {
      const joined = candidate.fluid_ports.find((port: any) => port.storage_index === candidate.connects_to.candidate_port.storage_index && port.connection_index === candidate.connects_to.candidate_port.connection_index)
      expect(joined.position).toEqual({ x: 9.5, y: 20.5 })
    }
    // Candidates were solved from the prototype pipe connections, not scanned for.
    expect(result.scanned).toBeLessThan(40)
    expect(place_calls.every(call => call.name === 'boiler')).toBe(true)
  })

  it('finds the aligned engine far from the actor and collapses a symmetric duplicate orientation', () => {
    // Boiler built at (10.5, 20) facing north: steam port on (10.5, 19.5) opening north onto (10.5, 18.5).
    world[200] = live_entity(200, 'boiler', [
      { filter: 'water', ports: [
        { position: { x: 9.5, y: 20.5 }, target_position: { x: 8.5, y: 20.5 }, flow_direction: 'input-output', connected: true },
        { position: { x: 11.5, y: 20.5 }, target_position: { x: 12.5, y: 20.5 }, flow_direction: 'input-output' },
      ] },
      { filter: 'steam', ports: [
        { position: { x: 10.5, y: 19.5 }, target_position: { x: 10.5, y: 18.5 }, flow_direction: 'output' },
      ] },
    ])

    // No storage given: the open east water port and the steam port are both targets, but only the
    // steam port is compatible with an engine whose pinned fluid is steam.
    const result = placement_candidates_for_actor(actor_at(500, 500), {
      entity_name: 'steam-engine',
      connects_to: { unit_number: 200 },
    }) as any

    expect(result.ok).toBe(true)
    expect(result.connects_to.target_ports.map((port: any) => `${port.storage_index}:${port.connection_index}`)).toEqual(['1:2', '2:1'])
    expect(result.legal_candidate_count).toBe(2)
    expect(result.returned_candidate_count).toBe(1)
    expect(result.candidates[0]).toMatchObject({
      position: { x: 10.5, y: 16.5 },
      direction: 0,
      connects_to: { target_port: { storage_index: 2, connection_index: 1 }, candidate_port: { storage_index: 1, connection_index: 2, direction: 8, filter: 'steam' } },
    })
  })

  it('honours an explicit storage and connection index and refuses unusable targets with a code', () => {
    build_pump()
    const actor = actor_at(0, 0)
    const attempt = (connects_to: any) => placement_candidates_for_actor(actor, { entity_name: 'boiler', connects_to }) as any

    expect(attempt({ unit_number: 100, storage_index: 1, connection_index: 1 }).ok).toBe(true)
    expect(attempt({ unit_number: 100, storage_index: 2 })).toMatchObject({ ok: false, code: 'connects_to_port_not_found', unit_number: 100 })
    expect(attempt({ unit_number: 999 })).toMatchObject({ ok: false, code: 'connects_to_entity_not_found' })
    for (const bad of [{ unit_number: 0 }, { unit_number: 1.5 }, { unit_number: 100, storage_index: 9 }, { unit_number: 100, connection_index: 0 }]) {
      expect(attempt(bad)).toMatchObject({ ok: false, code: 'invalid_connects_to' })
    }
    world[101] = live_entity(101, 'offshore-pump', [{ filter: 'water', ports: [
      { position: { x: 0.5, y: 0.5 }, target_position: { x: 1.5, y: 0.5 }, flow_direction: 'output', connected: true },
    ] }])
    expect(attempt({ unit_number: 101 })).toMatchObject({ ok: false, code: 'connects_to_port_unavailable' })
    // Another surface is not the actor world.
    world[102] = { ...live_entity(102, 'offshore-pump', []), surface: { index: 2 } }
    expect(attempt({ unit_number: 102 })).toMatchObject({ ok: false, code: 'connects_to_entity_not_found' })
  })

  it('places a pump from the boiler port: the pinned fluid and flow direction decide which ports can join', () => {
    // A boiler water port on (9.5, 20.5) opening west onto (8.5, 20.5).
    world[300] = live_entity(300, 'boiler', [{ filter: 'water', ports: [
      { position: { x: 9.5, y: 20.5 }, target_position: { x: 8.5, y: 20.5 }, flow_direction: 'input-output' },
    ] }])
    const actor = actor_at(0, 0)
    const result = placement_candidates_for_actor(actor, { entity_name: 'offshore-pump', connects_to: { unit_number: 300 } }) as any
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ position: { x: 8.5, y: 20.5 }, direction: 12, connects_to: { candidate_port: { direction: 4, filter: 'water', flow_direction: 'output' } } })
    expect(result.ordering).toBe('nearest_to_actor_first')
    expect(place_calls.length).toBeGreaterThan(0)
    expect(place_calls.every(call => call.build_check_type === 'manual')).toBe(true)

    // Two outputs never join: no pump can be placed against a pump output port.
    build_pump()
    const output_against_output = placement_candidates_for_actor(actor, { entity_name: 'offshore-pump', connects_to: { unit_number: 100 } }) as any
    expect(output_against_output.candidates).toEqual([])
    expect(output_against_output.legal_candidate_count).toBe(0)
  })

  it('stores the solved join with the set and refuses to execute it once the target entity is gone', () => {
    build_pump()
    const actor = actor_at(0, 0)
    const set = create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } }) as any
    expect(set.ok).toBe(true)
    const stored = (globalThis as any).storage.sgluna_placement_candidate_sets[set.candidate_set_id]
    expect(stored.candidates[0].connects_to.unit_number).toBe(100)

    const submitted: any[] = []
    const submit = (...args: any[]) => { submitted.push(args); return true }
    expect(execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)).toEqual([true, `placement candidate accepted: ${set.candidate_set_id}/candidate-1`])
    expect(submitted).toEqual([['boiler', 10.5, 20, 0, undefined, [100]]]) // the join target is protected from clearing

    delete world[100]
    expect(execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)).toEqual([false, 'placement candidate connection target is no longer available'])
    expect(submitted).toHaveLength(1)
  })
  it('refuses to execute a stored join once the target port was rotated away or got a pipe', () => {
    const rebuild = (port: Partial<LivePort>) => {
      world[100] = live_entity(100, 'offshore-pump', [{ filter: 'water', ports: [
        { position: { x: 8.5, y: 20.5 }, target_position: { x: 9.5, y: 20.5 }, flow_direction: 'output', ...port },
      ] }])
    }
    const submitted: any[] = []
    const submit = (...args: any[]) => { submitted.push(args); return true }
    const actor = actor_at(0, 0)
    const fresh_set = () => {
      rebuild({})
      return create_placement_candidate_set(actor, { entity_name: 'boiler', connects_to: { unit_number: 100 } }) as any
    }

    // Rotated: the port now opens onto another tile, so the stored footprint no longer meets it.
    let set = fresh_set()
    rebuild({ target_position: { x: 7.5, y: 20.5 } })
    const rotated = execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)
    expect(rotated[0]).toBe(false)
    expect(rotated[1]).toMatch(/^connects_to_port_changed: .*no longer lines up/)
    expect(placement_candidate_preflight(actor, set.candidate_set_id, 'candidate-1')).toMatchObject({ ok: false, code: 'placement_candidate_unavailable', error: expect.stringMatching(/^connects_to_port_changed: /) })

    // A pipe was added: the port is connected to something else now.
    set = fresh_set()
    rebuild({ connected: true })
    const piped = execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)
    expect(piped[0]).toBe(false)
    expect(piped[1]).toMatch(/^connects_to_port_changed: .*already connected/)

    // The port is gone from the listing.
    set = fresh_set()
    world[100] = live_entity(100, 'offshore-pump', [{ filter: 'water', ports: [] }])
    expect(execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)[1]).toMatch(/^connects_to_port_changed: .*no longer exists/)

    // Unchanged: still executes.
    set = fresh_set()
    expect(execute_placement_candidate(actor, set.candidate_set_id, 'candidate-1', submit)[0]).toBe(true)
    expect(submitted).toEqual([['boiler', 10.5, 20, 0, undefined, [100]]]) // the join target is protected from clearing
  })
})

describe('shoreline placement ordering', () => {
  const originalPairs = (globalThis as any).pairs
  const originalPrototypes = (globalThis as any).prototypes.entity

  beforeEach(() => {
    ;(globalThis as any).pairs = Object.entries
    ;(globalThis as any).prototypes.entity = { 'offshore-pump': offshore_pump, boiler, 'plain-box': { name: 'plain-box', type: 'container', tile_width: 1, tile_height: 1 } }
  })

  afterEach(() => {
    ;(globalThis as any).pairs = originalPairs
    ;(globalThis as any).prototypes.entity = originalPrototypes
  })

  it('orders pump candidates by distance from the actor, not from the requested centre, and says so', () => {
    const shore = [5.5, 12.5, 20.5]
    const actor = {
      position: { x: 0.5, y: 0.5 },
      force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      surface: {
        index: 1,
        // Only west-facing spots on the shoreline column are legal, as under the manual build check.
        can_place_entity: ({ position, direction, build_check_type }: any) => build_check_type === 'manual' && direction === 12 && position.y === 0.5 && shore.includes(position.x),
        find_entities_filtered: () => [],
      },
    } as any

    observe_water(actor)
    const result = placement_candidates_for_actor(actor, { entity_name: 'offshore-pump', center: { x: 14.5, y: 0.5 }, radius: 10 }) as any

    expect(result.ordering).toBe('nearest_to_actor_first')
    expect(result.candidates.map((candidate: any) => candidate.position.x)).toEqual([5.5, 12.5, 20.5])
    expect(result.candidates.map((candidate: any) => candidate.distance_from_actor)).toEqual([5, 12, 20])
    // Distance from the requested centre is still reported, and would have ranked 12.5 first.
    expect(result.candidates[1].distance_from_center).toBe(2)
  })

  it('keeps the coverage-then-centre ordering for entities without tile rules and labels it', () => {
    const actor = {
      position: { x: 0.5, y: 0.5 },
      force: { index: 1, is_chunk_charted: () => true, is_chunk_visible: () => true },
      surface: { index: 1, can_place_entity: () => true, find_entities_filtered: () => [] },
    } as any
    const result = placement_candidates_for_actor(actor, { entity_name: 'plain-box', radius: 2, limit: 3 }) as any
    expect(result.ordering).toBe('fewest_clears_then_resource_coverage_then_nearest_to_center')
    expect(result.candidates[0].distance_from_actor).toBeUndefined()
  })
})
