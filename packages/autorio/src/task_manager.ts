import type { ControlledActor } from './actors/types'
import { register_actor_mode_transition_handler, register_npc_recovery_handler, register_npc_single_player_load_handler } from './actors/actor_controller'
import { is_runtime_task_state, unsupported_task_state_reason } from './task_state_runtime'
import type { PlayerParameters, PlayerState } from './types'
import { TaskStates } from './types'
import { pinned_operation_batch_refs } from './operation_admission'

export interface TaskBatchIdentity {
  batch_id: number
  batch_generation: number
  batch_ref: string
}

/**
 * One operation the target refused without changing the world (an item move
 * the entity would not take). The batch keeps running its independent
 * operations; the refusal is reported when the batch closes.
 */
export interface TaskBatchRefusal {
  operation_id?: number
  type: TaskStates
  code: string
  cause?: string
  item_name?: string
  target_unit_number?: number
  held_count?: number
  tick: number
}

export interface TaskBatchReceipt extends TaskBatchIdentity {
  state?: 'completed' | 'cancelled' | 'uncertain'
  task_count: number
  task_types: TaskStates[]
  tick: number
  reason?: string
  /** Present only when an operation in the batch was refused. */
  outcome?: 'refused' | 'cancelled'
  refused_count?: number
  completed_count?: number
  refusals?: TaskBatchRefusal[]
  /**
   * Tasks of this batch the runtime had activated (taken off the queue) when
   * the batch closed. Queued tasks beyond this count never began.
   */
  started_count?: number
  /**
   * Set only on a cancellation whose failing task is known to have changed
   * nothing in the world (a placement the engine refused before creating it).
   * With started_count === 1 that proves no task of the batch had any effect.
   */
  failed_before_mutation?: boolean
}

export interface TaskCancelProof {
  failed_before_mutation: boolean
}

const MAX_RECEIPT_REFUSALS = 8

interface TaskExecutionState {
  player_state: PlayerState
  task_queue: PlayerParameters[]
  active_batch_id?: number
  active_batch_task_types: TaskStates[]
  active_batch_console_quiet: boolean
  last_completed_batch?: TaskBatchReceipt
  last_cancelled_batch?: TaskBatchReceipt
  active_batch_refusals: TaskBatchRefusal[]
  active_batch_started: number
  tasks_added_total: number
}

function empty_execution(): TaskExecutionState {
  return { player_state: { task_state: TaskStates.IDLE }, task_queue: [],
    active_batch_task_types: [], active_batch_console_quiet: false,
    active_batch_refusals: [], active_batch_started: 0, tasks_added_total: 0 }
}

declare const storage: {
  sgluna_task_batch_sequence?: number
  sgluna_task_batch_generation?: number
  sgluna_task_receipt_journal?: TaskBatchReceipt[]
  sgluna_task_active_batch?: TaskBatchReceipt
  sgluna_task_execution?: TaskExecutionState
  sgluna_task_startup_session?: string
}

const MAX_RECEIPT_HISTORY = 128
const MAX_PINNED_RECEIPTS = 1024

function receipt_journal() {
  if (!storage.sgluna_task_receipt_journal) storage.sgluna_task_receipt_journal = []
  return storage.sgluna_task_receipt_journal
}

function retain_receipt(receipt: TaskBatchReceipt) {
  const journal = receipt_journal()
  const old = journal.findIndex(entry => entry.batch_ref === receipt.batch_ref)
  if (old >= 0) journal[old] = receipt
  else journal.push(receipt)
  const pinned = pinned_operation_batch_refs()
  let unpinned = journal.filter(entry => !pinned.includes(entry.batch_ref)).length
  for (let index = 0; index < journal.length && unpinned > MAX_RECEIPT_HISTORY;) {
    if (!pinned.includes(journal[index].batch_ref)) { journal.splice(index, 1); unpinned-- }
    else index++
  }
}

const MAX_SAFE_COUNTER = 9007199254740990

