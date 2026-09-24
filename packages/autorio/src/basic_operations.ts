import type { ControlledActor } from './actors/types'
import type { new_task_manager } from './task_manager'
import type {
  PlayerParametersLaunchRocket,
  PlayerParametersMineEntity,
  PlayerParametersMoveItems,
  PlayerParametersPlaceEntity,
  PlayerParametersRotateEntity,
  PlayerParametersSetRecipe,
  PlayerParametersWaiting,
} from './types'
import { TaskStates } from './types'

type BasicTask = PlayerParametersMineEntity | PlayerParametersPlaceEntity | PlayerParametersRotateEntity | PlayerParametersMoveItems | PlayerParametersSetRecipe | PlayerParametersLaunchRocket | PlayerParametersWaiting
type BasicOperationCode = 'queued' | 'completed' | 'cancelled'
  | 'no_actor' | 'invalid_count' | 'invalid_ticks' | 'invalid_max_count' | 'invalid_position' | 'invalid_direction' | 'invalid_unit_number' | 'invalid_recipe' | 'invalid_reverse'
  | 'actor_changed' | 'no_target' | 'target_gone' | 'no_inventory' | 'wrong_force'
  | 'invalid_entity' | 'unknown_entity' | 'not_item_placeable' | 'ambiguous_placement_item' | 'invalid_placement_item'
  | 'item_missing' | 'no_position' | 'not_placeable' | 'create_failed'
  | 'nothing_moved' | 'player_unavailable' | 'different_surface' | 'too_far'
  | 'mining_rejected'
  | 'not_rotatable' | 'rotation_failed'
  | 'not_recipe_machine' | 'recipe_disabled' | 'incompatible_recipe' | 'set_recipe_failed'
  | 'not_rocket_silo' | 'rocket_not_ready' | 'launch_failed' | 'launch_not_confirmed'

export interface BasicOperationResult {
  operation_id?: number
  type?: TaskStates
  accepted: boolean
  completed: boolean
  code: BasicOperationCode
  tick: number
  actor_id?: number
  actor_kind?: string
  force_index?: number
  entity_name?: string
  target_unit_number?: number
  recipe_name?: string
  player_name?: string
  item_name?: string
  requested_count?: number
  moved_count?: number
  to_entity?: boolean
  to_player?: boolean
  requested_ticks?: number
  requested_position?: { x: number, y: number }
  direction?: number
  placed_unit_number?: number
  placed_entity_type?: string
  placed_position?: { x: number, y: number }
  placed_surface_index?: number
  placed_direction?: number
  previous_direction?: number
  reverse?: boolean
  rocket_silo_status?: number
  rocket_parts?: number
  rocket_parts_required?: number
  rockets_launched?: number
}

declare const storage: {
  airi_next_basic_operation_id?: number
  airi_last_basic_operation_result?: BasicOperationResult
}

function owner(task: BasicTask) {
  return {
    actor_id: task.owner_actor_id,
    actor_kind: task.owner_actor_kind,
    force_index: task.owner_force_index,
  }
}

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function valid_coordinate(value: number) {
  return typeof value === 'number' && value === value && value >= -1000000 && value <= 1000000
}

function valid_name(value: string) {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200
}

function next_operation_id() {
  const next = (storage.airi_next_basic_operation_id ?? 0) + 1
  storage.airi_next_basic_operation_id = next
  return next
}

function bind(task: BasicTask, actor: ControlledActor) {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return false
  }
  task.operation_id = next_operation_id()
  task.owner_actor_id = identity.actor_id
  task.owner_actor_kind = identity.kind
  task.owner_force_index = actor.force.index
  return true
}

export function basic_identity_matches(actor: ControlledActor, task: BasicTask) {
  if (task.owner_actor_id === undefined || task.owner_actor_kind === undefined || task.owner_force_index === undefined) {
    return false
  }
  const identity = actor.status_snapshot()
  return identity.actor_id === task.owner_actor_id
    && identity.kind === task.owner_actor_kind
    && actor.force.index === task.owner_force_index
}

