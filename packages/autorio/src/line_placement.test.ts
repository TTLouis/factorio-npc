import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  line_node_failed,
  line_node_precheck,
  line_placement_preflight,
  line_record,
  record_line_node_placed,
  submit_line_placement,
  terminal_line_placement_settlement,
} from './line_placement'

// Geometry and item accounting are the shared placement helpers'; they are stubbed here so these tests pin the line logic:
// strict every-tile preflight, validate-then-queue, first refusal only, the execution-time footprint re-check and the exact
// batch settlement. The engine semantics are proven by the line-placement Factorio lane.
const held = { count: 10 }
vi.mock('./placement_preflight', () => ({
  placement_item_preflight: (_actor: unknown, entity_name: string) => {
    const placement_item = { item_name: entity_name, count: 1, held_count: held.count }
    if (held.count < 1) return { ok: false, code: 'placement_item_missing', placement_item }
    return { ok: true, placement_item, preservation_nonfluid_output: { version: 1, entity_name, fluid_port_count: 0 } }
  },
  planned_placement_footprint: (name: string, x: number, y: number) => {
    const size = name === 'wide-machine' ? 2 : 1
    return {
      position: { x: Math.floor(x) + 0.5, y: Math.floor(y) + 0.5 },
      world_box: { left_top: { x: Math.floor(x), y: Math.floor(y) }, right_bottom: { x: Math.floor(x) + size, y: Math.floor(y) + size } },
    }
  },
}))
vi.mock('./npc_vision', () => ({ find_world_entities: (surface: any, filters: any) => surface.find_entities_filtered(filters) }))
vi.mock('./area_reservations', () => ({ reservation_intersection: () => undefined }))
vi.mock('./entity_reference', () => ({ resolve_recorded_entity: (unit_number: number) => standing.has(unit_number) ? { name: 'transport-belt' } : undefined }))

const standing = new Set<number>()
let ground: { x: number, y: number }[] = []
let solid: { x: number, y: number }[] = []
let water: { x: number, y: number }[] = []
const at = (list: { x: number, y: number }[], box: any) => list.filter(p => p.x > box.left_top.x && p.x < box.right_bottom.x && p.y > box.left_top.y && p.y < box.right_bottom.y)
const surface = {
  index: 1,
  can_place_entity: ({ position }: any) => !solid.some(p => p.x === position.x && p.y === position.y),
  get_tile: (x: number, y: number) => ({ name: water.some(p => p.x === x && p.y === y) ? 'water' : 'grass-1', collides_with: (layer: string) => layer === 'water_tile' && water.some(p => p.x === x && p.y === y) }),
  find_entities_filtered: ({ area }: any) => at(ground, area).map(p => ({ valid: true, type: 'item-entity', name: 'item-on-ground', position: p, stack: { valid_for_read: true, name: 'iron-plate' } })),
}
const actor: any = { is_valid: true, surface, force: { index: 1 }, status_snapshot: () => ({ actor_id: 9 }) }
const args = { entity_name: 'transport-belt', x: 2.5, y: -3.5, direction: 4, line_direction: 4, count: 3, spacing: 2 }

function deps(batch = { batch_id: 5, batch_generation: 2, batch_ref: 'batch-g2-5' }) {
  const queued: any[] = []
  return {
    queued,
    submit_placement: vi.fn((name: string, x: number, y: number, direction: number, options: any) => { queued.push({ name, x, y, direction, options }); return true }),
    cancel_all_tasks: vi.fn(),
    status: () => ({ queue_length: queued.length, task_state: queued.length ? 'placing' : 'idle', ...(queued.length ? { active_batch: { ...batch, task_count: queued.length } } : {}) }),
  }
}

beforeEach(() => {
  ;(globalThis as any).math = { floor: Math.floor, ceil: Math.ceil, abs: Math.abs, huge: Infinity }
  ;(globalThis as any).defines = { build_check_type: { manual: 1 } }
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  held.count = 10
  ground = []
  solid = []
  water = []
  ;(globalThis as any).prototypes = { entity: { 'transport-belt': { collision_mask: { layers: { object: true, water_tile: true } } } } }
  standing.clear()
})

