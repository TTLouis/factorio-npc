import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import {
  construction_plan_preflight,
  execute_validated_construction_plan,
  validate_construction_execution_plan,
} from './construction_execution'
import { new_task_manager } from './task_manager'
import { TaskStates } from './types'

function fixture(
  items: Record<string, number> = { 'stone-furnace': 2, 'burner-mining-drill': 2 },
  actorPosition = { x: 0, y: 0 },
) {
  const actorCharacter: any = {
    valid: true,
    name: 'character',
    type: 'character',
    position: actorPosition,
    bounding_box: {
      left_top: { x: actorPosition.x - 0.3, y: actorPosition.y - 0.3 },
      right_bottom: { x: actorPosition.x + 0.3, y: actorPosition.y + 0.3 },
    },
    force: { name: 'player' },
  }
  const surface: any = {
    index: 1,
    name: 'nauvis',
    can_place_entity: vi.fn(() => true),
    find_entities_filtered: vi.fn(() => [actorCharacter]),
    get_tile: vi.fn(() => ({ name: 'grass-1' })),
  }
  const inventory: any = {
    get_contents: vi.fn(() => Object.entries(items).map(([name, count]) => ({ name, quality: 'normal', count }))),
  }
  const actor = {
    is_valid: true,
    character: actorCharacter,
    position: actorPosition,
    surface,
    force: { index: 1, name: 'player' },
    get_main_inventory: vi.fn(() => inventory),
    status_snapshot: vi.fn(() => ({
      actor_id: 42,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'SGLuna',
      position: actorPosition,
    })),
  } as unknown as ControlledActor
  return { actor, surface, inventory, manager: new_task_manager(() => actor), actorCharacter }
}

function fixture_with_controller(
  items: Record<string, number> = { 'stone-furnace': 2, 'burner-mining-drill': 2 },
  actorPosition = { x: 0, y: 0 },
) {
  const f = fixture(items, actorPosition)
  const get_actor = () => f.actor
  const manager = new_task_manager(get_actor)
  const basic = new_basic_operation_controller(get_actor, manager)
  return { ...f, manager, basic }
}

beforeEach(() => {
  ;(globalThis as any).storage = {}
  ;(globalThis as any).game.tick = 100
  ;(globalThis as any).prototypes.item['stone-furnace'] = {}
  ;(globalThis as any).prototypes.item['burner-mining-drill'] = {}
  ;(globalThis as any).prototypes.item['assembling-machine-1'] = {}
  ;(globalThis as any).prototypes.entity['stone-furnace'] = {
    items_to_place_this: [{ name: 'stone-furnace', count: 1 }],
    type: 'furnace',
    tile_width: 2,
    tile_height: 2,
    collision_box: { left_top: { x: -0.7, y: -0.7 }, right_bottom: { x: 0.7, y: 0.7 } },
    selection_box: { left_top: { x: -1, y: -1 }, right_bottom: { x: 1, y: 1 } },
  }
  ;(globalThis as any).prototypes.entity['burner-mining-drill'] = {
    items_to_place_this: [{ name: 'burner-mining-drill', count: 1 }],
    type: 'mining-drill',
    tile_width: 2,
    tile_height: 2,
    collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
    selection_box: { left_top: { x: -1, y: -1 }, right_bottom: { x: 1, y: 1 } },
    mining_drill_radius: 1.49,
  }
  ;(globalThis as any).prototypes.entity['assembling-machine-1'] = {
    items_to_place_this: [{ name: 'assembling-machine-1', count: 1 }],
    type: 'assembling-machine',
    tile_width: 3,
    tile_height: 3,
    collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
    selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
  }
})

