import type { ControlledActor } from './actors/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { new_basic_operation_controller } from './basic_operations'
import {
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
