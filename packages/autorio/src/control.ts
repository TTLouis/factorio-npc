import type { MapPositionStruct } from 'factorio:prototype'
import type {
  LuaEntity,
  OnPlayerCraftedItemEvent,
  OnPlayerMinedEntityEvent,
  OnScriptPathRequestFinishedEvent,
  OnSelectedEntityChangedEvent,
} from 'factorio:runtime'

import type { ControlledActor } from './actors/types'
import { get_controlled_actor } from './actors/actor_controller'
import { new_awareness_controller } from './awareness'
import { new_area_clearing_controller } from './area_clearing'
import { craft_bootstrap_preflight_for_actor } from './bootstrap_planning'
import { new_basic_operation_runtime } from './basic_operation_runtime'
import { new_basic_operation_controller } from './basic_operations'
import { new_combat_controller } from './combat'
import { new_composite_operation_controller } from './composite_operations'
import { execute_validated_construction_plan } from './construction_execution'
import { new_crafting_controller } from './crafting'
import { new_defense_controller } from './defense'
import { create_discovery_remote_interface } from './discovery'
import { new_equipment_controller } from './equipment'
import { entity_reference_hint, resolve_exact_entity } from './entity_reference'
import { new_follow_controller } from './follow'
import { new_harvest_controller } from './harvest'
import { new_interaction_recovery } from './interaction_recovery'
import { create_knowledge_remote_interface } from './knowledge'
import { new_navigation_controller } from './navigation'
import { new_navigation_obstacle_recovery } from './navigation_obstacle_recovery'
import { new_orientation_runtime } from './orientation_runtime'
import { execute_placement_candidate } from './placement_candidates'
import { create_production_planning_remote_interface } from './production_planning_remote'
import { create_prototype_knowledge_remote_interface } from './prototype_knowledge'
import { new_recipe_configuration_runtime } from './recipe_configuration'
import { new_rocket_launch_runtime } from './rocket_launch'
import { new_research_controller } from './research'
import { research_operation_preflight } from './research_preflight'
import { ensure_basic_skill_definitions } from './skills'
import { with_research_trigger } from './research_trigger'
import { is_runtime_task_state, type RuntimeTaskState } from './task_state_runtime'
import { new_task_manager } from './task_manager'
import { create_task_board_ui_remote_interface, set_task_board_world_task_provider } from './task_board_ui'
import { create_tools_remote_interface } from './tools'
import { TaskStates } from './types'
import { direction_towards } from './utils/direction'
import { get_actor_inventory_items } from './utils/inventory'

create_tools_remote_interface()
create_discovery_remote_interface(get_controlled_actor)
create_knowledge_remote_interface(get_controlled_actor)
create_prototype_knowledge_remote_interface(get_controlled_actor)
create_production_planning_remote_interface(get_controlled_actor)
create_task_board_ui_remote_interface()

let setup_complete = false

export const task_manager = new_task_manager(get_controlled_actor)
set_task_board_world_task_provider(() => task_manager.get_status_snapshot())
const awareness_controller = new_awareness_controller()
const area_clearing_controller = new_area_clearing_controller(get_controlled_actor, task_manager)
const basic_operation_controller = new_basic_operation_controller(get_controlled_actor, task_manager)
const basic_operation_runtime = new_basic_operation_runtime(task_manager, basic_operation_controller)
const orientation_runtime = new_orientation_runtime(task_manager, basic_operation_controller)
const recipe_configuration_runtime = new_recipe_configuration_runtime(task_manager, basic_operation_controller)
const rocket_launch_runtime = new_rocket_launch_runtime(task_manager, basic_operation_controller)
const interaction_recovery = new_interaction_recovery(task_manager)
const navigation_controller = new_navigation_controller(get_controlled_actor, task_manager)
const composite_operation_controller = new_composite_operation_controller(navigation_controller, basic_operation_controller, task_manager)
const harvest_controller = new_harvest_controller(get_controlled_actor, task_manager)
const navigation_obstacle_recovery = new_navigation_obstacle_recovery()
const crafting_controller = new_crafting_controller(get_controlled_actor, task_manager)
const research_controller = new_research_controller(get_controlled_actor, task_manager)
const combat_controller = new_combat_controller(get_controlled_actor, task_manager)
const equipment_controller = new_equipment_controller(get_controlled_actor)
const follow_controller = new_follow_controller(
  get_controlled_actor,
  (player_name, follow_distance) => navigation_controller.submit_player(player_name, follow_distance),
)
const defense_controller = new_defense_controller(get_controlled_actor)

