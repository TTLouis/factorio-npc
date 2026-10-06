import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { MAX_MINING_START_REJECTIONS, mining_navigation_reach, mining_navigation_requires_movement, select_exact_mining_target, within_mining_reach } from './mining_reach'
import { harvest_source_prototype_names } from './prototype_knowledge'
import type { new_task_manager } from './task_manager'
import type { PlayerParametersHarvestProduct, PlayerParametersWalkToEntity } from './types'
import { TaskStates } from './types'
import { get_actor_inventory_items } from './utils/inventory'
import { find_world_entities } from './npc_vision'

type TaskManager = ReturnType<typeof new_task_manager>

const MAX_HARVEST_COUNT = 100000
const DEFAULT_HARVEST_SEARCH_RADIUS = 256
const MAX_HARVEST_SEARCH_RADIUS = 4096
const INITIAL_SEARCH_RADIUS = 8
const SEARCH_RESULT_LIMIT = 32

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function inventory_count(actor: ControlledActor, item_name: string) {
  for (const item of get_actor_inventory_items(actor)) {
    if (item.name === item_name) return item.count
  }
  return 0
}

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let nearest: LuaEntity | undefined
  let best_distance = math.huge
  for (const entity of entities) {
    if (!entity.valid) continue
    const distance = squared_distance(actor.position, entity.position)
    if (distance < best_distance) {
      nearest = entity
      best_distance = distance
    }
  }
  return nearest
}

function source_is_compatible(task: PlayerParametersHarvestProduct, entity: LuaEntity | null | undefined) {
  if (!entity || !entity.valid || entity.type === 'resource') return false
  for (const name of task.source_names) {
    if (entity.name === name) return true
  }
  return false
}

function find_source(actor: ControlledActor, task: PlayerParametersHarvestProduct) {
  let radius = math.min(INITIAL_SEARCH_RADIUS, task.search_radius)
  while (radius <= task.search_radius) {
    const matches = find_world_entities(actor.surface, {
      position: actor.position,
      radius,
      name: task.source_names,
      limit: SEARCH_RESULT_LIMIT,
    })
    const nearest = nearest_entity(actor, matches)
    if (nearest) return nearest
    if (radius === task.search_radius) break
    radius = math.min(task.search_radius, radius * 2)
  }
  return undefined
}

function navigation_to_target(actor: ControlledActor, task: PlayerParametersHarvestProduct, target: LuaEntity, rejected_starts: number = 0): PlayerParametersWalkToEntity | undefined {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return undefined
  return {
    type: TaskStates.WALKING_TO_ENTITY,
    entity_name: '',
    search_radius: 1,
    target_kind: 'position',
    requested_position: { x: target.position.x, y: target.position.y },
    reach_distance: mining_navigation_reach(actor, target, rejected_starts),
    path: null,
    path_drawn: false,
    path_index: 1,
    calculating_path: false,
    target_position: { x: target.position.x, y: target.position.y },
    owner_actor_id: identity.actor_id,
    owner_actor_kind: identity.kind,
    owner_force_index: actor.force.index,
    path_attempts: 0,
    started_tick: undefined,
    last_progress_tick: game.tick,
  }
}