describe('validated construction execution', () => {
  it('validates a bounded collision-free batch and queues exact placement tasks without another model turn', () => {
    const f = fixture_with_controller()
    const validation: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'two-furnaces',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0, direction: 4 },
      ],
    })

    expect(validation).toMatchObject({
      ok: true,
      validation_id: 1,
      plan_id: 'two-furnaces',
      placement_count: 2,
      created_tick: 100,
      placement_geometry: [
        expect.objectContaining({
          index: 0,
          prototype: expect.objectContaining({
            physical_footprint: expect.objectContaining({ tile_width: 2, tile_height: 2 }),
          }),
        }),
        expect.objectContaining({ index: 1 }),
      ],
    })
    expect(f.surface.can_place_entity).toHaveBeenCalledTimes(2)

    expect(execute_validated_construction_plan(
      f.actor,
      validation.validation_id,
      validation.placement_count,
      f.basic,
      f.manager,
    )).toEqual([true, 'Validated construction plan started'])

    expect(f.manager.player_state.task_state).toBe(TaskStates.PLACING)
    expect(f.manager.player_state.parameters_place_entity).toMatchObject({
      entity_name: 'stone-furnace',
      position: { x: -2, y: 0 },
      direction: 0,
    })
    expect(f.manager.get_status_snapshot()).toMatchObject({
      queue_length: 1,
      queued_task_types: [TaskStates.PLACING],
      active_batch: {
        task_count: 2,
        task_types: [TaskStates.PLACING, TaskStates.PLACING],
      },
    })
  })

  it('rejects collisions between planned placements even when the live world says each coordinate is individually placeable', () => {
    const f = fixture_with_controller()
    const result: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'overlap',
      placements: [
        { entity_name: 'stone-furnace', x: 1, y: 1 },
        { entity_name: 'stone-furnace', x: 1.5, y: 1 },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PLANNED_COLLISION',
        indices: [0, 1],
        placements: [
          expect.objectContaining({ index: 0, entity_name: 'stone-furnace' }),
          expect.objectContaining({ index: 1, entity_name: 'stone-furnace' }),
        ],
      },
    })
    expect(result.error.overlap_box).toBeDefined()
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
  })

  it('explains the miner-plus-furnace overlap without confusing mining working area with physical collision', () => {
    const f = fixture_with_controller(undefined, { x: 51, y: 49 })
    const result: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'miner-furnace-pair',
      placements: [
        { entity_name: 'burner-mining-drill', x: 51, y: 49, direction: 8 },
        { entity_name: 'stone-furnace', x: 51, y: 50 },
      ],
    })

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PLANNED_COLLISION',
        indices: [0, 1],
        placements: [
          expect.objectContaining({
            entity_name: 'burner-mining-drill',
            prototype: expect.objectContaining({
              physical_footprint: expect.objectContaining({ tile_width: 2, tile_height: 2 }),
              working_area: { kind: 'mining', radius: 1.49 },
            }),
          }),
          expect.objectContaining({
            entity_name: 'stone-furnace',
            prototype: expect.objectContaining({
              physical_footprint: expect.objectContaining({ tile_width: 2, tile_height: 2 }),
            }),
          }),
        ],
      },
    })
  })

  it('rejects missing inventory and enriches live world collisions before creating a validation token', () => {
    const missing = fixture_with_controller({ 'stone-furnace': 1 })
    const inventoryResult: any = validate_construction_execution_plan(missing.actor, {
      plan_id: 'missing-items',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0 },
        { entity_name: 'stone-furnace', x: 2, y: 0 },
      ],
    })
    expect(inventoryResult).toMatchObject({
      ok: false,
      error: { code: 'ITEMS_MISSING', item_name: 'stone-furnace', required_count: 2, available_count: 1 },
    })

    const blocked = fixture_with_controller()
    blocked.surface.can_place_entity.mockReturnValueOnce(false)
    const worldResult: any = validate_construction_execution_plan(blocked.actor, {
      plan_id: 'blocked',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })
    expect(worldResult).toMatchObject({
      ok: false,
      error: {
        code: 'WORLD_COLLISION',
        index: 0,
        placement: expect.objectContaining({
          entity_name: 'stone-furnace',
          prototype: expect.objectContaining({
            physical_footprint: expect.objectContaining({ tile_width: 2, tile_height: 2 }),
          }),
        }),
        spatial_context: expect.objectContaining({
          ok: true,
          requested_entity: expect.objectContaining({ name: 'stone-furnace', exists: true }),
        }),
      },
    })
  })

  it('fails closed when a validation is expired, superseded, or has the wrong placement count', () => {
    const f = fixture_with_controller()
    const first: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'first',
      placements: [{ entity_name: 'stone-furnace', x: -2, y: 0 }],
    })
    const second: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'second',
      placements: [{ entity_name: 'stone-furnace', x: 2, y: 0 }],
    })

    expect(execute_validated_construction_plan(f.actor, first.validation_id, 1, f.basic, f.manager)[0]).toBe(false)
    expect(execute_validated_construction_plan(f.actor, second.validation_id, 2, f.basic, f.manager)[0]).toBe(false)

    ;(globalThis as any).game.tick = second.created_tick + 3601
    expect(execute_validated_construction_plan(f.actor, second.validation_id, 1, f.basic, f.manager)).toEqual([
      false,
      'validated construction plan expired; validate the live world again',
    ])
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
  })
  it('validates inventory by the prototype placement item instead of guessing the entity name', () => {
    ;(globalThis as any).prototypes.item['custom-assembler-kit'] = {}
    ;(globalThis as any).prototypes.item['custom-assembler'] = {}
    ;(globalThis as any).prototypes.entity['custom-assembler'] = {
      items_to_place_this: [{ name: 'custom-assembler-kit', count: 2 }],
      type: 'assembling-machine',
      tile_width: 3,
      tile_height: 3,
      collision_box: { left_top: { x: -1.4, y: -1.4 }, right_bottom: { x: 1.4, y: 1.4 } },
      selection_box: { left_top: { x: -1.5, y: -1.5 }, right_bottom: { x: 1.5, y: 1.5 } },
    }

    const accepted = fixture_with_controller({ 'custom-assembler-kit': 2 })
    expect(validate_construction_execution_plan(accepted.actor, {
      plan_id: 'alias-item',
      placements: [{ entity_name: 'custom-assembler', x: 2, y: 0 }],
    })).toMatchObject({ ok: true })

    const guessed = fixture_with_controller({ 'custom-assembler': 2 })
    expect(validate_construction_execution_plan(guessed.actor, {
      plan_id: 'entity-name-is-not-item-name',
      placements: [{ entity_name: 'custom-assembler', x: 2, y: 0 }],
    })).toMatchObject({
      ok: false,
      error: {
        code: 'ITEMS_MISSING',
        item_name: 'custom-assembler-kit',
        required_count: 2,
        available_count: 0,
      },
    })
  })

  it('fails closed before validation for ambiguous or non-item-placeable entities', () => {
    ;(globalThis as any).prototypes.item['kit-a'] = {}
    ;(globalThis as any).prototypes.item['kit-b'] = {}
    ;(globalThis as any).prototypes.entity['ambiguous-machine'] = {
      items_to_place_this: [{ name: 'kit-a', count: 1 }, { name: 'kit-b', count: 1 }],
      collision_box: { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } },
    }
    ;(globalThis as any).prototypes.entity['script-only-entity'] = {
      items_to_place_this: [],
      collision_box: { left_top: { x: -0.4, y: -0.4 }, right_bottom: { x: 0.4, y: 0.4 } },
    }
    const f = fixture_with_controller({ 'kit-a': 1, 'kit-b': 1 })

    expect(validate_construction_execution_plan(f.actor, {
      plan_id: 'ambiguous',
      placements: [{ entity_name: 'ambiguous-machine', x: 2, y: 0 }],
    })).toMatchObject({
      ok: false,
      error: { code: 'PLACEMENT_ITEM_UNSUPPORTED', placement_item_error: 'ambiguous_placement_item', entity_name: 'ambiguous-machine' },
    })
    expect(validate_construction_execution_plan(f.actor, {
      plan_id: 'not-placeable',
      placements: [{ entity_name: 'script-only-entity', x: 2, y: 0 }],
    })).toMatchObject({
      ok: false,
      error: { code: 'PLACEMENT_ITEM_UNSUPPORTED', placement_item_error: 'not_item_placeable', entity_name: 'script-only-entity' },
    })
  })

})


