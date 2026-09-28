import type { ControlledActor } from './actors/types'
import { register_actor_mode_transition_handler, register_load_reconciliation_handler, register_npc_recovery_handler } from './actors/actor_controller'
import type { PlayerParameters, PlayerState } from './types'
import { TaskStates } from './types'

interface TaskBatchReceipt {
  batch_id: number
  task_count: number
  task_types: TaskStates[]
  tick: number
  reason?: string
}

interface TaskManagerState {
  player_state: PlayerState
  task_queue: PlayerParameters[]
  batch_sequence: number
  active_batch_id?: number
  active_batch_task_types: TaskStates[]
  last_completed_batch?: TaskBatchReceipt
  last_cancelled_batch?: TaskBatchReceipt
}

declare const storage: {
  autorio_task_manager?: TaskManagerState
}

// Task state must live in `storage`, not in module-local variables. A client
// joining a running multiplayer game receives `storage` from the save but runs
// control.lua fresh, so module-local task state would start IDLE/empty on the
// client while the server is mid-batch, and the next task transition desyncs.
// Only read/created from replicated event handlers, never from on_load.
function task_manager_state(): TaskManagerState {
  return storage.autorio_task_manager ??= {
    player_state: { task_state: TaskStates.IDLE },
    task_queue: [],
    batch_sequence: 0,
    active_batch_task_types: [],
  }
}