export function new_harvest_controller(
  get_actor: () => ControlledActor | undefined,
  manager: TaskManager,
) {
  function identity_matches(actor: ControlledActor, task: PlayerParametersHarvestProduct) {
    const identity = actor.status_snapshot()
    return task.owner_actor_id !== undefined
      && task.owner_actor_id === identity.actor_id
      && task.owner_actor_kind === identity.kind
      && task.owner_force_index === actor.force.index
  }

  function finish(actor: ControlledActor, task: PlayerParametersHarvestProduct) {
    actor.set_mining_state({ mining: false })
    task.target = null
    task.target_name = undefined
    task.target_position = undefined
    log(`[AUTORIO] Harvest complete: verified ${task.verified_gain}/${task.requested_count} ${task.product_name}`)
    manager.reset_task_state()
    manager.next_task()
  }

  function fail(actor: ControlledActor | undefined, task: PlayerParametersHarvestProduct, reason: string) {
    if (actor?.is_valid) actor.set_mining_state({ mining: false })
    manager.cancel_all_tasks(`harvest:${reason}`)
    log(`[AUTORIO] [ERROR] Harvest ${task.product_name} failed: ${reason}; verified_gain=${task.verified_gain}/${task.requested_count}`)
  }

  function submit(
    product_name: string,
    count: number = 1,
    search_radius: number = DEFAULT_HARVEST_SEARCH_RADIUS,
  ): [boolean, string] {
    if (typeof product_name !== 'string' || product_name.length < 1 || product_name.length > 200 || !prototypes.item[product_name]) {
      return [false, 'product_name must identify a current-game item prototype']
    }
    if (!valid_integer(count, 1, MAX_HARVEST_COUNT)) {
      return [false, `count must be an integer from 1 to ${MAX_HARVEST_COUNT}`]
    }
    if (!valid_integer(search_radius, 1, MAX_HARVEST_SEARCH_RADIUS)) {
      return [false, `search_radius must be an integer from 1 to ${MAX_HARVEST_SEARCH_RADIUS}`]
    }

    const actor = get_actor()
    const identity = actor?.is_valid ? actor.status_snapshot() : undefined
    if (!actor || !actor.is_valid || !actor.character || identity?.actor_id === undefined) {
      return [false, 'controlled actor is unavailable']
    }

    const source_names = harvest_source_prototype_names(product_name)
    if (source_names.length === 0) {
      return [false, `no non-resource mineable prototypes currently yield ${product_name}`]
    }

    const task: PlayerParametersHarvestProduct = {
      type: TaskStates.HARVESTING,
      product_name,
      requested_count: count,
      search_radius,
      source_names,
      inventory_count_before: inventory_count(actor, product_name),
      verified_gain: 0,
      owner_actor_id: identity.actor_id,
      owner_actor_kind: identity.kind,
      owner_force_index: actor.force.index,
    }
    manager.add_task(task)
    return [true, `Product harvest task started with ${source_names.length} compatible source prototype(s)`]
  }

  function reposition_after_rejected_start(actor: ControlledActor, task: PlayerParametersHarvestProduct, target: LuaEntity) {
    actor.set_mining_state({ mining: false })
    task.mining_attempted = false
    task.mining_rejects = (task.mining_rejects ?? 0) + 1
    if (task.mining_rejects > MAX_MINING_START_REJECTIONS) {
      fail(actor, task, 'mining_rejected')
      return
    }
    const navigation = navigation_to_target(actor, task, target, task.mining_rejects)
    const reach = navigation?.reach_distance ?? 0
    if (!navigation || !mining_navigation_requires_movement(actor, target, reach)
      || !manager.interrupt_current_with(navigation, task)) {
      fail(actor, task, 'mining_rejected')
      return
    }
    log(`[AUTORIO] Mining start rejected for harvest source ${target.name}; repositioning closer before retry ${task.mining_rejects}/${MAX_MINING_START_REJECTIONS}`)
  }

  function tick(actor: ControlledActor) {
    const task = manager.player_state.parameters_harvest_product
    if (!task || manager.player_state.task_state !== TaskStates.HARVESTING) return
    if (!identity_matches(actor, task)) {
      fail(actor, task, 'actor_changed')
      return
    }

    const current_count = inventory_count(actor, task.product_name)
    task.verified_gain = math.max(0, current_count - task.inventory_count_before)
    if (task.verified_gain >= task.requested_count) {
      finish(actor, task)
      return
    }

    if (!source_is_compatible(task, task.target)) {
      actor.set_mining_state({ mining: false })
      task.target = null
      task.target_name = undefined
      task.target_position = undefined
      task.mining_rejects = 0
      task.mining_attempted = false
    }

    let target = task.target ?? undefined
    if (!target) {
      target = find_source(actor, task)
      if (!target) {
        fail(actor, task, 'no_target')
        return
      }
      task.target = target
      task.target_name = target.name
      task.target_position = { x: target.position.x, y: target.position.y }
      task.mining_rejects = 0
      task.mining_attempted = false
    }

    if (!within_mining_reach(actor, target)) {
      actor.set_mining_state({ mining: false })
      const navigation = navigation_to_target(actor, task, target)
      if (!navigation || !manager.interrupt_current_with(navigation, task)) {
        fail(actor, task, 'navigation_failed')
      }
      return
    }

    if (actor.get_mining_state().mining) return
    if (task.mining_attempted) {
      reposition_after_rejected_start(actor, task, target)
      return
    }
    if (!select_exact_mining_target(actor, target)) {
      reposition_after_rejected_start(actor, task, target)
      return
    }

    actor.set_mining_state({ mining: true, position: target.position })
    task.mining_attempted = true
    if (!actor.get_mining_state().mining) {
      reposition_after_rejected_start(actor, task, target)
      return
    }

    log(`[AUTORIO] Harvesting exact ${target.name} for ${task.product_name}; verified_gain=${task.verified_gain}/${task.requested_count}`)
  }

  function on_player_mined_entity(actor: ControlledActor, player_index: number, mined_entity?: LuaEntity) {
    if (!actor.owns_player_index(player_index) || manager.player_state.task_state !== TaskStates.HARVESTING) return
    const task = manager.player_state.parameters_harvest_product
    if (!task || !identity_matches(actor, task) || !task.target) return
    if (mined_entity && mined_entity !== task.target) return
    actor.set_mining_state({ mining: false })
    task.target = null
    task.target_name = undefined
    task.target_position = undefined
    task.mining_rejects = 0
    task.mining_attempted = false
  }

  return { submit, tick, on_player_mined_entity }
}
