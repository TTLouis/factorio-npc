import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import { resolve_exact_entity } from './entity_reference'
import { entity_interaction_reach } from './interaction_range'
import type { new_task_manager } from './task_manager'

type Manager = ReturnType<typeof new_task_manager>
type BasicController = ReturnType<typeof new_basic_operation_controller>

// How long a successful launch order may take to register as a launched
// rocket. The rocket leaves the surface well inside this in vanilla timings;
// the bound only keeps a stuck task from waiting forever. Not yet measured in
// real Factorio.
export const LAUNCH_CONFIRMATION_TICKS = 3600

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

// Launching is a two-phase task. It orders the launch of a ready rocket on one
// exact silo, then completes only once the force's rockets_launched count has
// risen. A successful launch order is not treated as a launched rocket.
export function new_rocket_launch_runtime(manager: Manager, controller: BasicController) {
  function silo_details(target: any) {
    return {
      rocket_silo_status: target.rocket_silo_status as number,
      rocket_parts: target.rocket_parts as number,
      rocket_parts_required: target.prototype?.rocket_parts_required as number | undefined,
    }
  }

  function state_launching_rocket(actor: ControlledActor) {
    const task = manager.player_state.parameters_launch_rocket
    if (!task) {
      log('[AUTORIO] No parameters found when launching a rocket')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }

    if (task.launch_ordered_tick !== undefined) {
      const launched = actor.force.rockets_launched
      if (launched > (task.rockets_launched_before ?? 0)) {
        log(`[AUTORIO] Rocket from silo unit ${task.target_unit_number} launched; force total ${launched}`)
        controller.complete(actor, task, { rockets_launched: launched })
        return
      }
      if (game.tick - task.launch_ordered_tick > LAUNCH_CONFIRMATION_TICKS) {
        controller.fail(actor, task, 'launch_not_confirmed', { rockets_launched: launched })
      }
      return
    }

    const target = resolve_exact_entity(actor, task.target_unit_number)
    if (!target || !target.valid) {
      controller.fail(actor, task, 'target_gone')
      return
    }
    if (target.surface.index !== actor.surface.index) {
      controller.fail(actor, task, 'different_surface')
      return
    }
    if (target.force.index !== actor.force.index) {
      controller.fail(actor, task, 'wrong_force')
      return
    }
    const reach = entity_interaction_reach(actor)
    if (squared_distance(actor.position, target.position) > reach ** 2) {
      controller.fail(actor, task, 'too_far')
      return
    }
    if (target.type !== 'rocket-silo') {
      controller.fail(actor, task, 'not_rocket_silo')
      return
    }
    if (target.rocket_silo_status !== defines.rocket_silo_status.rocket_ready) {
      controller.fail(actor, task, 'rocket_not_ready', silo_details(target))
      return
    }

    const before = actor.force.rockets_launched
    // No character argument: passing one would put the NPC's body in the
    // rocket. No destination: the base-game rocket needs none.
    if (!target.launch_rocket()) {
      controller.fail(actor, task, 'launch_failed', silo_details(target))
      return
    }
    task.rockets_launched_before = before
    task.launch_ordered_tick = game.tick
    log(`[AUTORIO] Launch ordered on silo unit ${task.target_unit_number}; waiting for the rocket to leave`)
  }

  return { state_launching_rocket }
}