it('cannot use raw construction validation to bypass pump candidate identity', () => {
  ;(globalThis as any).prototypes.entity['test-pump'] = { type: 'offshore-pump' }
  const f = fixture_with_controller({ 'test-pump': 1 })
  const result = validate_construction_execution_plan(f.actor, { plan_id: 'pump-plan', placements: [{ entity_name: 'test-pump', x: 1, y: 1, direction: 0 }] })
  expect(result).toMatchObject({ ok: false, error: { code: 'PLACEMENT_CANDIDATE_REQUIRED' } })
  expect(f.surface.can_place_entity).not.toHaveBeenCalled()
  expect(f.manager.get_status_snapshot().queue_length).toBe(0)
})

describe('construction plan preflight (fluid-preservation witness)', () => {
  function validated(items: Record<string, number> = { 'stone-furnace': 2, 'burner-mining-drill': 2 }) {
    const f = fixture_with_controller(items)
    const validation: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'witness-plan',
      placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0 },
        { entity_name: 'burner-mining-drill', x: 2, y: 0, direction: 4 },
      ],
    })
    expect(validation.ok).toBe(true)
    return { f, items, id: validation.validation_id as number }
  }
  const snapshot = () => JSON.stringify((globalThis as any).storage)

  it('resolves the exact stored local plan and returns a nonfluid witness bound to id, count and scope', () => {
    const { f, id } = validated()
    expect(construction_plan_preflight(f.actor, id, 2)).toEqual({
      ok: true,
      validation_id: id,
      plan_id: 'witness-plan',
      placement_count: 2,
      created_tick: 100,
      expires_tick: 3700,
      preservation_clears_count: 0,
      execution_clearance: 'refused',
      construction_placements: [
        { entity_name: 'stone-furnace', x: -2, y: 0, direction: 0, position: { x: -2, y: 0 }, fluidbox_count: 0,
          planned_footprint: expect.objectContaining({ entity_name: 'stone-furnace', position: { x: -2, y: 0 }, direction: 0 }) },
        { entity_name: 'burner-mining-drill', x: 2, y: 0, direction: 4, position: { x: 2, y: 0 }, fluidbox_count: 0,
          planned_footprint: expect.objectContaining({ entity_name: 'burner-mining-drill', position: { x: 2, y: 0 }, direction: 4 }) },
      ],
      preservation_nonfluid_output: {
        version: 1,
        actor_id: 42,
        surface_index: 1,
        force_index: 1,
        validation_id: id,
        placement_count: 2,
        entity_names: ['stone-furnace', 'burner-mining-drill'],
        execution_clearance: 'refused',
        fluid_port_count: 0,
      },
    })
  })

  it('is read-only: no storage write, no queue, and the plan stays executable afterwards', () => {
    const { f, id } = validated()
    const before = snapshot()
    for (let i = 0; i < 3; i++) expect(construction_plan_preflight(f.actor, id, 2).ok).toBe(true)
    expect(snapshot()).toBe(before)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
    expect(f.manager.player_state.task_state).toBe(TaskStates.IDLE)
    expect(execute_validated_construction_plan(f.actor, id, 2, f.basic, f.manager)).toEqual([true, 'Validated construction plan started'])
  })

  it('refuses without mutating storage: wrong id, wrong count, superseded, invalid arguments, no actor', () => {
    const { f, id } = validated()
    const before = snapshot()
    expect(construction_plan_preflight(f.actor, id + 1, 2)).toEqual({ ok: false, code: 'construction_plan_unavailable' })
    expect(construction_plan_preflight(f.actor, id, 1)).toEqual({ ok: false, code: 'construction_plan_count_mismatch' })
    expect(construction_plan_preflight(f.actor, id, 3)).toEqual({ ok: false, code: 'construction_plan_count_mismatch' })
    for (const [validation_id, count] of [['1', 2], [id, '2'], [0, 2], [id, 0], [id, 17], [1.5, 2], [id, 2.5], [undefined, undefined], [Number.NaN, 2]]) {
      expect(construction_plan_preflight(f.actor, validation_id, count)).toEqual({ ok: false, code: 'invalid_preflight_args' })
    }
    expect(construction_plan_preflight(undefined, id, 2)).toEqual({ ok: false, code: 'no_actor' })
    expect(construction_plan_preflight({ is_valid: false } as any, id, 2)).toEqual({ ok: false, code: 'no_actor' })
    expect(snapshot()).toBe(before)
    // A re-validation makes the first id unavailable; only the newer id gets a witness.
    const second: any = validate_construction_execution_plan(f.actor, { plan_id: 'second', placements: [{ entity_name: 'stone-furnace', x: -2, y: 0 }] })
    expect(construction_plan_preflight(f.actor, id, 2)).toEqual({ ok: false, code: 'construction_plan_unavailable' })
    expect(construction_plan_preflight(f.actor, second.validation_id, 1)).toMatchObject({ ok: true, validation_id: second.validation_id })
  })

  it('refuses an expired plan and keeps the stored plan (the executor owns clearing it)', () => {
    const { f, id } = validated()
    ;(globalThis as any).game.tick = 100 + 3600
    expect(construction_plan_preflight(f.actor, id, 2).ok).toBe(true)
    ;(globalThis as any).game.tick = 100 + 3601
    const before = snapshot()
    expect(construction_plan_preflight(f.actor, id, 2)).toEqual({ ok: false, code: 'construction_plan_expired' })
    expect(snapshot()).toBe(before)
    expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeDefined()
  })

  it('refuses another actor, surface or force', () => {
    for (const change of [
      (a: any) => { a.status_snapshot = vi.fn(() => ({ actor_id: 43 })) },
      (a: any) => { a.status_snapshot = vi.fn(() => ({ actor_id: undefined })) },
      (a: any) => { a.surface = { ...a.surface, index: 2 } },
      (a: any) => { a.force = { index: 2, name: 'enemy' } },
    ]) {
      const { f, id } = validated()
      change(f.actor)
      const before = snapshot()
      expect(construction_plan_preflight(f.actor, id, 2)).toEqual({ ok: false, code: 'construction_plan_scope_mismatch' })
      expect(snapshot()).toBe(before)
    }
  })

  it('re-evaluates the live world: missing stock, a blocked tile or a reserved site makes the plan stale', () => {
    const missing = validated({ 'stone-furnace': 2, 'burner-mining-drill': 2 })
    missing.items['stone-furnace'] = 0
    expect(construction_plan_preflight(missing.f.actor, missing.id, 2)).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'ITEMS_MISSING' })

    const blocked = validated()
    blocked.f.surface.can_place_entity.mockReturnValue(false)
    const before = snapshot()
    expect(construction_plan_preflight(blocked.f.actor, blocked.id, 2)).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'WORLD_COLLISION' })
    expect(snapshot()).toBe(before)
    expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeDefined()
  })

  it('sums the stock requirement of repeated items across placements', () => {
    const f = fixture_with_controller({ 'stone-furnace': 2 })
    const validation: any = validate_construction_execution_plan(f.actor, {
      plan_id: 'two-furnaces',
      placements: [{ entity_name: 'stone-furnace', x: -3, y: 0 }, { entity_name: 'stone-furnace', x: 3, y: 0 }],
    })
    expect(construction_plan_preflight(f.actor, validation.validation_id, 2).ok).toBe(true)
    f.inventory.get_contents.mockReturnValue([{ name: 'stone-furnace', quality: 'normal', count: 1 }])
    expect(construction_plan_preflight(f.actor, validation.validation_id, 2)).toMatchObject({ ok: false, code: 'construction_plan_stale', evaluation_code: 'ITEMS_MISSING' })
  })

  it('does not grant a nonfluid witness when any placement prototype declares a fluidbox (prototype data, not names)', () => {
    const { f, id } = validated()
    ;(globalThis as any).prototypes.entity['burner-mining-drill'].fluidbox_prototypes = [{ index: 1 }]
    const result: any = construction_plan_preflight(f.actor, id, 2)
    expect(result.ok).toBe(true)
    expect(result.preservation_nonfluid_output).toBeUndefined()
    expect(result.construction_placements.map((row: any) => row.fluidbox_count)).toEqual([0, 1])
    // The witness follows the prototype data: a furnace with a fluidbox is fluid, a drill without one is not.
    ;(globalThis as any).prototypes.entity['burner-mining-drill'].fluidbox_prototypes = []
    ;(globalThis as any).prototypes.entity['stone-furnace'].fluidbox_prototypes = [{ index: 1 }]
    expect((construction_plan_preflight(f.actor, id, 2) as any).preservation_nonfluid_output).toBeUndefined()
    ;(globalThis as any).prototypes.entity['stone-furnace'].fluidbox_prototypes = []
    expect((construction_plan_preflight(f.actor, id, 2) as any).preservation_nonfluid_output).toBeDefined()
  })

  it('reports each placement at the grid-snapped centre the engine uses, beside the requested coordinates', () => {
    const f = fixture_with_controller({ 'assembling-machine-1': 1 })
    const validation: any = validate_construction_execution_plan(f.actor, { plan_id: 'odd-plan', placements: [{ entity_name: 'assembling-machine-1', x: 1, y: -3, direction: 0 }] })
    expect(validation.ok).toBe(true)
    const [row] = (construction_plan_preflight(f.actor, validation.validation_id, 1) as any).construction_placements
    expect(row).toMatchObject({ x: 1, y: -3, position: { x: 1.5, y: -2.5 } })
  })

  it('refuses a prepared remote plan with a distinct code and never consumes it', () => {
    const f = fixture_with_controller()
    ;(globalThis as any).storage.sgluna_validated_remote_construction_plan = {
      validation_id: 9, actor_id: 42, force_index: 1, surface_index: 1, created_tick: 100, x: 1, y: 1, entity_name: 'stone-furnace',
    }
    ;(globalThis as any).storage.sgluna_next_construction_validation_id = 9
    const before = snapshot()
    expect(construction_plan_preflight(f.actor, 9, 1)).toEqual({ ok: false, code: 'construction_plan_remote_unsupported' })
    expect(snapshot()).toBe(before)
    expect((globalThis as any).storage.sgluna_validated_remote_construction_plan.validation_id).toBe(9)
  })
})