type RuntimeTaskDispatcher = (actor: ControlledActor) => void

const runtime_task_dispatchers: Record<RuntimeTaskState, RuntimeTaskDispatcher> = {
  [TaskStates.WALKING_TO_ENTITY]: (actor) => {
    const handled = navigation_obstacle_recovery.tick(actor, task_manager.player_state.parameters_walk_to_entity)
    if (!handled) navigation_controller.tick(actor)
  },
  [TaskStates.WALKING_DIRECT]: actor => state_walking_direct(actor),
  [TaskStates.MINING]: actor => basic_operation_runtime.state_mining(actor),
  [TaskStates.HARVESTING]: actor => harvest_controller.tick(actor),
  [TaskStates.CLEARING_AREA]: actor => area_clearing_controller.tick(actor),
  [TaskStates.PLACING]: actor => basic_operation_runtime.state_placing(actor),
  [TaskStates.ROTATING]: actor => orientation_runtime.state_rotating(actor),
  [TaskStates.MOVING_ITEMS]: actor => basic_operation_runtime.state_moving_items(actor),
  [TaskStates.SETTING_RECIPE]: actor => recipe_configuration_runtime.state_setting_recipe(actor),
  [TaskStates.LAUNCHING_ROCKET]: actor => rocket_launch_runtime.state_launching_rocket(actor),
  [TaskStates.CRAFTING]: actor => crafting_controller.tick(actor),
  [TaskStates.RESEARCHING]: actor => research_controller.tick(actor),
  [TaskStates.ATTACKING]: actor => combat_controller.tick(actor),
  [TaskStates.WAITING]: actor => basic_operation_runtime.state_waiting(actor),
}

export function runtime_dispatch_has_handler(state: RuntimeTaskState) {
  return runtime_task_dispatchers[state] !== undefined
}

remote.add_interface('autorio_navigation', {
  status: () => ({
    ...navigation_controller.status(),
    obstacle_recovery: navigation_obstacle_recovery.status(),
  }),
  set_clear_obstacles: (enabled: boolean) => navigation_obstacle_recovery.set_enabled(enabled),
})

remote.add_interface('autorio_follow', {
  status: () => follow_controller.status(),
})

remote.add_interface('autorio_defense', {
  status: () => defense_controller.status(),
})

remote.add_interface('autorio_equipment', {
  status: () => equipment_controller.status(),
})

remote.add_interface('autorio_crafting', {
  status: () => crafting_controller.status(),
})

remote.add_interface('autorio_research', {
  status: () => research_controller.status(),
  technology: (name: string) => with_research_trigger(name, research_controller.technology(name) as Record<string, unknown>),
  request_result: (request_id: number) => research_controller.request_result(request_id),
})

remote.add_interface('autorio_combat', {
  status: () => combat_controller.status(),
})

function log_actor_info() {
  const actor = get_controlled_actor()
  if (!actor) {
    log('[AUTORIO] Cannot log actor info: no controlled actor')
    return false
  }

  const technologies: string[] = []
  for (const [name, tech] of pairs(actor.force.technologies)) {
    if (tech.researched) technologies.push(name)
  }

  const nearby_entities = actor.surface.find_entities_filtered({
    position: actor.position,
    radius: 20,
  }).map(({ name, position }) => ({ name, position }))

  const character = actor.character
  const log_data = {
    actor: actor.status_snapshot(),
    force: actor.force.name,
    inventory: get_actor_inventory_items(actor),
    equipment: equipment_controller.status(),
    nearby_entities,
    map_info: {
      surface_name: actor.surface.name,
      daytime: actor.surface.daytime,
      wind_speed: actor.surface.wind_speed,
      wind_orientation: actor.surface.wind_orientation,
    },
    research: {
      current_research: actor.force.current_research?.name ?? 'None',
      research_progress: actor.force.research_progress,
    },
    technologies,
    character_stats: character
      ? {
          health: character.health,
          health_max: character.max_health,
          mining_progress: character.mining_progress,
          mining_state: actor.get_mining_state(),
        }
      : undefined,
  }

  log(`[AUTORIO] Actor ${actor.status_snapshot().name} info: ${serpent.block(log_data)}`)
  return true
}

