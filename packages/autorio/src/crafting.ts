import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersCraftItem } from './types'
import { TaskStates } from './types'

const MAX_CRAFT_COUNT = 1000
const MAX_CRAFT_TICKS = 10 * 60 * 60

type CraftingCode = 'queued' | 'started' | 'completed' | 'cancelled'
  | 'no_actor' | 'invalid_count' | 'recipe_unavailable' | 'recipe_locked'
  | 'native_queue_busy' | 'not_enough_ingredients' | 'could_not_start'
  | 'partial_start' | 'actor_changed' | 'output_missing' | 'timeout'

interface CraftingResult {
  accepted: boolean
  completed: boolean
  code: CraftingCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  item_name?: string
  requested_count?: number
  started_count?: number
  output_count_before?: number
  output_count_after?: number
  native_queue_remaining?: number
}

interface OwnedCraftingMarker {
  actor_id: number
  actor_kind: string
  force_index: number
  item_name: string
  requested_count: number
  started_tick: number
}

declare const storage: {
  airi_last_crafting_result?: CraftingResult
  airi_owned_crafting?: OwnedCraftingMarker
}

function valid_count(count: number) {
  return typeof count === 'number'
    && count === math.floor(count)
    && count >= 1
    && count <= MAX_CRAFT_COUNT
}