// Milestone 4, acceptance L1: placements that are each legal alone but collide with each other are refused before anything is
// built, by comparing the footprints execution will build (grid-snapped centres, collision boxes and layers), not only by
// asking the world about each placement on its own.
describe('joint layout proof (milestone 4 L1)', () => {
  // Fixture furnaces are 2x2 with a +-0.7 collision box: a 2x2 entity is built at the nearest whole-tile centre. Requested
  // at x 0.6 and 2.4 their boxes are [-0.1, 1.3] and [1.7, 3.1], apart; built at x 1 and 2 they are [0.3, 1.7] and
  // [1.3, 2.7], overlapping.
  const snapped_overlap = [
    { entity_name: 'stone-furnace', x: 0.6, y: 0, direction: 0 },
    { entity_name: 'stone-furnace', x: 2.4, y: 0, direction: 0 },
  ]

  it('refuses placements that collide only at the centres execution snaps them to, and stores no validation', () => {
    const f = fixture_with_controller()
    const result: any = validate_construction_execution_plan(f.actor, { plan_id: 'snapped-overlap', placements: snapped_overlap })
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PLANNED_COLLISION',
        indices: [0, 1],
        placements: [
          expect.objectContaining({ position: { x: 0.6, y: 0 }, planned_position: { x: 1, y: 0 } }),
          expect.objectContaining({ position: { x: 2.4, y: 0 }, planned_position: { x: 2, y: 0 } }),
        ],
      },
    })
    expect(result.error.overlap_box.left_top.x).toBeCloseTo(1.3)
    expect(result.error.overlap_box.right_bottom.x).toBeCloseTo(1.7)
    // Each placement was legal on its own: the world was asked about both.
    expect(f.surface.can_place_entity).toHaveBeenCalledTimes(2)
    expect((globalThis as any).storage.sgluna_validated_construction_plan).toBeUndefined()
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)

    const apart: any = validate_construction_execution_plan(f.actor, { plan_id: 'snapped-apart', placements: [snapped_overlap[0], { ...snapped_overlap[1], x: 3.4 }] })
    expect(apart.ok).toBe(true)
    expect(apart.placement_geometry.map((row: any) => row.planned_position)).toEqual([{ x: 1, y: 0 }, { x: 3, y: 0 }])
  })

  it('repeats the joint proof at the witness and at execution, so a stored plan that collides is never started', () => {
    const f = fixture_with_controller()
    ;(globalThis as any).storage.sgluna_validated_construction_plan = {
      validation_id: 7, plan_id: 'forged', actor_id: 42, surface_index: 1, force_index: 1, created_tick: 100, placements: snapped_overlap,
    }
    expect(construction_plan_preflight(f.actor, 7, 2)).toEqual({ ok: false, code: 'construction_plan_stale', evaluation_code: 'PLANNED_COLLISION' })
    expect(execute_validated_construction_plan(f.actor, 7, 2, f.basic, f.manager)).toEqual([false, 'validated construction plan became stale: PLANNED_COLLISION'])
    expect(f.manager.get_status_snapshot().task_state).toBe(TaskStates.IDLE)
    expect(f.manager.get_status_snapshot().queue_length).toBe(0)
  })

  it('compares collision layers like the batch check: disjoint layers share space, unreadable layers are assumed to collide', () => {
    const f = fixture_with_controller({ 'stone-furnace': 1, 'test-floor-plate': 1 })
    ;(globalThis as any).prototypes.item['test-floor-plate'] = {}
    ;(globalThis as any).prototypes.entity['test-floor-plate'] = {
      items_to_place_this: [{ name: 'test-floor-plate', count: 1 }],
      type: 'simple-entity-with-owner',
      tile_width: 2,
      tile_height: 2,
      collision_box: { left_top: { x: -0.9, y: -0.9 }, right_bottom: { x: 0.9, y: 0.9 } },
      collision_mask: { layers: { floor: true } },
    }
    const stacked = [{ entity_name: 'stone-furnace', x: 1, y: 1 }, { entity_name: 'test-floor-plate', x: 1, y: 1 }]
    // The furnace's layers cannot be read in this fixture: assumed to collide.
    expect(validate_construction_execution_plan(f.actor, { plan_id: 'unknown-layers', placements: stacked })).toMatchObject({ ok: false, error: { code: 'PLANNED_COLLISION' } })
    ;(globalThis as any).prototypes.entity['stone-furnace'].collision_mask = { layers: { object: true, item: true } }
    expect(validate_construction_execution_plan(f.actor, { plan_id: 'disjoint-layers', placements: stacked }).ok).toBe(true)
    ;(globalThis as any).prototypes.entity['test-floor-plate'].collision_mask = { layers: { floor: true, item: true } }
    expect(validate_construction_execution_plan(f.actor, { plan_id: 'shared-layer', placements: stacked })).toMatchObject({ ok: false, error: { code: 'PLANNED_COLLISION' } })
  })

  it('refuses a direction the footprint geometry cannot rotate, and gives the witness the snapped footprint of every placement', () => {
    const f = fixture_with_controller()
    expect(validate_construction_execution_plan(f.actor, { plan_id: 'diagonal', placements: [{ entity_name: 'stone-furnace', x: 1, y: 1, direction: 2 }] }))
      .toMatchObject({ ok: false, error: { code: 'INVALID_PLACEMENT', index: 0 } })
    const validation: any = validate_construction_execution_plan(f.actor, { plan_id: 'apart', placements: [snapped_overlap[0], { ...snapped_overlap[1], x: 3.4 }] })
    const rows = (construction_plan_preflight(f.actor, validation.validation_id, 2) as any).construction_placements
    expect(rows.map((row: any) => row.position)).toEqual([{ x: 1, y: 0 }, { x: 3, y: 0 }])
    expect(rows.map((row: any) => row.planned_footprint.position)).toEqual([{ x: 1, y: 0 }, { x: 3, y: 0 }])
    expect(rows[1].planned_footprint.world_box.left_top.x).toBeCloseTo(2.3)
  })
})