function operation_preflight(name: string, args: Record<string, any>) {
  const actor = get_controlled_actor()
  const reject = (code: string, details: Record<string, unknown> = {}) => ({
    ok: false,
    code,
    operation: name,
    ...details,
  })
  const accept = (details: Record<string, unknown> = {}) => ({
    ok: true,
    operation: name,
    ...details,
  })

  if (!args || typeof args !== 'object') return reject('invalid_preflight_args')

  if (name === 'research_technology') {
    return research_operation_preflight(actor, args.technology_name)
  }

  let exact_target: Record<string, unknown> | undefined
  const exact_unit_operations = [
    'walk_to_entity_exact',
    'mine_entity_exact',
    'supply_entity',
    'rotate_entity',
    'move_items_exact',
    'set_machine_recipe',
    'launch_rocket',
  ]
  if (exact_unit_operations.indexOf(name) >= 0) {
    if (!actor || !actor.is_valid) return reject('no_actor')
    const unit_number = args.unit_number
    if (typeof unit_number !== 'number'
      || unit_number !== math.floor(unit_number)
      || unit_number < 1
      || unit_number > 9007199254740991) {
      return reject('invalid_unit_number', { field: 'unit_number', identity: unit_number })
    }
    const target = resolve_exact_entity(actor, unit_number)
    if (!target || !target.valid) {
      const hint = entity_reference_hint(unit_number)
      return reject('stale_exact_target', {
        field: 'unit_number',
        identity: unit_number,
        last_observed: hint
          ? {
              unit_number,
              name: hint.name,
              surface_index: hint.surface_index,
              force_index: hint.force_index,
              position: hint.position,
              observed_tick: hint.observed_tick,
            }
          : undefined,
      })
    }
    if (target.surface.index !== actor.surface.index) {
      return reject('different_surface', {
        field: 'unit_number',
        identity: unit_number,
        target_surface_index: target.surface.index,
        actor_surface_index: actor.surface.index,
      })
    }
    exact_target = {
      unit_number,
      name: target.name,
      position: { x: target.position.x, y: target.position.y },
      surface_index: target.surface.index,
      force_index: target.force.index,
    }
    if (name !== 'set_machine_recipe') {
      return accept({ field: 'unit_number', identity: unit_number, target: exact_target })
    }
  }

  if (name === 'craft_item') {
    if (!actor || !actor.is_valid) return reject('no_actor')
    const item_name = args.item_name
    if (typeof item_name !== 'string') {
      return reject('unknown_recipe', {
        field: 'item_name',
        identity: item_name,
        expected: 'force recipe',
      })
    }
    return craft_bootstrap_preflight_for_actor(actor, item_name, args.count ?? 1)
  }

  if (name === 'gather_resource' || name === 'mine_resource_at') {
    const resource_name = args.resource_name
    const prototype = typeof resource_name === 'string' ? prototypes.entity[resource_name] : undefined
    if (!prototype) {
      return reject('unknown_prototype', {
        field: 'resource_name',
        identity: resource_name,
        expected_type: 'resource',
        observed_type: 'missing',
      })
    }
    if (prototype.type !== 'resource') {
      return reject('invalid_target_kind', {
        field: 'resource_name',
        identity: resource_name,
        expected_type: 'resource',
        observed_type: prototype.type,
      })
    }
    return accept({
      field: 'resource_name',
      identity: resource_name,
      expected_type: 'resource',
      observed_type: prototype.type,
    })
  }

  if (name === 'place_entity' || name === 'mine_entity' || name === 'walk_to_entity') {
    const entity_name = args.entity_name
    const prototype = typeof entity_name === 'string' ? prototypes.entity[entity_name] : undefined
    if (!prototype) {
      return reject('unknown_prototype', {
        field: 'entity_name',
        identity: entity_name,
        expected: 'entity prototype',
      })
    }
    return accept({ field: 'entity_name', identity: entity_name, observed_type: prototype.type })
  }

  if (name === 'set_machine_recipe') {
    if (!actor || !actor.is_valid) return reject('no_actor')
    const recipe_name = args.recipe_name
    const recipe = typeof recipe_name === 'string' ? actor.force.recipes[recipe_name] : undefined
    if (!recipe) {
      return reject('unknown_recipe', {
        field: 'recipe_name',
        identity: recipe_name,
        expected: 'force recipe',
      })
    }
    return accept({
      field: 'recipe_name',
      identity: recipe_name,
      recipe_name: recipe.name,
      target: exact_target,
    })
  }

  return accept({ validation: 'not_required' })
}

remote.add_interface('autorio_preflight', {
  operation: (name: string, args: Record<string, any>) => operation_preflight(name, args),
})