function identity_matches(actor: ControlledActor, task: PlayerParametersCraftItem) {
  // Never infer ownership from whichever actor happens to be resolved now.
  // Legacy/synthetic task data may not carry ownership metadata at all.
  if (task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined) {
    return false
  }

  const identity = actor.status_snapshot()
  return identity.actor_id !== undefined
    && identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function output_count(actor: ControlledActor, item_name: string) {
  return actor.get_main_inventory()?.get_item_count(item_name) ?? 0
}

function record(actor: ControlledActor | undefined, task: PlayerParametersCraftItem | undefined, accepted: boolean, completed: boolean, code: CraftingCode): CraftingResult {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const result: CraftingResult = {
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: identity?.actor_id,
    actor_kind: identity?.kind,
    force_index: actor?.is_valid ? actor.force.index : undefined,
    item_name: task?.item_name,
    requested_count: task?.count,
    started_count: task?.started,
    output_count_before: task?.output_count_before,
    output_count_after: actor && task ? output_count(actor, task.item_name) : undefined,
    native_queue_remaining: actor?.get_crafting_queue().length,
  }
  storage.airi_last_crafting_result = result
  return result
}

function persist_owned_marker(task: PlayerParametersCraftItem) {
  if (task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined || task.started_tick === undefined) {
    return
  }
  storage.airi_owned_crafting = {
    actor_id: task.owner_actor_id,
    actor_kind: task.owner_actor_kind,
    force_index: task.owner_force_index,
    item_name: task.item_name,
    requested_count: task.count,
    started_tick: task.started_tick,
  }
}

function clear_owned_marker(task: PlayerParametersCraftItem) {
  const marker = storage.airi_owned_crafting
  if (!marker) {
    return
  }
  if (marker.actor_id === task.owner_actor_id && marker.actor_kind === task.owner_actor_kind && marker.force_index === task.owner_force_index) {
    storage.airi_owned_crafting = undefined
  }
}

export function new_crafting_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  function cancel_owned_native_queue(actor: ControlledActor, task: PlayerParametersCraftItem) {
    if (!task.owns_native_queue) {
      return 0
    }

    // Admission requires an empty native queue. Therefore every queue entry
    // created by begin_crafting for this request (including prerequisites) is
    // owned by the request. Cancel from the tail so queue indexes before the
    // cancelled entry stay stable as Factorio removes entries/cascades.
    const queue = actor.get_crafting_queue()
    let cancelled = 0
    for (let i = queue.length - 1; i >= 0; i--) {
      const item = queue[i]
      if (!item) {
        continue
      }
      actor.cancel_crafting({ index: item.index, count: item.count })
      cancelled += item.count
    }
    task.owns_native_queue = false
    return cancelled
  }

  function fail(actor: ControlledActor | undefined, task: PlayerParametersCraftItem, code: CraftingCode, cancel_native = true) {
    if (cancel_native && actor && identity_matches(actor, task)) {
      cancel_owned_native_queue(actor, task)
    }
    // Keep the persisted marker on actor_changed: another identity must never
    // cancel the previous body's queue. Load/death ownership reconciliation is
    // responsible for the old body marker at those boundaries.
    if (code !== 'actor_changed') {
      clear_owned_marker(task)
    }
    // Avoid the registered cancellation handler overwriting the explicit
    // failure result after native cleanup has already run.
    task.owns_native_queue = false
    manager.cancel_all_tasks()
    record(actor, task, false, false, code)
    log(`[AUTORIO] [ERROR] Crafting task failed: ${code}; dependent operations cancelled`)
  }

  function complete(actor: ControlledActor, task: PlayerParametersCraftItem) {
    clear_owned_marker(task)
    task.owns_native_queue = false
    record(actor, task, true, true, 'completed')
    manager.reset_task_state()
    manager.next_task()
    log(`[AUTORIO] Crafting task complete: ${task.item_name} x${task.started ?? task.count}`)
  }

  function submit(item_name: string, count: number = 1): [boolean, string] {
    if (!valid_count(count)) {
      record(get_actor(), undefined, false, false, 'invalid_count')
      return [false, `Craft count must be an integer from 1 to ${MAX_CRAFT_COUNT}`]
    }

    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      record(actor, undefined, false, false, 'no_actor')
      return [false, 'No controlled actor']
    }

    const recipe = actor.force.recipes[item_name]
    if (!recipe) {
      record(actor, undefined, false, false, 'recipe_unavailable')
      return [false, 'Recipe not available']
    }
    if (!recipe.enabled) {
      record(actor, undefined, false, false, 'recipe_locked')
      return [false, 'Recipe not unlocked']
    }

    // Do not merge ownership into pre-existing native crafting work. Waiting
    // or retrying later preserves unrelated crafts exactly as Factorio queued
    // them and gives cancellation a clean ownership boundary.
    if (actor.get_crafting_queue().length > 0) {
      record(actor, undefined, false, false, 'native_queue_busy')
      return [false, 'Native crafting queue is busy; wait for existing crafts before retrying']
    }

    if (actor.get_craftable_count(item_name) < count) {
      record(actor, undefined, false, false, 'not_enough_ingredients')
      return [false, 'Not enough ingredients']
    }

    const task: PlayerParametersCraftItem = {
      type: TaskStates.CRAFTING,
      item_name,
      count,
      crafted: 0,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    }
    manager.add_task(task)
    record(actor, task, true, false, 'queued')
    log(`[AUTORIO] New craft_item task: ${item_name} x${count}`)
    return [true, 'Task started']
  }

  function start_native(actor: ControlledActor, task: PlayerParametersCraftItem) {
    if (actor.get_crafting_queue().length > 0) {
      fail(actor, task, 'native_queue_busy', false)
      return false
    }

    const recipe = actor.force.recipes[task.item_name]
    if (!recipe) {
      fail(actor, task, 'recipe_unavailable', false)
      return false
    }
    if (!recipe.enabled) {
      fail(actor, task, 'recipe_locked', false)
      return false
    }
    if (actor.get_craftable_count(task.item_name) < task.count) {
      fail(actor, task, 'not_enough_ingredients', false)
      return false
    }

    task.output_count_before = output_count(actor, task.item_name)
    task.started = actor.begin_crafting({ count: task.count, recipe: task.item_name })
    task.started_tick = game.tick
    task.expected_output_delta = task.started
    task.owns_native_queue = task.started > 0 && actor.get_crafting_queue().length > 0

    if (task.started <= 0) {
      fail(actor, task, 'could_not_start', false)
      return false
    }
    if (task.started !== task.count) {
      fail(actor, task, 'partial_start')
      return false
    }

    if (task.owns_native_queue) {
      persist_owned_marker(task)
    }
    record(actor, task, true, false, 'started')
    return true
  }

  function tick(actor: ControlledActor) {
    if (!task || manager.player_state.task_state !== TaskStates.CRAFTING) {
      return
    }
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed', false)
      return
    }

    if (task.started === undefined) {
      if (!start_native(actor, task)) {
        return
      }
    }

    const before = task.output_count_before ?? 0
    const expected = task.expected_output_delta ?? task.started ?? task.count
    const produced = math.max(0, output_count(actor, task.item_name) - before)
    task.crafted = math.min(task.started ?? task.count, produced)

    const queue = actor.get_crafting_queue()
    if (queue.length === 0) {
      task.owns_native_queue = false
      if (produced >= expected) {
        complete(actor, task)
      }
      else {
        fail(actor, task, 'output_missing', false)
      }
      return
    }

    if (task.started_tick !== undefined && game.tick - task.started_tick > MAX_CRAFT_TICKS) {
      fail(actor, task, 'timeout')
    }
  }

  function status() {
    const actor = get_actor()
    const task = manager.player_state.parameters_craft_item
    return {
      task_active: manager.player_state.task_state === TaskStates.CRAFTING,
      actor: actor?.status_snapshot(),
      native_queue: actor?.get_crafting_queue().slice(0, 16),
      persisted_owner: storage.airi_owned_crafting,
      last_result: storage.airi_last_crafting_result,
    }
  }

  manager.register_cancel_handler(TaskStates.CRAFTING, () => {
    const task = manager.player_state.parameters_craft_item
    if (!task || task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined) {
      return
    }

    const actor = get_actor()
    if (!actor || !identity_matches(actor, task)) {
      return
    }

    const before = task.output_count_before ?? output_count(actor, task.item_name)
    const expected = task.expected_output_delta ?? task.started ?? task.count
    const produced = math.max(0, output_count(actor, task.item_name) - before)
    if (task.started !== undefined && actor.get_crafting_queue().length === 0 && produced >= expected) {
      clear_owned_marker(task)
      task.owns_native_queue = false
      record(actor, task, true, true, 'completed')
      return
    }

    cancel_owned_native_queue(actor, task)
    clear_owned_marker(task)
    record(actor, task, false, false, 'cancelled')
  })

  return { submit, tick, status }
}