export function new_task_manager(get_controlled_actor: () => ControlledActor | undefined) {
  // A joining peer must resume the exact server execution state. Only handlers
  // remain local; native queue snapshots and all decisions live in storage.
  // Do not access storage during module initialization / on_load.
  const empty_state = empty_execution()
  function execution() { return storage.sgluna_task_execution ?? empty_state }
  function initialize() {
    if (!storage.sgluna_task_execution) storage.sgluna_task_execution = empty_state
  }
  const cancel_handlers: Partial<Record<TaskStates, () => void>> = {}
  let refused_batch_handler: ((refusals: TaskBatchRefusal[], receipt: TaskBatchReceipt) => void) | undefined

  function is_routine_follow_task(task: PlayerParameters) {
    return task.type === TaskStates.WALKING_TO_ENTITY && task.persistent_follow === true
  }

  function valid_persisted_counter(value: unknown): value is number {
    return typeof value === 'number'
      && value === math.floor(value)
      && value >= 0
      && value <= MAX_SAFE_COUNTER
  }

  function ensure_batch_generation() {
    return valid_persisted_counter(storage.sgluna_task_batch_generation)
      ? storage.sgluna_task_batch_generation : 1
  }

  // Called once per actual server deployment session through a replicated
  // command. Loading the map on another client never advances this generation.
  function reconcile_startup(deployment_session: string) {
    if (typeof deployment_session !== 'string' || deployment_session.length < 1 || deployment_session.length > 192)
      return { ok: false, reason: 'invalid_deployment_session' }
    if (storage.sgluna_task_startup_session === deployment_session)
      return { ok: true, reconciled: false, batch_generation: ensure_batch_generation() }
    const interrupted = storage.sgluna_task_active_batch
    if (interrupted) retain_receipt({ ...interrupted, state: 'uncertain', reason: 'save_load_unfinished', tick: game.tick })
    storage.sgluna_task_active_batch = undefined
    storage.sgluna_task_execution = empty_execution()
    const previous = valid_persisted_counter(storage.sgluna_task_batch_generation) ? storage.sgluna_task_batch_generation : 0
    storage.sgluna_task_batch_generation = previous + 1
    storage.sgluna_task_startup_session = deployment_session
    for (const receipt of storage.sgluna_task_receipt_journal ?? []) {
      if (receipt.state === 'completed') execution().last_completed_batch = receipt
      if (receipt.state === 'cancelled') execution().last_cancelled_batch = receipt
    }
    log(`[AUTORIO] task.startup_reconciled request_id=${deployment_session} reason=server_startup batch_generation=${storage.sgluna_task_batch_generation}`)
    return { ok: true, reconciled: true, batch_generation: storage.sgluna_task_batch_generation }
  }

  function batch_ref(batch_id: number) {
    return `batch-g${ensure_batch_generation()}-${batch_id}`
  }

  function next_batch_id() {
    const previous = valid_persisted_counter(storage.sgluna_task_batch_sequence)
      ? storage.sgluna_task_batch_sequence
      : 0
    const next = previous + 1
    storage.sgluna_task_batch_sequence = next
    return next
  }

  function begin_or_extend_batch(task: PlayerParameters) {
    const created = execution().active_batch_id === undefined
    const quiet_task = is_routine_follow_task(task)
    if (created) {
      initialize()
      storage.sgluna_task_batch_generation = ensure_batch_generation()
      const pinned = pinned_operation_batch_refs()
      if (receipt_journal().filter(receipt => pinned.includes(receipt.batch_ref)).length >= MAX_PINNED_RECEIPTS) {
        error('receipt_journal_full')
      }
      execution().active_batch_id = next_batch_id()
      execution().active_batch_task_types = []
      execution().active_batch_console_quiet = quiet_task
      execution().active_batch_refusals = []
      execution().active_batch_started = 0
    }
    else if (!quiet_task) {
      execution().active_batch_console_quiet = false
    }
    execution().active_batch_task_types.push(task.type)
    storage.sgluna_task_active_batch = {
      batch_id: execution().active_batch_id!, batch_generation: ensure_batch_generation(), batch_ref: batch_ref(execution().active_batch_id!),
      task_count: execution().active_batch_task_types.length, task_types: execution().active_batch_task_types.slice(0, 64), tick: game.tick,
    }
    return created
  }

  function close_batch(kind: 'completed' | 'cancelled' | 'refused', reason?: string, proof?: TaskCancelProof) {
    if (execution().active_batch_id === undefined) return undefined
    const receipt: TaskBatchReceipt = {
      batch_id: execution().active_batch_id!,
      batch_generation: ensure_batch_generation(),
      batch_ref: batch_ref(execution().active_batch_id!),
      task_count: execution().active_batch_task_types.length,
      task_types: execution().active_batch_task_types.slice(0, 64),
      tick: game.tick,
      reason,
      started_count: execution().active_batch_started,
    }
    if (kind === 'cancelled' && proof?.failed_before_mutation === true) receipt.failed_before_mutation = true
    // Refusals ride on whichever receipt closes the batch, so a later hard
    // failure that cancels the rest does not hide an earlier refusal.
    if (execution().active_batch_refusals.length > 0) {
      receipt.outcome = kind === 'refused' ? 'refused' : 'cancelled'
      receipt.refused_count = execution().active_batch_refusals.length
      // Every other operation ran to completion only when the batch drained;
      // a cancellation stops the rest, so no completed count is claimed then.
      if (kind === 'refused') receipt.completed_count = receipt.task_count - execution().active_batch_refusals.length
      receipt.refusals = execution().active_batch_refusals.slice(0, MAX_RECEIPT_REFUSALS)
    }
    // A batch with a refused operation is not a clean completion: it is
    // published where failed batches go, so the runtime's failure path (not
    // its completion verifier) reads it.
    if (kind === 'completed') execution().last_completed_batch = receipt
    else execution().last_cancelled_batch = receipt
    retain_receipt({ ...receipt, state: kind === 'completed' ? 'completed' : 'cancelled' })
    storage.sgluna_task_active_batch = undefined
    execution().active_batch_id = undefined
    execution().active_batch_task_types = []
    execution().active_batch_console_quiet = false
    execution().active_batch_refusals = []
    execution().active_batch_started = 0
    return receipt
  }

  function receipt_details(receipt: TaskBatchReceipt) {
    const reason = receipt.reason ? `, reason=${receipt.reason}` : ''
    const refused = receipt.refused_count === undefined
      ? ''
      : receipt.completed_count === undefined
        ? `, refused=${receipt.refused_count}`
        : `, refused=${receipt.refused_count}, completed=${receipt.completed_count}`
    return `batch=${receipt.batch_id}, task_count=${receipt.task_count}, tasks=${receipt.task_types.join(',') || 'none'}, tick=${receipt.tick}${reason}${refused}`
  }

  /**
   * Record an operation the target refused without changing the world. The
   * caller then advances to the next queued task instead of cancelling the
   * batch; the batch closes as refused once its queue drains.
   */
  function record_refusal(refusal: TaskBatchRefusal) {
    initialize()
    if (execution().active_batch_id === undefined) return false
    execution().active_batch_refusals.push(refusal)
    return true
  }

  function register_refused_batch_handler(handler: (refusals: TaskBatchRefusal[], receipt: TaskBatchReceipt) => void) {
    refused_batch_handler = handler
  }

  function close_refused_batch() {
    const refusals = [...execution().active_batch_refusals]
    const first = refusals[0]
    const cause = first.cause ? `:${first.cause}` : ''
    const receipt = close_batch('refused', `${first.type}:${first.code}${cause}`)
    if (!receipt) return
    const details = receipt_details(receipt)
    game.print(`[AUTORIO] Operation batch refused: ${details}`)
    log(`[AUTORIO] Operation batch refused: ${details}`)
    if (refused_batch_handler) refused_batch_handler(refusals, receipt)
  }

  function add_task(task: PlayerParameters) {
    initialize()
    const new_batch = begin_or_extend_batch(task)
    execution().tasks_added_total++
    execution().task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, batch=${execution().active_batch_id}, task queue length: ${execution().task_queue.length}`)
    if (new_batch) {
      const details = `batch=${execution().active_batch_id}, first_task=${task.type}, tick=${game.tick}`
      if (!execution().active_batch_console_quiet) game.print(`[AUTORIO] Operation batch started: ${details}`)
      log(`[AUTORIO] Operation batch started: ${details}`)
    }

    if (execution().task_queue.length === 1) {
      next_task()
    }
  }

  function register_cancel_handler(state: TaskStates, handler: () => void) {
    cancel_handlers[state] = handler
  }

  function run_cancel_cleanup() {
    const handler = cancel_handlers[execution().player_state.task_state]
    if (handler) handler()
  }

  function stop_task_controls() {
    const state = execution().player_state.task_state
    const stop_walking = state === TaskStates.WALKING_TO_ENTITY
      || state === TaskStates.WALKING_DIRECT
      || state === TaskStates.ATTACKING
    const stop_mining = state === TaskStates.MINING || state === TaskStates.HARVESTING || state === TaskStates.CLEARING_AREA
    const stop_shooting = state === TaskStates.ATTACKING
    if (!stop_walking && !stop_mining && !stop_shooting) return

    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid || !actor.character) return

    if (stop_walking) actor.set_walking_state({ walking: false, direction: defines.direction.north })
    if (stop_mining) actor.set_mining_state({ mining: false })
    if (stop_shooting) actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function stop_all_task_controls() {
    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid || !actor.character) return

    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    actor.set_mining_state({ mining: false })
    actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function clear_task_state_without_controls() {
    execution().player_state.task_state = TaskStates.IDLE
    execution().player_state.parameters_walk_to_entity = undefined
    execution().player_state.parameters_walking_direct = undefined
    execution().player_state.parameters_mine_entity = undefined
    execution().player_state.parameters_harvest_product = undefined
    execution().player_state.parameters_clear_construction_area = undefined
    execution().player_state.parameters_place_entity = undefined
    execution().player_state.parameters_rotate_entity = undefined
    execution().player_state.parameters_move_items = undefined
    execution().player_state.parameters_set_recipe = undefined
    execution().player_state.parameters_launch_rocket = undefined
    execution().player_state.parameters_craft_item = undefined
    execution().player_state.parameters_attack_nearest_enemy = undefined
    execution().player_state.parameters_research_technology = undefined
    execution().player_state.parameters_waiting = undefined
  }

  function reset_task_state() {
    initialize()
    stop_task_controls()
    clear_task_state_without_controls()
  }

  function fail_unsupported_task_state(state: unknown) {
    const reason = unsupported_task_state_reason(state)
    const queued_task_types = execution().task_queue.map(task => task.type)
    const batch_label = execution().active_batch_id === undefined ? 'none' : `${execution().active_batch_id}`
    log(`[AUTORIO] ERROR unsupported task state: state=${state}, batch=${batch_label}, queued_task_count=${execution().task_queue.length}, queued_task_types=${queued_task_types.join(',') || 'none'}, active_batch_tasks=${execution().active_batch_task_types.join(',') || 'none'}, reason=${reason}`)

    run_cancel_cleanup()
    stop_all_task_controls()
    clear_task_state_without_controls()
    execution().task_queue.length = 0

    const receipt = close_batch('cancelled', reason)
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  function assert_task_activation_exhaustive(_task: never) {}

  function next_task() {
    initialize()
    if (execution().player_state.task_state !== TaskStates.IDLE) {
      log('[AUTORIO] Task state is not IDLE, wont execute next task')
      return
    }

    const task = execution().task_queue.shift()
    if (!task) {
      execution().player_state.task_state = TaskStates.IDLE
      if (execution().active_batch_id !== undefined && execution().active_batch_refusals.length > 0) {
        close_refused_batch()
        return
      }
      const quiet_completion = execution().active_batch_id !== undefined && execution().active_batch_console_quiet
      const receipt = close_batch('completed')
      const details = receipt
        ? receipt_details(receipt)
        : `batch=none, task_count=0, tasks=none, tick=${game.tick}`
      if (!quiet_completion) game.print(`[AUTORIO] All operations completed: ${details}`)
      log(`[AUTORIO] All operations completed: ${details}`)
      return
    }

    const task_type = (task as { type: unknown }).type
    if (!is_runtime_task_state(task_type)) {
      fail_unsupported_task_state(task_type)
      return
    }

    log(`[AUTORIO] Next task: ${task.type}, batch=${execution().active_batch_id}, task queue length: ${execution().task_queue.length}`)
    if (execution().active_batch_id !== undefined) execution().active_batch_started++
    execution().player_state.task_state = task.type
    switch (task.type) {
      case TaskStates.WALKING_TO_ENTITY:
        execution().player_state.parameters_walk_to_entity = task
        break
      case TaskStates.WALKING_DIRECT:
        execution().player_state.parameters_walking_direct = task
        break
      case TaskStates.MINING:
        execution().player_state.parameters_mine_entity = task
        break
      case TaskStates.HARVESTING:
        execution().player_state.parameters_harvest_product = task
        break
      case TaskStates.CLEARING_AREA:
        execution().player_state.parameters_clear_construction_area = task
        break
      case TaskStates.PLACING:
        execution().player_state.parameters_place_entity = task
        break
      case TaskStates.ROTATING:
        execution().player_state.parameters_rotate_entity = task
        break
      case TaskStates.MOVING_ITEMS:
        execution().player_state.parameters_move_items = task
        break
      case TaskStates.SETTING_RECIPE:
        execution().player_state.parameters_set_recipe = task
        break
      case TaskStates.LAUNCHING_ROCKET:
        execution().player_state.parameters_launch_rocket = task
        break
      case TaskStates.CRAFTING:
        execution().player_state.parameters_craft_item = task
        break
      case TaskStates.ATTACKING:
        execution().player_state.parameters_attack_nearest_enemy = task
        break
      case TaskStates.RESEARCHING:
        execution().player_state.parameters_research_technology = task
        break
      case TaskStates.WAITING:
        execution().player_state.parameters_waiting = task
        break
      default:
        assert_task_activation_exhaustive(task)
        fail_unsupported_task_state(task_type)
    }
  }

  function interrupt_current_with(recovery_task: PlayerParameters, resume_task: PlayerParameters) {
    if (execution().player_state.task_state === TaskStates.IDLE) return false
    const interrupted_type = execution().player_state.task_state
    stop_task_controls()
    clear_task_state_without_controls()
    execution().task_queue.unshift(resume_task)
    execution().task_queue.unshift(recovery_task)
    log(`[AUTORIO] Temporarily interrupted ${interrupted_type} with ${recovery_task.type}; original task will resume afterward`)
    next_task()
    return true
  }

  function is_task_queue_empty() {
    return execution().task_queue.length === 0
  }

  function get_current_task_snapshot() {
    switch (execution().player_state.task_state) {
      case TaskStates.IDLE:
        return undefined
      case TaskStates.WALKING_TO_ENTITY: {
        const task = execution().player_state.parameters_walk_to_entity
        return task
          ? {
              type: task.type,
              target_kind: task.target_kind,
              entity_name: task.entity_name || undefined,
              player_name: task.target_player_name,
              target_unit_number: task.target_unit_number,
              requested_position: task.requested_position,
              reach_distance: task.reach_distance,
              search_radius: task.search_radius,
              path_index: task.path_index,
              calculating_path: task.calculating_path,
              target_position: task.target_position,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.WALKING_DIRECT: {
        const task = execution().player_state.parameters_walking_direct
        return task ? { type: task.type, target_position: task.target_position } : { type: execution().player_state.task_state }
      }
      case TaskStates.MINING: {
        const task = execution().player_state.parameters_mine_entity
        return task
          ? {
              type: task.type,
              entity_name: task.entity_name,
              target_unit_number: task.target_unit_number,
              requested_position: task.requested_position,
              count: task.count,
              position: task.position,
              last_target_amount: task.last_target_amount,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.HARVESTING: {
        const task = execution().player_state.parameters_harvest_product
        return task
          ? {
              type: task.type,
              product_name: task.product_name,
              requested_count: task.requested_count,
              verified_gain: task.verified_gain,
              search_radius: task.search_radius,
              source_names: task.source_names,
              target_name: task.target_name,
              target_position: task.target_position,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.CLEARING_AREA: {
        const task = execution().player_state.parameters_clear_construction_area
        return task
          ? {
              type: task.type,
              center: task.center,
              width: task.width,
              height: task.height,
              cleared_count: task.cleared_count,
              target_name: task.target_name,
              target_position: task.target_position,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.PLACING: {
        const task = execution().player_state.parameters_place_entity
        return task ? { type: task.type, entity_name: task.entity_name, position: task.position, direction: task.direction } : { type: execution().player_state.task_state }
      }
      case TaskStates.ROTATING: {
        const task = execution().player_state.parameters_rotate_entity
        return task ? { type: task.type, target_unit_number: task.target_unit_number, reverse: task.reverse } : { type: execution().player_state.task_state }
      }
      case TaskStates.MOVING_ITEMS: {
        const task = execution().player_state.parameters_move_items
        return task
          ? {
              type: task.type,
              item_name: task.item_name,
              entity_name: task.entity_name,
              player_name: task.player_name,
              target_unit_number: task.target_unit_number,
              max_count: task.max_count,
              to_entity: task.to_entity,
              to_player: task.to_player,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.SETTING_RECIPE: {
        const task = execution().player_state.parameters_set_recipe
        return task
          ? {
              type: task.type,
              target_unit_number: task.target_unit_number,
              recipe_name: task.recipe_name,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.LAUNCHING_ROCKET: {
        const task = execution().player_state.parameters_launch_rocket
        return task
          ? {
              type: task.type,
              target_unit_number: task.target_unit_number,
              launch_ordered: task.launch_ordered_tick !== undefined,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.CRAFTING: {
        const task = execution().player_state.parameters_craft_item
        if (!task) return { type: execution().player_state.task_state }
        const actor = get_controlled_actor()
        return {
          type: task.type,
          item_name: task.item_name,
          count: task.count,
          crafted: task.crafted,
          started: task.started,
          owns_native_queue: task.owns_native_queue ?? false,
          queued_crafts: actor?.get_crafting_queue_count(task.item_name),
        }
      }
      case TaskStates.ATTACKING: {
        const task = execution().player_state.parameters_attack_nearest_enemy
        const target = task?.target
        return task
          ? {
              type: task.type,
              search_radius: task.search_radius,
              target: target && target.valid
                ? { name: target.name, position: target.position }
                : undefined,
            }
          : { type: execution().player_state.task_state }
      }
      case TaskStates.RESEARCHING: {
        const task = execution().player_state.parameters_research_technology
        return task ? { type: task.type, technology_name: task.technology_name } : { type: execution().player_state.task_state }
      }
      case TaskStates.WAITING: {
        const task = execution().player_state.parameters_waiting
        return task ? { type: task.type, remaining_ticks: task.remaining_ticks } : { type: execution().player_state.task_state }
      }
      default:
        return { type: execution().player_state.task_state }
    }
  }

  function get_status_snapshot() {
    return {
      task_state: execution().player_state.task_state,
      batch_generation: ensure_batch_generation(),
      tasks_added: execution().tasks_added_total,
      queue_empty: execution().task_queue.length === 0,
      queue_length: execution().task_queue.length,
      queued_task_types: execution().task_queue.map(task => task.type),
      current_task: get_current_task_snapshot(),
      active_batch: execution().active_batch_id === undefined
        ? undefined
        : {
            batch_id: execution().active_batch_id,
            batch_generation: ensure_batch_generation(),
            batch_ref: batch_ref(execution().active_batch_id!),
            task_count: execution().active_batch_task_types.length,
            task_types: [...execution().active_batch_task_types],
          },
      last_completed_batch: execution().last_completed_batch,
      last_cancelled_batch: execution().last_cancelled_batch,
      receipt_journal: storage.sgluna_task_receipt_journal ?? [],
    }
  }

  function cancel_task() {
    initialize()
    run_cancel_cleanup()
    reset_task_state()
  }

  function cancel_all_tasks(reason = 'cancelled', proof?: TaskCancelProof) {
    run_cancel_cleanup()
    reset_task_state()
    execution().task_queue.length = 0
    const receipt = close_batch('cancelled', reason, proof)
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  function discard_all_tasks_after_actor_loss() {
    initialize()
    clear_task_state_without_controls()
    execution().task_queue.length = 0
    const receipt = close_batch('cancelled', 'actor_loss')
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  register_npc_single_player_load_handler(() => {
    reconcile_startup(`single-player-load/${ensure_batch_generation() + 1}`)
  })

  register_npc_recovery_handler(({ previous_actor_id }) => {
    discard_all_tasks_after_actor_loss()
    log(`[AUTORIO] Discarded active and queued work after loss of actor_id=${previous_actor_id}`)
  })

  register_actor_mode_transition_handler(({ previous_mode, next_mode }) => {
    if (execution().player_state.task_state === TaskStates.IDLE && execution().task_queue.length === 0) return
    cancel_all_tasks('actor_mode_change')
    log(`[AUTORIO] Cancelled active and queued work before actor mode change ${previous_mode} -> ${next_mode}`)
  })

  // TSTL supports class accessors, but not accessors in object literals.
  // The view is local runtime plumbing; only the plain execution table persists.
  class ExecutionView {
    get player_state() { return execution().player_state }
  }
  return Object.assign(new ExecutionView(), {
    initialize,
    reconcile_startup,
    add_task,
    next_task,
    interrupt_current_with,
    is_task_queue_empty,
    get_status_snapshot,
    reset_task_state,
    cancel_task,
    cancel_all_tasks,
    fail_unsupported_task_state,
    discard_all_tasks_after_actor_loss,
    register_cancel_handler,
    record_refusal,
    register_refused_batch_handler,
  })
}