remote.add_interface('autorio_operations', {
  walk_to_entity: (entity_name: string, search_radius: number) => {
    log(`[AUTORIO] New walk_to_entity task: ${entity_name}, radius: ${search_radius}`)
    return navigation_controller.submit(entity_name, search_radius)
  },
  walk_to_entity_exact: (unit_number: number, reach_distance: number = 2.5): [boolean, string] => {
    const result = navigation_controller.submit_exact(unit_number, reach_distance)
    if (result[0]) log(`[AUTORIO] New walk_to_entity_exact task: unit=${unit_number}, reach=${reach_distance}`)
    return result
  },
  walk_to_position: (x: number, y: number, reach_distance: number = 0.75): [boolean, string] => {
    const result = navigation_controller.submit_position(x, y, reach_distance)
    if (result[0]) log(`[AUTORIO] New walk_to_position task: (${x}, ${y}), reach=${reach_distance}`)
    return result
  },
  walk_to_player: (player_name: string): [boolean, string] => {
    const result = navigation_controller.submit_player(player_name)
    if (result[0]) log(`[AUTORIO] New walk_to_player task: ${player_name}`)
    return result
  },
  follow_player: (player_name: string, follow_distance: number = 4): [boolean, string] => {
    const result = follow_controller.submit(player_name, follow_distance, navigation_obstacle_recovery.enabled())
    if (result[0]) log(`[AUTORIO] Follow mode enabled for ${player_name} at distance ${follow_distance}`)
    return result
  },
  stop_follow_player: (): [boolean, string] => follow_controller.stop(),
  set_auto_defense: (enabled: boolean): [boolean, string] => defense_controller.set_enabled(enabled),
  equip_weapon: (item_name: string, slot: number = 1): [boolean, string] => equipment_controller.equip_weapon(item_name, slot),
  equip_ammo: (item_name: string, slot: number = 1): [boolean, string] => equipment_controller.equip_ammo(item_name, slot),
  equip_armor: (item_name: string): [boolean, string] => equipment_controller.equip_armor(item_name),
  select_weapon_slot: (slot: number): [boolean, string] => equipment_controller.select_weapon_slot(slot),
  mine_entity: (entity_name: string, count: number = 1) => {
    const accepted = basic_operation_controller.submit_mining(entity_name, count)
    if (accepted) log(`[AUTORIO] New mine_entity task: ${entity_name} x${count}`)
    return accepted
  },
  mine_entity_exact: (unit_number: number) => {
    const accepted = basic_operation_controller.submit_mining_exact(unit_number)
    if (accepted) log(`[AUTORIO] New mine_entity_exact task: unit=${unit_number}`)
    return accepted
  },
  mine_resource_at: (resource_name: string, x: number, y: number, count: number = 1) => {
    const accepted = basic_operation_controller.submit_mining_at(resource_name, x, y, count)
    if (accepted) log(`[AUTORIO] New mine_resource_at task: ${resource_name} x${count} at (${x}, ${y})`)
    return accepted
  },
  gather_resource: (resource_name: string, count: number = 1, search_radius: number = 256): [boolean, string] => {
    const result = composite_operation_controller.gather_resource(resource_name, count, search_radius)
    if (result[0]) log(`[AUTORIO] New gather_resource task: ${resource_name} x${count}, radius=${search_radius}`)
    return result
  },
  harvest_product: (product_name: string, count: number = 1, search_radius: number = 256): [boolean, string] => {
    const result = harvest_controller.submit(product_name, count, search_radius)
    if (result[0]) log(`[AUTORIO] New harvest_product task: ${product_name} +${count}, radius=${search_radius}`)
    return result
  },
  clear_construction_area: (x: number, y: number, width: number, height: number): [boolean, string] => {
    const result = area_clearing_controller.submit(x, y, width, height)
    if (result[0]) log(`[AUTORIO] New clear_construction_area task: center=(${x},${y}), size=${width}x${height}`)
    return result
  },
  supply_entity: (unit_number: number, items: Array<{ item_name: string, count: number }>): [boolean, string] => {
    const result = composite_operation_controller.supply_entity(unit_number, items)
    if (result[0]) log(`[AUTORIO] New supply_entity task: unit=${unit_number}, item_types=${items.length}`)
    return result
  },
  execute_construction_plan: (validation_id: number, placement_count: number): [boolean, string] => {
    const actor = get_controlled_actor()
    if (!actor) return [false, 'controlled actor is unavailable']
    const result = execute_validated_construction_plan(
      actor,
      validation_id,
      placement_count,
      basic_operation_controller,
      task_manager,
    )
    if (result[0]) log(`[AUTORIO] New execute_construction_plan task: validation=${validation_id}, placements=${placement_count}`)
    return result
  },
  place_candidate: (candidate_set_id: string, candidate_id: string): [boolean, string] => {
    const actor = get_controlled_actor()
    if (!actor) return [false, 'controlled actor is unavailable']
    const result = execute_placement_candidate(
      actor,
      candidate_set_id,
      candidate_id,
      (entity_name, x, y, direction) => basic_operation_controller.submit_placement(entity_name, x, y, direction),
    )
    if (result[0]) log(`[AUTORIO] New place_candidate task: ${candidate_set_id}/${candidate_id}`)
    return result
  },
  place_entity: (entity_name: string, x?: number, y?: number, direction?: number) => {
    const accepted = basic_operation_controller.submit_placement(entity_name, x, y, direction)
    if (accepted) {
      const position = x !== undefined && y !== undefined ? ` at (${x}, ${y})` : ''
      const facing = direction !== undefined ? ` direction=${direction}` : ''
      log(`[AUTORIO] New place_entity task: ${entity_name}${position}${facing}`)
    }
    return accepted
  },
  rotate_entity: (unit_number: number, reverse: boolean = false): [boolean, string] => {
    const result = basic_operation_controller.submit_rotate_exact(unit_number, reverse)
    if (result[0]) log(`[AUTORIO] New rotate_entity task: unit=${unit_number}, reverse=${reverse}`)
    return result
  },
  move_items: (item_name: string, entity_name: string, max_count: number, to_entity: boolean): [boolean, string] => {
    const result = basic_operation_controller.submit_move(item_name, entity_name, max_count, to_entity)
    if (result[0]) {
      log(`[AUTORIO] New move_items task for ${item_name} ${to_entity ? 'to' : 'from'} ${entity_name}`)
    }
    return result
  },
  move_items_exact: (item_name: string, unit_number: number, max_count: number, to_entity: boolean): [boolean, string] => {
    const result = basic_operation_controller.submit_move_exact(item_name, unit_number, max_count, to_entity)
    if (result[0]) {
      log(`[AUTORIO] New exact move_items task for ${item_name} ${to_entity ? 'to' : 'from'} entity unit ${unit_number}`)
    }
    return result
  },
  set_machine_recipe: (unit_number: number, recipe_name: string): [boolean, string] => {
    const result = basic_operation_controller.submit_set_recipe_exact(unit_number, recipe_name)
    if (result[0]) log(`[AUTORIO] New set_machine_recipe task for entity unit ${unit_number}: ${recipe_name}`)
    return result
  },
  launch_rocket: (unit_number: number): [boolean, string] => {
    const result = basic_operation_controller.submit_launch_rocket_exact(unit_number)
    if (result[0]) log(`[AUTORIO] New launch_rocket task for silo unit ${unit_number}`)
    return result
  },
  move_items_with_player: (item_name: string, player_name: string, max_count: number, to_player: boolean): [boolean, string] => {
    const result = basic_operation_controller.submit_player_move(item_name, player_name, max_count, to_player)
    if (result[0]) {
      log(`[AUTORIO] New player item transfer for ${item_name} ${to_player ? 'to' : 'from'} ${player_name}`)
    }
    return result
  },
  wait: (ticks: number): [boolean, string] => {
    const result = basic_operation_controller.submit_wait(ticks)
    if (result[0]) log(`[AUTORIO] New wait task for ${ticks} ticks`)
    return result
  },
  craft_item: (item_name: string, count: number = 1): [boolean, string] => crafting_controller.submit(item_name, count),
  attack_nearest_enemy: (search_radius: number = 50): [boolean, string] => combat_controller.submit(search_radius),
  clear_enemy_area: (search_radius: number = 96): [boolean, string] => combat_controller.submit_clear(search_radius),
  research_technology: (name: string): [boolean, string, number] => research_controller.submit(name),
  cancel_all_tasks: () => {
    task_manager.cancel_all_tasks()
    return true
  },
  status: () => {
    const actor = get_controlled_actor()
    return {
      ...task_manager.get_status_snapshot(),
      actor: actor?.status_snapshot(),
      basic_operation: basic_operation_controller.status(),
      follow: follow_controller.status(),
      defense: defense_controller.status(),
    }
  },
  log_actor_info: () => log_actor_info(),
  log_player_info: (_player_id?: number) => log_actor_info(),
})

