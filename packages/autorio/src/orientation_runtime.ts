import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import { resolve_exact_entity } from './entity_reference'
import { entity_interaction_reach } from './interaction_range'
import type { new_task_manager } from './task_manager'

type Manager = ReturnType<typeof new_task_manager>
type BasicController = ReturnType<typeof new_basic_operation_controller>

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function new_orientation_runtime(manager: Manager, controller: BasicController) {
  function state_rotating(actor: ControlledActor) {
    const task = manager.player_state().parameters_rotate_entity
    if (!task) {
      log('[AUTORIO] No parameters found when rotating')
      return [false, 'No rotation parameters'] as const
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return [false, 'Actor changed'] as const
    }

    const entity = resolve_exact_entity(actor, task.target_unit_number)
    if (!entity || !entity.valid) {
      controller.fail(actor, task, 'target_gone')
      return [false, 'Target entity is gone'] as const
    }
    if (entity.surface.index !== actor.surface.index) {
      controller.fail(actor, task, 'different_surface')
      return [false, 'Target entity is on another surface'] as const
    }
    if (entity.force.index !== actor.force.index) {
      controller.fail(actor, task, 'wrong_force')
      return [false, 'Target entity belongs to another force'] as const
    }
    const reach = entity_interaction_reach(actor)
    if (squared_distance(actor.position, entity.position) > reach ** 2) {
      controller.fail(actor, task, 'too_far')
      return [false, 'Target entity is out of rotation range'] as const
    }
    if (!entity.supports_direction || !entity.rotatable) {
      controller.fail(actor, task, 'not_rotatable')
      return [false, 'Target entity cannot be rotated'] as const
    }

    const previous_direction = entity.direction
    if (!entity.rotate({ reverse: task.reverse })) {
      controller.fail(actor, task, 'rotation_failed', { previous_direction })
      return [false, 'Factorio rejected the rotation'] as const
    }

    const direction = entity.direction
    log(`[AUTORIO] Rotated entity unit=${task.target_unit_number} ${task.reverse ? 'counter-clockwise' : 'clockwise'}: ${previous_direction} -> ${direction}`)
    controller.complete(actor, task, { previous_direction, direction })
    return [true, 'Entity rotated successfully', entity] as const
  }

  return {
    state_rotating,
  }
}
