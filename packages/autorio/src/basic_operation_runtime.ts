import type { LuaEntity, LuaInventory, SurfaceCreateEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { new_basic_operation_controller } from './basic_operations'
import { resolve_exact_entity } from './entity_reference'
import { build_interaction_reach, entity_interaction_reach } from './interaction_range'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersMineEntity, PlayerParametersWalkToEntity } from './types'
import { TaskStates } from './types'

type Manager = ReturnType<typeof new_task_manager>
type BasicController = ReturnType<typeof new_basic_operation_controller>

const MINING_TARGET_SEARCH_RADIUS = 5
const MINING_REACH_MARGIN = 0.25

function nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let min_distance = math.huge
  let nearest: LuaEntity | null = null
  for (const entity of entities) {
    const distance = (entity.position.x - actor.position.x) ** 2 + (entity.position.y - actor.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest = entity
    }
  }
  return nearest
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function mining_reach_distance(actor: ControlledActor, entity: LuaEntity) {
  const character = actor.character
  if (!character) return 0.5
  const raw = entity.type === 'resource'
    ? character.resource_reach_distance
    : character.reach_distance
  const reach = typeof raw === 'number' && raw === raw && raw > 0 && raw < math.huge ? raw : 2.5
  return math.max(0.5, reach - MINING_REACH_MARGIN)
}

function within_mining_reach(actor: ControlledActor, entity: LuaEntity) {
  const reach = mining_reach_distance(actor, entity)
  return squared_distance(actor.position, entity.position) <= reach ** 2
}

function mining_reposition_task(actor: ControlledActor, entity: LuaEntity): PlayerParametersWalkToEntity | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: entity.name,
    search_radius: MINING_TARGET_SEARCH_RADIUS,
    reach_distance: mining_reach_distance(actor, entity),
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: entity.position.x, y: entity.position.y },
    target: entity,
    target_unit_number: entity.unit_number,
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    started_tick: game.tick,
    last_progress_tick: game.tick,
  }
}

function entity_inventories(entity: LuaEntity, item_name: string, require_insert: boolean) {
  const inventories: LuaInventory[] = []
  const max_index = entity.get_max_inventory_index()
  for (let i = 1; i <= max_index; i++) {
    const inventory = entity.get_inventory(i)
    if (!inventory) continue
    if (require_insert && !inventory.can_insert({ name: item_name })) continue
    inventories.push(inventory)
  }
  return inventories
}