function result_for(actor: ControlledActor | undefined, task: BasicTask | undefined, accepted: boolean, completed: boolean, code: BasicOperationCode, details: Partial<BasicOperationResult> = {}) {
  const identity = actor?.is_valid ? actor.status_snapshot() : undefined
  const bound = task ? owner(task) : undefined
  const result: BasicOperationResult = {
    operation_id: task?.operation_id,
    type: task?.type,
    accepted,
    completed,
    code,
    tick: game.tick,
    actor_id: bound?.actor_id ?? identity?.actor_id,
    actor_kind: bound?.actor_kind ?? identity?.kind,
    force_index: bound?.force_index ?? (actor?.is_valid ? actor.force.index : undefined),
    entity_name: task && 'entity_name' in task ? task.entity_name : undefined,
    target_unit_number: task?.type === TaskStates.MINING || task?.type === TaskStates.MOVING_ITEMS || task?.type === TaskStates.SETTING_RECIPE || task?.type === TaskStates.ROTATING || task?.type === TaskStates.LAUNCHING_ROCKET ? task.target_unit_number : undefined,
    recipe_name: task?.type === TaskStates.SETTING_RECIPE ? task.recipe_name : undefined,
    player_name: task?.type === TaskStates.MOVING_ITEMS ? task.player_name : undefined,
    item_name: task && 'item_name' in task ? task.item_name : undefined,
    requested_count: task?.type === TaskStates.MINING
      ? (task.requested_count ?? task.count)
      : task?.type === TaskStates.MOVING_ITEMS
        ? task.max_count
        : undefined,
    to_entity: task?.type === TaskStates.MOVING_ITEMS ? task.to_entity : undefined,
    to_player: task?.type === TaskStates.MOVING_ITEMS ? task.to_player : undefined,
    requested_ticks: task?.type === TaskStates.WAITING ? (task.requested_ticks ?? task.remaining_ticks) : undefined,
    requested_position: task?.type === TaskStates.PLACING && task.position
      ? { x: task.position.x, y: task.position.y }
      : task?.type === TaskStates.MINING && task.requested_position
        ? { x: task.requested_position.x, y: task.requested_position.y }
        : undefined,
    direction: task?.type === TaskStates.PLACING ? task.direction : undefined,
    reverse: task?.type === TaskStates.ROTATING ? task.reverse : undefined,
    ...details,
  }
  storage.airi_last_basic_operation_result = result
  return result
}