describe('external line placement', () => {
  it('checks every tile and the whole item count before anything is queued', () => {
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: true, tiles: [{ index: 0, position: { x: 2.5, y: -3.5 } }, { index: 1, position: { x: 4.5, y: -3.5 } }, { index: 2, position: { x: 6.5, y: -3.5 } }] })
    held.count = 2
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: false, code: 'line_placement_items_insufficient', shortfall: 1, placement_item: { held_count: 2, required_count: 3 } })
    held.count = 0
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: false, code: 'line_placement_items_insufficient', shortfall: 3 })
    held.count = 10
    ground = [{ x: 4.5, y: -3.5 }]
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: false, code: 'placement_footprint_occupied', tile_index: 1, blockers: [{ type: 'item-entity', item: 'iron-plate' }] })
    ground = []
    solid = [{ x: 6.5, y: -3.5 }]
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: false, code: 'placement_not_clear', tile_index: 2, blockers: [] })
    // A refusal names what collides: the colliding terrain tile when no entity does (trial 6 had only the bare code).
    water = [{ x: 6, y: -4 }]
    expect(line_placement_preflight(actor, args)).toMatchObject({ ok: false, code: 'placement_not_clear', tile_index: 2, blockers: [{ type: 'tile', name: 'water', position: { x: 6, y: -4 } }] })
    ground = [{ x: 6.5, y: -3.5 }]
    expect(line_placement_preflight(actor, args).blockers).toMatchObject([{ type: 'item-entity', item: 'iron-plate' }])
    ground = []
    water = []
    solid = []
    // No prototype list: a wider prototype lines when spacing clears its footprint, and refuses before anything when not.
    expect(line_placement_preflight(actor, { ...args, entity_name: 'wide-machine' })).toMatchObject({ ok: true })
    expect(line_placement_preflight(actor, { ...args, entity_name: 'wide-machine', spacing: 1 })).toMatchObject({ ok: false, code: 'line_tiles_overlap', tile_index: 1 })
    solid = [{ x: 6.5, y: -3.5 }]
    expect(line_placement_preflight(actor, { ...args, x: 2.25 })).toMatchObject({ ok: false, code: 'exact_grid_required', tile_index: 0 })
    for (const bad of [{ count: 33 }, { count: 0 }, { spacing: 9 }, { entity_name: 'Not A Name' }, { entity_name: '' }, { line_direction: 2 }, { direction: 6 }]) {
      expect(line_placement_preflight(actor, { ...args, ...bad })).toMatchObject({ ok: false, code: 'invalid_line_args' })
    }
  })

  // Trial 4r (r4-034, r4-090): a line starting where the previous one ended was refused for the actor standing on tile 0.
  // The placing runtime steps out of each tile before placing it, so the actor's own character is not a blocker here.
  it('does not count the actor\'s own character as a blocker, but still counts any other character', () => {
    const own = { valid: true, type: 'character', name: 'character', position: { x: 2.5, y: -3.5 } }
    const other = { valid: true, type: 'character', name: 'character', position: { x: 4.5, y: -3.5 }, unit_number: 44 }
    const characters = [own, other]
    const with_characters = { ...surface, find_entities_filtered: ({ area }: any) => characters.filter(entity => at([entity.position], area).length > 0) }
    const standing_actor = { ...actor, surface: with_characters, character: own }
    characters.pop()
    expect(line_placement_preflight(standing_actor, args)).toMatchObject({ ok: true })
    characters.push(other)
    expect(line_placement_preflight(standing_actor, args)).toMatchObject({ ok: false, code: 'placement_footprint_occupied', tile_index: 1, blockers: [{ type: 'character', unit_number: 44 }] })
    // Only the actor's own character is exempt: a character that is not the actor's still blocks tile 0.
    expect(line_placement_preflight({ ...standing_actor, character: undefined }, args)).toMatchObject({ ok: false, code: 'placement_footprint_occupied', tile_index: 0 })
  })

  it('refuses before queueing anything, and otherwise queues one no-clear placing task per tile in one bound batch', () => {
    ground = [{ x: 6.5, y: -3.5 }]
    let d = deps()
    expect(submit_line_placement(actor, args, d)).toEqual([false, 'placement_footprint_occupied@2'])
    expect(d.submit_placement).not.toHaveBeenCalled()
    expect((globalThis as any).storage.sgluna_line_placements ?? []).toEqual([])
    ground = []
    d = deps()
    const result = submit_line_placement(actor, args, d)
    expect(result).toEqual([true, 1])
    expect(d.queued.map(task => [task.x, task.y, task.direction, task.options])).toEqual([0, 1, 2].map(index => [2.5 + 2 * index, -3.5, 4, { refuse_clearance: true, line_node: { line_id: 1, index } }]))
    expect(line_record(1)).toMatchObject({ actor_id: 9, count: 3, batch_ref: 'batch-g2-5', batch_id: 5, batch_generation: 2, placed: [] })
    expect(submit_line_placement(actor, args, d)).toEqual([false, 'line_placement_requires_idle_queue'])
  })

  it('cancels a half-queued line and keeps no record when queueing fails', () => {
    const d = deps()
    d.submit_placement.mockImplementation((name: string, x: number, y: number, direction: number, options: any) => {
      if (options.line_node.index === 1) return false
      d.queued.push({ name, x, y, direction, options })
      return true
    })
    expect(submit_line_placement(actor, args, d)).toEqual([false, 'line_placement_queue_failed@1'])
    expect(d.cancel_all_tasks).toHaveBeenCalledWith('line_placement_queue_failed')
    expect(line_record(1)).toBeUndefined()
  })

  it('re-checks the footprint rule at execution, records placements and keeps only the first refusal', () => {
    submit_line_placement(actor, args, deps())
    const box = (x: number) => ({ left_top: { x: x - 0.5, y: -4 }, right_bottom: { x: x + 0.5, y: -3 } })
    expect(line_node_precheck(actor, { line_id: 1, index: 0 }, 'transport-belt', { x: 2.5, y: -3.5 }, 4, box(2.5))).toBeUndefined()
    expect(line_node_precheck(actor, { line_id: 1, index: 0 }, 'transport-belt', { x: 3.5, y: -3.5 }, 4, box(3.5))?.code).toBe('line_node_unproven')
    expect(line_node_precheck(actor, { line_id: 1, index: 0 }, 'transport-belt', { x: 2.5, y: -3.5 }, 0, box(2.5))?.code).toBe('line_node_unproven')
    expect(line_node_precheck(actor, { line_id: 2, index: 0 }, 'transport-belt', { x: 2.5, y: -3.5 }, 4, box(2.5))?.code).toBe('line_node_unproven')
    ground = [{ x: 4.5, y: -3.5 }]
    expect(line_node_precheck(actor, { line_id: 1, index: 1 }, 'transport-belt', { x: 4.5, y: -3.5 }, 4, box(4.5))).toMatchObject({ code: 'placement_footprint_occupied', blockers: [{ item: 'iron-plate' }] })
    record_line_node_placed({ line_id: 1, index: 0 }, { unit_number: 77, name: 'transport-belt', position: { x: 2.5, y: -3.5 }, direction: 4 } as any)
    record_line_node_placed({ line_id: 1, index: 0 }, { unit_number: 78, name: 'transport-belt', position: { x: 2.5, y: -3.5 }, direction: 4 } as any)
    line_node_failed({ line_id: 1, index: 1 }, 'placement_footprint_occupied', [{ name: 'item-on-ground', type: 'item-entity', position: { x: 4.5, y: -3.5 }, item: 'iron-plate' }])
    line_node_failed({ line_id: 1, index: 2 }, 'cancelled')
    expect(line_record(1)?.placed.map(row => row.unit_number)).toEqual([77])
    expect(line_record(1)?.refusal).toMatchObject({ index: 1, code: 'placement_footprint_occupied', blockers: [{ item: 'iron-plate' }] })
  })

  it('settles only the exact cancelled line batch, as the placed prefix, the missing and the never-placed tiles', () => {
    submit_line_placement(actor, args, deps())
    record_line_node_placed({ line_id: 1, index: 0 }, { unit_number: 77, name: 'transport-belt', position: { x: 2.5, y: -3.5 }, direction: 4 } as any)
    record_line_node_placed({ line_id: 1, index: 1 }, { unit_number: 78, name: 'transport-belt', position: { x: 4.5, y: -3.5 }, direction: 4 } as any)
    line_node_failed({ line_id: 1, index: 2 }, 'placement_footprint_occupied')
    standing.add(77)
    const admission: any = { generation: 2, actor_id: 9, operation_count: 1, tick: 100, slots: [{ ok: true, index: 1, operation: 'place_line', queued_tasks: 3, batch_refs: [{ batch_id: 5, batch_generation: 2, batch_ref: 'batch-g2-5' }] }] }
    const receipt: any = { batch_id: 5, batch_generation: 2, batch_ref: 'batch-g2-5', state: 'cancelled', task_count: 3, task_types: ['placing', 'placing', 'placing'], tasks_started: 3, started_count: 3, tick: 140, reason: 'placement_footprint_occupied' }
    const settled = terminal_line_placement_settlement(admission, { receipt_journal: [receipt], batch_generation: 2 })
    expect(settled).toMatchObject({ line_id: 1, count: 3, placed: [{ index: 0, unit_number: 77 }], missing_indexes: [1], not_placed_indexes: [2], refusal: { index: 2 }, receipt: { state: 'cancelled', tasks_started: 3 } })
    expect(terminal_line_placement_settlement(admission, { receipt_journal: [{ ...receipt, state: 'completed' }], batch_generation: 2 })).toBeUndefined()
    expect(terminal_line_placement_settlement(admission, { receipt_journal: [{ ...receipt, tasks_started: 1, started_count: 1 }], batch_generation: 2 })).toBeUndefined()
    expect(terminal_line_placement_settlement(admission, { receipt_journal: [receipt], batch_generation: 3 })).toBeUndefined()
    expect(terminal_line_placement_settlement({ ...admission, actor_id: 8 }, { receipt_journal: [receipt], batch_generation: 2 })).toBeUndefined()
    expect(terminal_line_placement_settlement(admission, { receipt_journal: [{ ...receipt, task_types: ['placing', 'walking', 'placing'] }], batch_generation: 2 })).toBeUndefined()
  })
})
