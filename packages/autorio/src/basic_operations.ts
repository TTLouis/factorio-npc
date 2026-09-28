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
  placement_footprint?: {
    tile_width: number
    tile_height: number
    tile_box: { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }
    world_box: { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }
  }
  placement_grid?: { x_offset: number, y_offset: number, nearest_valid_center?: { x: number, y: number } }
  placement_blockers?: Array<{ name: string, type: string, unit_number?: number, position: { x: number, y: number } }>
  previous_direction?: number
  reverse?: boolean
  rocket_silo_status?: number
  rocket_parts?: number
  rocket_parts_required?: number
  rockets_launched?: number
  /** Item moves: how many of the item the NPC held when the move ran. */
  held_count?: number
  /** Refused item moves: the concrete reason the target took none. */
  refusal_cause?: TransferRefusalCause
  /** Refused item moves: the target's inventories and what occupies them. */
  target_inventories?: TransferInventorySnapshot[]
  /** A refused move's receipt is republished when its batch closes; this is the tick it was refused. */
  refusal_tick?: number
  /** Present on a republished refusal: how many operations of its batch were refused. */
  batch_refused_count?: number
}

/**
 * Why a to-entity item move moved nothing although the NPC held the item.
 * - target_full: an inventory that takes the item already holds it and has no room left.
 * - input_slot_holds_other_item: the inventory that would take the item is filled by another item
 *   (for example copper ore in a furnace source slot when iron ore is supplied).
 * - no_input_inventory_for_item: the entity has no input inventory for this item at all
 *   (for example ore into a boiler, whose only input is fuel).
 * - target_rejects_item: an input inventory has free slots but still rejects the item.
 */
export type TransferRefusalCause = 'target_full' | 'input_slot_holds_other_item' | 'no_input_inventory_for_item' | 'target_rejects_item'

export interface TransferInventorySnapshot {
  unit_number?: number
  index?: number
  name?: string
  /** input and fuel inventories are insert targets; output and burnt_result never are. */
  role: 'input' | 'fuel' | 'output' | 'burnt_result'
  slot_count: number
  empty_slots: number
  can_insert: boolean
  contents: Array<{ name: string, quality?: string, count: number }>
}

/**
 * One-line cause of a refused item move for logs and the runtime's error
 * text: cause, item, target, held and requested counts, and what occupies the
 * target's input/fuel slots.
 */
export function transfer_refusal_summary(result: BasicOperationResult) {
  const parts = [
    `cause=${result.refusal_cause ?? 'unknown'}`,
    `item=${result.item_name ?? 'unknown'}`,
    `target=${result.target_unit_number ?? result.entity_name ?? 'unknown'}`,
    `held=${result.held_count ?? 'unknown'}`,
    `requested=${result.requested_count ?? 'unknown'}`,
  ]
  const slots: string[] = []
  for (const inventory of result.target_inventories ?? []) {
    if ((inventory.role !== 'input' && inventory.role !== 'fuel') || inventory.slot_count <= 0) continue
    const contents = inventory.contents.length > 0
      ? inventory.contents.map(item => `${item.name} x${item.count}`).join(',')
      : 'empty'
    slots.push(`${inventory.name ?? `inventory_${inventory.index ?? 'unknown'}`}[${contents}]`)
  }
  if (slots.length > 0) parts.push(`slots=${slots.join(' ')}`)
  return parts.join(' ')
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

  // Full receipts of refused operations in the active batch, keyed by
  // operation_id, republished when the batch closes.
  let refusal_results: Record<number, BasicOperationResult> = {}

  /**
   * A to-entity item move the target refused: nothing moved and the items are
   * still held, so no later operation lost anything it needed. Record the
   * receipt and advance to the next queued operation instead of cancelling
   * the batch; the batch closes as refused once it drains.
   */
  function refuse(actor: ControlledActor, task: PlayerParametersMoveItems, code: BasicOperationCode, details: Partial<BasicOperationResult> = {}) {
    const result = result_for(actor, task, false, false, code, details)
    const recorded = manager.record_refusal({
      operation_id: task.operation_id,
      type: task.type,
      code,
      cause: details.refusal_cause,
      item_name: task.item_name,
      target_unit_number: task.target_unit_number,
      held_count: details.held_count,
      tick: result.tick,
    })
    if (!recorded) {
      fail(actor, task, code, details)
      return
    }
    if (task.operation_id !== undefined) refusal_results[task.operation_id] = result
    log(`[AUTORIO] ${task.type} refused: ${code}; ${transfer_refusal_summary(result)}; independent operations in the batch continue`)
    manager.reset_task_state()
    manager.next_task()
  }

  manager.register_refused_batch_handler((refusals, receipt) => {
    const first = refusals[0]
    const original = first.operation_id !== undefined ? refusal_results[first.operation_id] : undefined
    refusal_results = {}
    // The batch receipt closes on this tick; republish the first refusal so
    // the runtime correlates it with the batch (task type, tick, actor).
    const published: BasicOperationResult | undefined = original
      ? { ...original, tick: game.tick, refusal_tick: original.tick, batch_refused_count: refusals.length }
      : undefined
    if (published) storage.airi_last_basic_operation_result = published
    const summary = published ? transfer_refusal_summary(published) : `cause=${first.cause ?? 'unknown'}`
    log(`[AUTORIO] [ERROR] ${first.type} refused: ${first.code}; ${summary}; ${refusals.length} of ${receipt.task_count} operations refused, ${receipt.completed_count ?? 0} completed; independent operations were not cancelled`)
  })

  function fail(actor: ControlledActor | undefined, task: BasicTask, code: BasicOperationCode, details: Partial<BasicOperationResult> = {}) {
    refusal_results = {}
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
    refuse,
    status,
    identity_matches: basic_identity_matches,
  }
}