export function new_basic_operation_controller(get_actor: () => ControlledActor | undefined, manager: ReturnType<typeof new_task_manager>) {
  let suppress_cancel_receipt = false

  function actor_for_submission() {
    const actor = get_actor()
    if (!actor || !actor.is_valid || !actor.character || actor.status_snapshot().actor_id === undefined) {
      result_for(actor, undefined, false, false, 'no_actor')
      return undefined
    }
    return actor
  }

  function queue(task: BasicTask, actor: ControlledActor) {
    if (!bind(task, actor)) {
      result_for(actor, task, false, false, 'no_actor')
      return false
    }
    manager.add_task(task)
    result_for(actor, task, true, false, 'queued')
    return true
  }

  function submit_mining(entity_name: string, count: number = 1) {
    if (!valid_integer(count, 1, 1000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_count')
      return false
    }
    const actor = actor_for_submission()
    if (!actor) return false
    const task: PlayerParametersMineEntity = {
      type: TaskStates.MINING,
      entity_name,
      count,
      requested_count: count,
    }
    return queue(task, actor)
  }

  function submit_mining_exact(target_unit_number: number) {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      result_for(get_actor(), undefined, false, false, 'invalid_unit_number')
      return false
    }
    const actor = actor_for_submission()
    if (!actor) return false
    const task: PlayerParametersMineEntity = {
      type: TaskStates.MINING,
      target_unit_number,
      count: 1,
      requested_count: 1,
    }
    return queue(task, actor)
  }

  function submit_mining_at(resource_name: string, x: number, y: number, count: number = 1) {
    if (!valid_name(resource_name)) {
      result_for(get_actor(), undefined, false, false, 'invalid_entity')
      return false
    }
    const prototype = prototypes.entity[resource_name]
    if (!prototype || prototype.type !== 'resource') {
      result_for(get_actor(), undefined, false, false, 'invalid_entity')
      return false
    }
    if (!valid_coordinate(x) || !valid_coordinate(y)) {
      result_for(get_actor(), undefined, false, false, 'invalid_position')
      return false
    }
    if (!valid_integer(count, 1, 1000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_count')
      return false
    }
    const actor = actor_for_submission()
    if (!actor) return false
    const task: PlayerParametersMineEntity = {
      type: TaskStates.MINING,
      entity_name: resource_name,
      requested_position: { x, y },
      count,
      requested_count: count,
    }
    return queue(task, actor)
  }

  function submit_placement(entity_name: string, x?: number, y?: number, direction?: number) {
    const has_x = x !== undefined
    const has_y = y !== undefined
    if (has_x !== has_y || (has_x && (!valid_coordinate(x!) || !valid_coordinate(y!)))) {
      result_for(get_actor(), undefined, false, false, 'invalid_position')
      return false
    }
    if (direction !== undefined && !valid_integer(direction, 0, 15)) {
      result_for(get_actor(), undefined, false, false, 'invalid_direction')
      return false
    }
    const actor = actor_for_submission()
    if (!actor) return false
    const task: PlayerParametersPlaceEntity = {
      type: TaskStates.PLACING,
      entity_name,
      position: has_x ? { x: x!, y: y! } : undefined,
      direction,
    }
    return queue(task, actor)
  }

  function submit_rotate_exact(target_unit_number: number, reverse: boolean = false): [boolean, string] {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      result_for(get_actor(), undefined, false, false, 'invalid_unit_number')
      return [false, 'unit_number must be a positive safe integer']
    }
    if (typeof reverse !== 'boolean') {
      result_for(get_actor(), undefined, false, false, 'invalid_reverse')
      return [false, 'reverse must be boolean']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersRotateEntity = {
      type: TaskStates.ROTATING,
      target_unit_number,
      reverse,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_move(item_name: string, entity_name: string, max_count: number, to_entity: boolean): [boolean, string] {
    if (!valid_integer(max_count, 1, 100000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_max_count')
      return [false, 'max_count must be an integer from 1 to 100000']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersMoveItems = {
      type: TaskStates.MOVING_ITEMS,
      item_name,
      entity_name,
      max_count,
      to_entity,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_move_exact(item_name: string, target_unit_number: number, max_count: number, to_entity: boolean): [boolean, string] {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      result_for(get_actor(), undefined, false, false, 'invalid_unit_number')
      return [false, 'unit_number must be a positive safe integer']
    }
    if (!valid_integer(max_count, 1, 100000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_max_count')
      return [false, 'max_count must be an integer from 1 to 100000']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersMoveItems = {
      type: TaskStates.MOVING_ITEMS,
      item_name,
      target_unit_number,
      max_count,
      to_entity,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_set_recipe_exact(target_unit_number: number, recipe_name: string): [boolean, string] {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      result_for(get_actor(), undefined, false, false, 'invalid_unit_number')
      return [false, 'unit_number must be a positive safe integer']
    }
    if (!valid_name(recipe_name)) {
      result_for(get_actor(), undefined, false, false, 'invalid_recipe')
      return [false, 'recipe_name must be a valid Factorio recipe name']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersSetRecipe = {
      type: TaskStates.SETTING_RECIPE,
      target_unit_number,
      recipe_name,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_launch_rocket_exact(target_unit_number: number): [boolean, string] {
    if (!valid_integer(target_unit_number, 1, 9007199254740991)) {
      result_for(get_actor(), undefined, false, false, 'invalid_unit_number')
      return [false, 'unit_number must be a positive safe integer']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersLaunchRocket = {
      type: TaskStates.LAUNCHING_ROCKET,
      target_unit_number,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_player_move(item_name: string, player_name: string, max_count: number, to_player: boolean): [boolean, string] {
    if (!valid_integer(max_count, 1, 100000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_max_count')
      return [false, 'max_count must be an integer from 1 to 100000']
    }
    if (typeof player_name !== 'string' || player_name.length === 0) {
      result_for(get_actor(), undefined, false, false, 'player_unavailable')
      return [false, 'player_name is required']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersMoveItems = {
      type: TaskStates.MOVING_ITEMS,
      item_name,
      player_name,
      max_count,
      to_player,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function submit_wait(ticks: number): [boolean, string] {
    if (!valid_integer(ticks, 1, 360000)) {
      result_for(get_actor(), undefined, false, false, 'invalid_ticks')
      return [false, 'ticks must be an integer from 1 to 360000']
    }
    const actor = actor_for_submission()
    if (!actor) return [false, 'No controlled actor']
    const task: PlayerParametersWaiting = {
      type: TaskStates.WAITING,
      remaining_ticks: ticks,
      requested_ticks: ticks,
    }
    if (!queue(task, actor)) return [false, 'No controlled actor']
    return [true, 'Task started']
  }

  function complete(actor: ControlledActor, task: BasicTask, details: Partial<BasicOperationResult> = {}) {
    result_for(actor, task, true, true, 'completed', details)
    manager.reset_task_state()
    manager.next_task()
  }

  function fail(actor: ControlledActor | undefined, task: BasicTask, code: BasicOperationCode, details: Partial<BasicOperationResult> = {}) {
    suppress_cancel_receipt = true
    manager.cancel_all_tasks(`${task.type}:${code}`)
    suppress_cancel_receipt = false
    result_for(actor, task, false, false, code, details)
    log(`[AUTORIO] [ERROR] ${task.type} failed: ${code}; dependent operations cancelled`)
  }

  function register_cancel(state: TaskStates.MINING | TaskStates.PLACING | TaskStates.ROTATING | TaskStates.MOVING_ITEMS | TaskStates.SETTING_RECIPE | TaskStates.LAUNCHING_ROCKET | TaskStates.WAITING, get_task: () => BasicTask | undefined) {
    manager.register_cancel_handler(state, () => {
      if (suppress_cancel_receipt) return
      const task = get_task()
      if (!task) return
      const actor = get_actor()
      result_for(actor, task, false, false, 'cancelled')
    })
  }

  register_cancel(TaskStates.MINING, () => manager.player_state.parameters_mine_entity)
  register_cancel(TaskStates.PLACING, () => manager.player_state.parameters_place_entity)
  register_cancel(TaskStates.ROTATING, () => manager.player_state.parameters_rotate_entity)
  register_cancel(TaskStates.MOVING_ITEMS, () => manager.player_state.parameters_move_items)
  register_cancel(TaskStates.SETTING_RECIPE, () => manager.player_state.parameters_set_recipe)
  register_cancel(TaskStates.LAUNCHING_ROCKET, () => manager.player_state.parameters_launch_rocket)
  register_cancel(TaskStates.WAITING, () => manager.player_state.parameters_waiting)

  function status() {
    return {
      last_result: storage.airi_last_basic_operation_result,
      next_operation_id: storage.airi_next_basic_operation_id ?? 0,
    }
  }

  return {
    submit_mining,
    submit_mining_exact,
    submit_mining_at,
    submit_placement,
    submit_rotate_exact,
    submit_move,
    submit_move_exact,
    submit_set_recipe_exact,
    submit_launch_rocket_exact,
    submit_player_move,
    submit_wait,
    complete,
    fail,
    status,
    identity_matches: basic_identity_matches,
  }
}