export function new_basic_operation_runtime(manager: Manager, controller: BasicController) {
  function start_mining(actor: ControlledActor, entity: LuaEntity) {
    const task = manager.player_state().parameters_mine_entity
    if (!task) return
    task.position = { x: entity.position.x, y: entity.position.y }
    task.last_target_amount = entity.type === 'resource' ? entity.amount : undefined
    actor.update_selected_entity(entity.position)
    actor.set_mining_state({ mining: true, position: entity.position })
    log(`[AUTORIO] Started mining ${entity.name} at position: ${serpent.line(entity.position)}`)
  }

  function current_mining_target(actor: ControlledActor) {
    const task = manager.player_state().parameters_mine_entity
    if (!task) return undefined
    if (task.target_unit_number !== undefined) {
      const exact = resolve_exact_entity(actor, task.target_unit_number)
      if (!exact || !exact.valid || exact.surface.index !== actor.surface.index) return undefined
      return exact
    }
    if (!task.position || !task.entity_name) return undefined
    return actor.surface.find_entities_filtered({
      position: task.position,
      radius: 0.25,
      name: task.entity_name,
    })[0]
  }

  function reposition_for_mining(actor: ControlledActor, entity: LuaEntity, task: PlayerParametersMineEntity) {
    const navigation = mining_reposition_task(actor, entity)
    if (!navigation) {
      controller.fail(actor, task, 'actor_changed')
      return false
    }

    const reach = navigation.reach_distance ?? 0
    const target_position = { x: entity.position.x, y: entity.position.y }
    actor.set_mining_state({ mining: false })
    task.position = undefined
    task.last_target_amount = undefined
    if (!manager.interrupt_current_with(navigation, task)) {
      controller.fail(actor, task, 'too_far')
      return false
    }
    log(`[AUTORIO] Mining target ${entity.name} at ${serpent.line(target_position)} is outside reach; repositioning to <=${reach} tiles before resuming the same mining operation`)
    return true
  }

  function finish_mining(actor: ControlledActor) {
    const task = manager.player_state().parameters_mine_entity
    if (!task) return
    actor.set_mining_state({ mining: false })
    log('[AUTORIO] Mining task complete')
    controller.complete(actor, task)
  }

  function poll_standalone_mining(actor: ControlledActor) {
    const task = manager.player_state().parameters_mine_entity
    if (!task || !task.position || actor.status_snapshot().kind !== 'standalone_character') return false

    const target = current_mining_target(actor)
    if (!target) {
      task.count -= 1
      task.position = undefined
      task.last_target_amount = undefined
      actor.set_mining_state({ mining: false })
      log(`[AUTORIO] Standalone actor completed mining cycle, remaining: ${task.count}`)
    }
    else if (target.type === 'resource') {
      const amount = target.amount
      if (task.last_target_amount === undefined) {
        task.last_target_amount = amount
      }
      else if (amount < task.last_target_amount) {
        const mined = math.min(task.count, task.last_target_amount - amount)
        task.count -= mined
        task.last_target_amount = amount
        log(`[AUTORIO] Standalone actor mined ${mined} ${target.name}, remaining: ${task.count}`)
      }
    }

    if (task.count <= 0) {
      finish_mining(actor)
      return true
    }
    return false
  }

  function state_mining(actor: ControlledActor) {
    const task = manager.player_state().parameters_mine_entity
    if (!task) {
      log('[AUTORIO] No parameters found when mining')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }

    if (task.entity_name !== undefined && !prototypes.entity[task.entity_name]) {
      controller.fail(actor, task, 'invalid_entity')
      return
    }
    if (task.entity_name === undefined && task.target_unit_number === undefined) {
      controller.fail(actor, task, 'invalid_entity')
      return
    }

    if (poll_standalone_mining(actor)) return

    if (task.position) {
      const existing = current_mining_target(actor)
      if (existing && !within_mining_reach(actor, existing)) {
        reposition_for_mining(actor, existing, task)
        return
      }
    }

    if (actor.get_mining_state().mining) return

    if (task.position) {
      const existing = current_mining_target(actor)
      if (existing) {
        start_mining(actor, existing)
        return
      }
      task.position = undefined
      task.last_target_amount = undefined
    }

    let target: LuaEntity | undefined
    if (task.target_unit_number !== undefined) {
      target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid) {
        controller.fail(actor, task, 'target_gone')
        return
      }
      if (target.surface.index !== actor.surface.index) {
        controller.fail(actor, task, 'different_surface')
        return
      }
    }
    else if (task.requested_position !== undefined && task.entity_name !== undefined) {
      target = actor.surface.find_entities_filtered({
        position: task.requested_position,
        radius: 0.25,
        name: task.entity_name,
      })[0]
      if (!target || target.type !== 'resource') {
        controller.fail(actor, task, 'no_target')
        return
      }
    }
    else if (task.entity_name !== undefined) {
      const entities = actor.surface.find_entities_filtered({
        position: actor.position,
        radius: MINING_TARGET_SEARCH_RADIUS,
        name: task.entity_name,
      })
      target = nearest_entity(actor, entities) ?? undefined
      if (!target) {
        controller.fail(actor, task, 'no_target')
        return
      }
    }

    if (!target) {
      controller.fail(actor, task, 'no_target')
      return
    }
    if (!within_mining_reach(actor, target)) {
      reposition_for_mining(actor, target, task)
      return
    }
    start_mining(actor, target)
  }

  function on_player_mined_entity(actor: ControlledActor, player_index: number) {
    if (!actor.owns_player_index(player_index) || manager.player_state().task_state !== TaskStates.MINING) return
    const task = manager.player_state().parameters_mine_entity
    if (!task) return
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }
    task.count -= 1
    task.position = undefined
    task.last_target_amount = undefined
    log(`[AUTORIO] Controlled player completed mining cycle, remaining: ${task.count}`)
    if (task.count <= 0) finish_mining(actor)
  }

  function state_placing(actor: ControlledActor) {
    const task = manager.player_state().parameters_place_entity
    if (!task) {
      log('[AUTORIO] No parameters found when placing')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return [false, 'Actor changed']
    }

    const surface = actor.surface
    const inventory = actor.get_main_inventory()
    if (!inventory) {
      controller.fail(actor, task, 'no_inventory')
      return [false, 'Cannot access actor inventory']
    }

    const prototype = prototypes.entity[task.entity_name]
    if (!prototype || !prototype.items_to_place_this || !prototype.items_to_place_this[0]) {
      controller.fail(actor, task, 'invalid_entity')
      return [false, 'Invalid entity name']
    }

    const [item_stack] = inventory.find_item_stack(task.entity_name)
    if (!item_stack) {
      controller.fail(actor, task, 'item_missing')
      return [false, 'Entity not found in inventory']
    }

    const build_reach = build_interaction_reach(actor)
    if (task.position && squared_distance(actor.position, task.position) > build_reach ** 2) {
      controller.fail(actor, task, 'too_far')
      return [false, 'Requested placement position is out of build range']
    }

    if (!task.position) {
      task.position = surface.find_non_colliding_position(task.entity_name, actor.position, 1, 1)
      if (!task.position) {
        controller.fail(actor, task, 'no_position')
        return [false, 'Could not find a valid position to place the entity']
      }
    }

    if (!surface.can_place_entity({
      name: task.entity_name,
      position: task.position,
      direction: task.direction,
      force: actor.force,
    })) {
      controller.fail(actor, task, 'not_placeable')
      return [false, 'Requested placement is blocked or otherwise not placeable']
    }

    const create_entity_args: SurfaceCreateEntity = {
      name: task.entity_name,
      position: task.position,
      direction: task.direction,
      raise_built: true,
      ...actor.entity_build_args(),
    }
    const entity = surface.create_entity(create_entity_args)
    if (!entity) {
      controller.fail(actor, task, 'create_failed')
      return [false, 'Failed to place entity']
    }

    item_stack.count = item_stack.count - 1
    log(`[AUTORIO] Entity placed successfully: ${task.entity_name} at ${serpent.line(task.position)} direction=${task.direction ?? 'default'}`)
    controller.complete(actor, task)
    return [true, 'Entity placed successfully', entity]
  }

  function move_items_with_player(actor: ControlledActor) {
    const task = manager.player_state().parameters_move_items
    if (!task?.player_name) return undefined

    const player = game.get_player(task.player_name)
    if (!player || !player.valid || !player.connected || !player.character) {
      controller.fail(actor, task, 'player_unavailable')
      return 0
    }
    if (player.surface.index !== actor.surface.index) {
      controller.fail(actor, task, 'different_surface')
      return 0
    }
    const reach = entity_interaction_reach(actor)
    if (squared_distance(actor.position, player.position) > reach ** 2) {
      controller.fail(actor, task, 'too_far')
      return 0
    }

    const actor_inventory = actor.get_main_inventory()
    const player_inventory = player.get_main_inventory()
    if (!actor_inventory || !player_inventory) {
      controller.fail(actor, task, 'no_inventory')
      return 0
    }

    let moved = 0
    if (task.to_player) {
      const [item_stack] = actor_inventory.find_item_stack(task.item_name)
      if (!item_stack) {
        controller.fail(actor, task, 'item_missing')
        return 0
      }
      const to_move = math.min(item_stack.count, task.max_count)
      moved = player_inventory.insert({ name: task.item_name, count: to_move })
      if (moved > 0) actor_inventory.remove({ name: task.item_name, count: moved })
    }
    else {
      const [item_stack] = player_inventory.find_item_stack(task.item_name)
      if (!item_stack) {
        controller.fail(actor, task, 'item_missing')
        return 0
      }
      const to_move = math.min(item_stack.count, task.max_count)
      if (actor_inventory.can_insert({ name: task.item_name, count: to_move })) {
        const removed = player_inventory.remove({ name: task.item_name, count: to_move })
        if (removed > 0) {
          moved = actor_inventory.insert({ name: task.item_name, count: removed })
          if (moved < removed) player_inventory.insert({ name: task.item_name, count: removed - moved })
        }
      }
    }

    if (moved <= 0) {
      controller.fail(actor, task, 'nothing_moved', { moved_count: 0 })
      return 0
    }
    log(`[AUTORIO] Moved ${moved} ${task.item_name} ${task.to_player ? 'to' : 'from'} player ${task.player_name}`)
    controller.complete(actor, task, { moved_count: moved })
    return moved
  }

  function entity_targets(actor: ControlledActor) {
    const task = manager.player_state().parameters_move_items
    if (!task) return undefined
    const reach = entity_interaction_reach(actor)

    if (task.target_unit_number !== undefined) {
      const target = resolve_exact_entity(actor, task.target_unit_number)
      if (!target || !target.valid) {
        controller.fail(actor, task, 'target_gone')
        return undefined
      }
      if (target.surface.index !== actor.surface.index) {
        controller.fail(actor, task, 'different_surface')
        return undefined
      }
      if (target.force.index !== actor.force.index) {
        controller.fail(actor, task, 'wrong_force')
        return undefined
      }
      if (squared_distance(actor.position, target.position) > reach ** 2) {
        controller.fail(actor, task, 'too_far')
        return undefined
      }
      return [target]
    }

    if (!task.entity_name || !prototypes.entity[task.entity_name]) {
      controller.fail(actor, task, 'invalid_entity')
      return undefined
    }

    const nearby = actor.surface.find_entities_filtered({
      position: actor.position,
      radius: reach,
      name: task.entity_name,
      force: actor.force,
    })
    if (nearby.length === 0) {
      controller.fail(actor, task, 'no_target')
      return undefined
    }
    return nearby
  }

  function state_moving_items(actor: ControlledActor) {
    const task = manager.player_state().parameters_move_items
    if (!task) {
      log('[AUTORIO] No parameters found when moving items')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return 0
    }

    if (task.player_name) return move_items_with_player(actor)

    const targets = entity_targets(actor)
    if (!targets) return 0

    const actor_inventory = actor.get_main_inventory()
    if (!actor_inventory) {
      controller.fail(actor, task, 'no_inventory')
      return 0
    }

    let moved_total = 0
    if (task.to_entity) {
      const [item_stack] = actor_inventory.find_item_stack(task.item_name)
      if (!item_stack) {
        controller.fail(actor, task, 'item_missing')
        return 0
      }

      targets
        .map(entity => entity_inventories(entity, task.item_name, true))
        .flat()
        .forEach((inventory) => {
          if (moved_total >= task.max_count) return
          const to_move = math.min(item_stack.count, task.max_count - moved_total)
          if (to_move <= 0) return
          const moved = inventory.insert({ name: task.item_name, count: to_move })
          if (moved > 0) {
            actor_inventory.remove({ name: task.item_name, count: moved })
            moved_total += moved
          }
        })
    }
    else {
      targets
        .map(entity => entity_inventories(entity, task.item_name, false))
        .flat()
        .forEach((inventory) => {
          if (moved_total >= task.max_count) return
          if (!actor_inventory.can_insert({ name: task.item_name })) return
          const removed = inventory.remove({ name: task.item_name, count: task.max_count - moved_total })
          if (removed <= 0) return
          const inserted = actor_inventory.insert({ name: task.item_name, count: removed })
          if (inserted < removed) inventory.insert({ name: task.item_name, count: removed - inserted })
          moved_total += inserted
        })
    }

    if (moved_total <= 0) {
      controller.fail(actor, task, 'nothing_moved', { moved_count: 0 })
      return 0
    }
    const target_label = task.target_unit_number !== undefined ? ` entity unit ${task.target_unit_number}` : ''
    log(`[AUTORIO] Moved a total of ${moved_total} ${task.item_name}${target_label}`)
    controller.complete(actor, task, { moved_count: moved_total })
    return moved_total
  }

  function state_waiting(actor: ControlledActor) {
    const task = manager.player_state().parameters_waiting
    if (!task) {
      log('[AUTORIO] No parameters found when waiting')
      return
    }
    if (!controller.identity_matches(actor, task)) {
      controller.fail(actor, task, 'actor_changed')
      return
    }
    if (task.remaining_ticks <= 0) {
      log('[AUTORIO] Waiting task complete')
      controller.complete(actor, task)
      return
    }
    task.remaining_ticks -= 1
  }

  return {
    state_mining,
    state_placing,
    state_moving_items,
    state_waiting,
    on_player_mined_entity,
  }
}