export function new_task_manager(get_controlled_actor: () => ControlledActor | undefined) {
  const tms = task_manager_state
  // Handlers are functions, so they stay module-local; every peer registers the
  // same handlers at load, which keeps them deterministic.
  const cancel_handlers: Partial<Record<TaskStates, () => void>> = {}

  function begin_or_extend_batch(task: PlayerParameters) {
    const created = tms().active_batch_id === undefined
    if (created) {
      tms().batch_sequence += 1
      tms().active_batch_id = tms().batch_sequence
      tms().active_batch_task_types = []
    }
    tms().active_batch_task_types.push(task.type)
    return created
  }

  function close_batch(kind: 'completed' | 'cancelled', reason?: string) {
    const batch_id = tms().active_batch_id
    if (batch_id === undefined) return undefined
    const receipt: TaskBatchReceipt = {
      batch_id,
      task_count: tms().active_batch_task_types.length,
      task_types: [...tms().active_batch_task_types],
      tick: game.tick,
      reason,
    }
    if (kind === 'completed') tms().last_completed_batch = receipt
    else tms().last_cancelled_batch = receipt
    tms().active_batch_id = undefined
    tms().active_batch_task_types = []
    return receipt
  }

  function receipt_details(receipt: TaskBatchReceipt) {
    const reason = receipt.reason ? `, reason=${receipt.reason}` : ''
    return `batch=${receipt.batch_id}, task_count=${receipt.task_count}, tasks=${receipt.task_types.join(',') || 'none'}, tick=${receipt.tick}${reason}`
  }

  function add_task(task: PlayerParameters) {
    const new_batch = begin_or_extend_batch(task)
    tms().task_queue.push(task)
    log(`[AUTORIO] Task added: ${task.type}, batch=${tms().active_batch_id}, task queue length: ${tms().task_queue.length}`)
    if (new_batch) {
      const details = `batch=${tms().active_batch_id}, first_task=${task.type}, tick=${game.tick}`
      game.print(`[AUTORIO] Operation batch started: ${details}`)
      log(`[AUTORIO] Operation batch started: ${details}`)
    }

    if (tms().task_queue.length === 1) {
      next_task()
    }
  }

  function register_cancel_handler(state: TaskStates, handler: () => void) {
    cancel_handlers[state] = handler
  }

  function run_cancel_cleanup() {
    const handler = cancel_handlers[tms().player_state.task_state]
    if (handler) handler()
  }

  function stop_task_controls() {
    const state = tms().player_state.task_state
    const stop_walking = state === TaskStates.WALKING_TO_ENTITY
      || state === TaskStates.WALKING_DIRECT
      || state === TaskStates.ATTACKING
    const stop_mining = state === TaskStates.MINING
    const stop_shooting = state === TaskStates.ATTACKING
    if (!stop_walking && !stop_mining && !stop_shooting) return

    const actor = get_controlled_actor()
    if (!actor || !actor.is_valid || !actor.character) return

    if (stop_walking) actor.set_walking_state({ walking: false, direction: defines.direction.north })
    if (stop_mining) actor.set_mining_state({ mining: false })
    if (stop_shooting) actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  }

  function clear_task_state_without_controls() {
    tms().player_state.task_state = TaskStates.IDLE
    tms().player_state.parameters_walk_to_entity = undefined
    tms().player_state.parameters_walking_direct = undefined
    tms().player_state.parameters_mine_entity = undefined
    tms().player_state.parameters_place_entity = undefined
    tms().player_state.parameters_rotate_entity = undefined
    tms().player_state.parameters_move_items = undefined
    tms().player_state.parameters_set_recipe = undefined
    tms().player_state.parameters_craft_item = undefined
    tms().player_state.parameters_attack_nearest_enemy = undefined
    tms().player_state.parameters_research_technology = undefined
    tms().player_state.parameters_waiting = undefined
  }

  function reset_task_state() {
    stop_task_controls()
    clear_task_state_without_controls()
  }

  function next_task() {
    if (tms().player_state.task_state !== TaskStates.IDLE) {
      log('[AUTORIO] Task state is not IDLE, wont execute next task')
      return
    }

    const task = tms().task_queue.shift()
    if (!task) {
      tms().player_state.task_state = TaskStates.IDLE
      const receipt = close_batch('completed')
      const details = receipt
        ? receipt_details(receipt)
        : `batch=none, task_count=0, tasks=none, tick=${game.tick}`
      game.print(`[AUTORIO] All operations completed: ${details}`)
      log(`[AUTORIO] All operations completed: ${details}`)
      return
    }

    log(`[AUTORIO] Next task: ${task.type}, batch=${tms().active_batch_id}, task queue length: ${tms().task_queue.length}`)
    tms().player_state.task_state = task.type
    switch (task.type) {
      case TaskStates.WALKING_TO_ENTITY:
        tms().player_state.parameters_walk_to_entity = task
        break
      case TaskStates.WALKING_DIRECT:
        tms().player_state.parameters_walking_direct = task
        break
      case TaskStates.MINING:
        tms().player_state.parameters_mine_entity = task
        break
      case TaskStates.PLACING:
        tms().player_state.parameters_place_entity = task
        break
      case TaskStates.ROTATING:
        tms().player_state.parameters_rotate_entity = task
        break
      case TaskStates.MOVING_ITEMS:
        tms().player_state.parameters_move_items = task
        break
      case TaskStates.SETTING_RECIPE:
        tms().player_state.parameters_set_recipe = task
        break
      case TaskStates.CRAFTING:
        tms().player_state.parameters_craft_item = task
        break
      case TaskStates.ATTACKING:
        tms().player_state.parameters_attack_nearest_enemy = task
        break
      case TaskStates.RESEARCHING:
        tms().player_state.parameters_research_technology = task
        break
      case TaskStates.WAITING:
        tms().player_state.parameters_waiting = task
        break
    }
  }

  function interrupt_current_with(recovery_task: PlayerParameters, resume_task: PlayerParameters) {
    if (tms().player_state.task_state === TaskStates.IDLE) return false
    const interrupted_type = tms().player_state.task_state
    stop_task_controls()
    clear_task_state_without_controls()
    tms().task_queue.unshift(resume_task)
    tms().task_queue.unshift(recovery_task)
    log(`[AUTORIO] Temporarily interrupted ${interrupted_type} with ${recovery_task.type}; original task will resume afterward`)
    next_task()
    return true
  }

  function is_task_queue_empty() {
    return tms().task_queue.length === 0
  }

  function get_current_task_snapshot() {
    switch (tms().player_state.task_state) {
      case TaskStates.IDLE:
        return undefined
      case TaskStates.WALKING_TO_ENTITY: {
        const task = tms().player_state.parameters_walk_to_entity
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
          : { type: tms().player_state.task_state }
      }
      case TaskStates.WALKING_DIRECT: {
        const task = tms().player_state.parameters_walking_direct
        return task ? { type: task.type, target_position: task.target_position } : { type: tms().player_state.task_state }
      }
      case TaskStates.MINING: {
        const task = tms().player_state.parameters_mine_entity
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
          : { type: tms().player_state.task_state }
      }
      case TaskStates.PLACING: {
        const task = tms().player_state.parameters_place_entity
        return task ? { type: task.type, entity_name: task.entity_name, position: task.position, direction: task.direction } : { type: tms().player_state.task_state }
      }
      case TaskStates.ROTATING: {
        const task = tms().player_state.parameters_rotate_entity
        return task ? { type: task.type, target_unit_number: task.target_unit_number, reverse: task.reverse } : { type: tms().player_state.task_state }
      }
      case TaskStates.MOVING_ITEMS: {
        const task = tms().player_state.parameters_move_items
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
          : { type: tms().player_state.task_state }
      }
      case TaskStates.SETTING_RECIPE: {
        const task = tms().player_state.parameters_set_recipe
        return task
          ? {
              type: task.type,
              target_unit_number: task.target_unit_number,
              recipe_name: task.recipe_name,
            }
          : { type: tms().player_state.task_state }
      }
      case TaskStates.CRAFTING: {
        const task = tms().player_state.parameters_craft_item
        if (!task) return { type: tms().player_state.task_state }
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
        const task = tms().player_state.parameters_attack_nearest_enemy
        const target = task?.target
        return task
          ? {
              type: task.type,
              search_radius: task.search_radius,
              target: target && target.valid
                ? { name: target.name, position: target.position }
                : undefined,
            }
          : { type: tms().player_state.task_state }
      }
      case TaskStates.RESEARCHING: {
        const task = tms().player_state.parameters_research_technology
        return task ? { type: task.type, technology_name: task.technology_name } : { type: tms().player_state.task_state }
      }
      case TaskStates.WAITING: {
        const task = tms().player_state.parameters_waiting
        return task ? { type: task.type, remaining_ticks: task.remaining_ticks } : { type: tms().player_state.task_state }
      }
      default:
        return { type: tms().player_state.task_state }
    }
  }

  function get_status_snapshot() {
    return {
      task_state: tms().player_state.task_state,
      queue_empty: tms().task_queue.length === 0,
      queue_length: tms().task_queue.length,
      queued_task_types: tms().task_queue.map(task => task.type),
      current_task: get_current_task_snapshot(),
      active_batch: tms().active_batch_id === undefined
        ? undefined
        : {
            batch_id: tms().active_batch_id,
            task_count: tms().active_batch_task_types.length,
            task_types: [...tms().active_batch_task_types],
          },
      last_completed_batch: tms().last_completed_batch,
      last_cancelled_batch: tms().last_cancelled_batch,
    }
  }

  function cancel_task() {
    run_cancel_cleanup()
    reset_task_state()
  }

  function cancel_all_tasks(reason = 'cancelled') {
    run_cancel_cleanup()
    reset_task_state()
    tms().task_queue.length = 0
    const receipt = close_batch('cancelled', reason)
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  function discard_all_tasks_after_actor_loss() {
    clear_task_state_without_controls()
    tms().task_queue.length = 0
    const receipt = close_batch('cancelled', 'actor_loss')
    if (receipt) {
      const details = receipt_details(receipt)
      game.print(`[AUTORIO] Operation batch cancelled: ${details}`)
      log(`[AUTORIO] Operation batch cancelled: ${details}`)
    }
  }

  // Logical tasks are not resumed across a save/load boundary (the harness
  // re-plans after a restart). Now that task state is persisted, discard it
  // explicitly in the replicated post-load reconciliation, so every peer drops
  // the same state at the same tick.
  register_load_reconciliation_handler(() => {
    if (tms().player_state.task_state === TaskStates.IDLE && tms().task_queue.length === 0 && tms().active_batch_id === undefined) return
    clear_task_state_without_controls()
    tms().task_queue.length = 0
    const receipt = close_batch('cancelled', 'load')
    log(`[AUTORIO] Discarded persisted Autorio tasks after load${receipt ? `: ${receipt_details(receipt)}` : ''}`)
  })

  register_npc_recovery_handler(({ previous_actor_id }) => {
    discard_all_tasks_after_actor_loss()
    log(`[AUTORIO] Discarded active and queued work after loss of actor_id=${previous_actor_id}`)
  })

  register_actor_mode_transition_handler(({ previous_mode, next_mode }) => {
    if (tms().player_state.task_state === TaskStates.IDLE && tms().task_queue.length === 0) return
    cancel_all_tasks('actor_mode_change')
    log(`[AUTORIO] Cancelled active and queued work before actor mode change ${previous_mode} -> ${next_mode}`)
  })

  return {
    player_state: () => tms().player_state,
    add_task,
    next_task,
    interrupt_current_with,
    is_task_queue_empty,
    get_status_snapshot,
    reset_task_state,
    cancel_task,
    cancel_all_tasks,
    discard_all_tasks_after_actor_loss,
    register_cancel_handler,
  }
}
