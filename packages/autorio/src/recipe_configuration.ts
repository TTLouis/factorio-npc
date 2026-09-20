import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import { resolve_exact_entity } from './entity_reference'
import { entity_interaction_reach } from './interaction_range'
import { crafting_categories_support_recipe } from './recipe_categories'
import type { new_task_manager } from './task_manager'

type Manager = ReturnType<typeof new_task_manager>
type BasicController = ReturnType<typeof new_basic_operation_controller>

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

// Recipe category reading lives in one place; see recipe_categories.ts for why
// `recipe.categories` is fatal rather than merely wrong.
function supports_recipe_category(target: any, recipe: any) {
  return crafting_categories_support_recipe(target.prototype?.crafting_categories, recipe)
}

export function new_recipe_configuration_runtime(manager: Manager, controller: BasicController) {
  function state_setting_recipe(actor: ControlledActor) {
    const task = manager.player_state.parameters_set_recipe
    if (!task) {
      log('[AUTORIO] No parameters found when setting machine recipe')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
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
    if (target.type !== 'assembling-machine') {
      controller.fail(actor, task, 'not_recipe_machine')
      return
    }

    const recipe = actor.force.recipes[task.recipe_name]
    if (!recipe) {
      controller.fail(actor, task, 'invalid_recipe')
      return
    }
    if (!recipe.enabled) {
      controller.fail(actor, task, 'recipe_disabled')
      return
    }
    if (!supports_recipe_category(target, recipe)) {
      controller.fail(actor, task, 'incompatible_recipe')
      return
    }

    const [current_recipe] = target.get_recipe()
    if (current_recipe?.name === task.recipe_name) {
      log(`[AUTORIO] Machine unit ${task.target_unit_number} already has recipe ${task.recipe_name}`)
      controller.complete(actor, task)
      return
    }
    if (current_recipe) {
      controller.fail(actor, task, 'set_recipe_failed')
      log(`[AUTORIO] Refused to replace existing recipe ${current_recipe.name} on machine unit ${task.target_unit_number}`)
      return
    }

    target.set_recipe(task.recipe_name)
    const [verified_recipe] = target.get_recipe()
    if (verified_recipe?.name !== task.recipe_name) {
      controller.fail(actor, task, 'set_recipe_failed')
      return
    }

    log(`[AUTORIO] Set machine unit ${task.target_unit_number} recipe to ${task.recipe_name}`)
    controller.complete(actor, task)
  }

  return { state_setting_recipe }
}