export function get_direction(start_position: MapPositionStruct, end_position: MapPositionStruct) {
  return direction_towards(start_position, end_position)
}

export function get_nearest_entity(actor: ControlledActor, entities: LuaEntity[]) {
  let min_distance = math.huge
  let nearest_entity: LuaEntity | null = null
  if (entities.length === 0) return null
  for (const entity of entities) {
    const distance = (entity.position.x - actor.position.x) ** 2 + (entity.position.y - actor.position.y) ** 2
    if (distance < min_distance) {
      min_distance = distance
      nearest_entity = entity
    }
  }
  return nearest_entity
}

export function state_moving_items(actor: ControlledActor) {
  return basic_operation_runtime.state_moving_items(actor)
}

function state_walking_direct(actor: ControlledActor) {
  const task = task_manager.player_state.parameters_walking_direct
  if (!task) {
    log('[AUTORIO] No parameters found when walking directly')
    return
  }

  const target = task.target_position
  if (!target) {
    log('[AUTORIO] No target position, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
    return
  }

  const direction = get_direction(actor.position, target)
  actor.set_walking_state({ walking: true, direction })
  if (((target.x - actor.position.x) ** 2 + (target.y - actor.position.y) ** 2) < 2) {
    log('[AUTORIO] Reached target, switching to IDLE state')
    task_manager.reset_task_state()
    task_manager.next_task()
  }
}

script.on_event(defines.events.on_selected_entity_changed, (_event: OnSelectedEntityChangedEvent) => { /* Selection changes are intentionally ignored. */ })

script.on_event(defines.events.on_script_path_request_finished, (event: OnScriptPathRequestFinishedEvent) => {
  navigation_controller.on_path_finished(event)
  combat_controller.on_path_finished(event)
})

script.on_event(defines.events.on_player_mined_entity, (event: OnPlayerMinedEntityEvent) => {
  const actor = get_controlled_actor()
  if (!actor) return
  if (task_manager.player_state.task_state === TaskStates.HARVESTING) {
    harvest_controller.on_player_mined_entity(actor, event.player_index, event.entity)
  }
  else if (task_manager.player_state.task_state === TaskStates.CLEARING_AREA) {
    area_clearing_controller.on_player_mined_entity(actor, event.player_index, event.entity)
  }
  else {
    basic_operation_runtime.on_player_mined_entity(actor, event.player_index, event.entity)
  }
})

function setup() {
  const seeded = ensure_basic_skill_definitions()
  setup_complete = true
  if (seeded.added > 0) log(`[AUTORIO] Seeded ${seeded.added}/${seeded.total} curated basic skill patterns`)
  log('[AUTORIO] Setup complete')
}

let no_actor_found = false

script.on_event(defines.events.on_tick, (_event) => {
  if (!setup_complete) setup()

  const actor = get_controlled_actor()
  if (actor === undefined || actor.character === undefined || !actor.is_valid) {
    if (!no_actor_found) {
      log('[AUTORIO] No valid controlled actor found')
      no_actor_found = true
    }
    return
  }
  no_actor_found = false
  awareness_controller.tick(actor)

  if (task_manager.player_state.task_state === TaskStates.IDLE) {
    navigation_obstacle_recovery.suspend(actor)
    follow_controller.tick(actor)
    if (task_manager.player_state.task_state !== TaskStates.IDLE) {
      defense_controller.suspend(actor)
      return
    }
    if (follow_controller.status().active) defense_controller.tick(actor)
    else defense_controller.suspend(actor)
    return
  }

  follow_controller.suspend(actor)
  defense_controller.suspend(actor)

  const task_state = task_manager.player_state.task_state
  if (!is_runtime_task_state(task_state)) {
    navigation_obstacle_recovery.suspend(actor)
    task_manager.fail_unsupported_task_state(task_state)
    return
  }

  if (interaction_recovery.tick(actor)) return

  if (task_state !== TaskStates.WALKING_TO_ENTITY) {
    navigation_obstacle_recovery.suspend(actor)
  }
  runtime_task_dispatchers[task_state](actor)
})

script.on_event(defines.events.on_player_crafted_item, (event: OnPlayerCraftedItemEvent) => {
  const actor = get_controlled_actor()
  if (!actor || !actor.owns_player_index(event.player_index)) {
    return
  }
  log(`[AUTORIO] Actor ${actor.status_snapshot().name} crafted item: ${event.item_stack.name}`)
})

log('[AUTORIO] Mod loaded 1')
