import { create_actor_remote_interface, get_controlled_actor } from './actors/actor_controller'
import { remember_entity_reference } from './entity_reference'
import { is_internal_observation_entity, is_internal_observation_entity_name } from './internal_entities'
import { get_actor_inventory_items } from './utils/inventory'

const MAX_NEARBY_RADIUS = 64
const MAX_NEARBY_RESULTS = 100
const MAX_ENTITY_STATUS_RADIUS = 32
const MAX_ENTITY_INVENTORIES = 8
const MAX_ENTITY_INVENTORY_ITEMS = 50

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

export function create_tools_remote_interface() {
  create_actor_remote_interface()

  remote.add_interface('autorio_tools', {
    get_inventory_items: () => {
      const actor = get_controlled_actor()
      if (!actor) {
        rcon.print('no controlled actor')
        return false
      }

      rcon.print(serpent.block(get_actor_inventory_items(actor)))
      return true
    },
    get_recipe: (item_name: string) => {
      const actor = get_controlled_actor()
      if (!actor) {
        rcon.print('no controlled actor')
        return false
      }

      const recipe = actor.force.recipes[item_name]
      if (!recipe) {
        rcon.print('no such recipe')
        return false
      }

      if (!recipe.enabled) {
        rcon.print('recipe locked')
        return false
      }

      const ingredients = recipe.ingredients.map((ingredient) => {
        return {
          name: ingredient.name,
          count: ingredient.amount,
        }
      })

      rcon.print(serpent.block(ingredients))
      return true
    },
    get_player_status: (player_name: string) => {
      const actor = get_controlled_actor()
      const player = game.get_player(player_name)
      if (!player || !player.valid) {
        return {
          found: false,
          player_name,
          error: 'player not found',
        }
      }
      const same_surface = !!actor && actor.surface.index === player.surface.index
      const player_position = player.character ? player.position : undefined
      return {
        found: true,
        player: {
          name: player.name,
          connected: player.connected,
          has_character: !!player.character,
          surface: player.surface.name,
          position: player_position,
        },
        actor: actor?.status_snapshot(),
        same_surface,
        distance: actor && player_position && same_surface
          ? math.sqrt(squared_distance(actor.position, player_position))
          : undefined,
      }
    },
    get_nearby_entities: (radius: number = 20, name?: string, entity_type?: string, limit: number = 50) => {
      const actor = get_controlled_actor()
      if (!actor) {
        return {
          entities: [],
          truncated: false,
          error: 'no controlled actor',
        }
      }

      const bounded_radius = math.max(1, math.min(MAX_NEARBY_RADIUS, radius || 20))
      const bounded_limit = math.max(1, math.min(MAX_NEARBY_RESULTS, limit || 50))
      const filters: Record<string, unknown> = {
        position: actor.position,
        radius: bounded_radius,
      }
      if (name) {
        filters.name = name
      }
      if (entity_type) {
        filters.type = entity_type
      }

      if (is_internal_observation_entity_name(name)) {
        return {
          actor_position: actor.position,
          radius: bounded_radius,
          entities: [],
          matched_count: 0,
          returned_count: 0,
          truncated: false,
        }
      }

      const matches = actor.surface.find_entities_filtered(filters as any)
      const entities: Array<Record<string, unknown>> = []
      let matched_count = 0
      for (const entity of matches) {
        if (is_internal_observation_entity(entity)) continue
        matched_count++
        if (entities.length >= bounded_limit) continue
        remember_entity_reference(entity)
        entities.push({
          name: entity.name,
          type: entity.type,
          position: entity.position,
          force: entity.force?.name,
          unit_number: entity.unit_number,
          amount: entity.type === 'resource' ? entity.amount : undefined,
        })
      }

      return {
        actor_position: actor.position,
        radius: bounded_radius,
        entities,
        matched_count,
        returned_count: entities.length,
        truncated: matched_count > entities.length,
      }
    },
    get_entity_status: (name: string, radius: number = 8) => {
      const actor = get_controlled_actor()
      if (!actor) {
        return {
          found: false,
          error: 'no controlled actor',
        }
      }

      const bounded_radius = math.max(1, math.min(MAX_ENTITY_STATUS_RADIUS, radius || 8))
      if (is_internal_observation_entity_name(name)) {
        return {
          found: false,
          actor_position: actor.position,
          radius: bounded_radius,
          name,
        }
      }
      const matches = actor.surface.find_entities_filtered({
        position: actor.position,
        radius: bounded_radius,
        name,
      })

      let entity = matches[0]
      let nearest_distance = entity ? squared_distance(actor.position, entity.position) : math.huge
      for (let i = 1; i < matches.length; i++) {
        const candidate = matches[i]
        const candidate_distance = squared_distance(actor.position, candidate.position)
        if (candidate_distance < nearest_distance) {
          entity = candidate
          nearest_distance = candidate_distance
        }
      }

      if (!entity) {
        return {
          found: false,
          actor_position: actor.position,
          radius: bounded_radius,
          name,
        }
      }

      remember_entity_reference(entity)

      const inventories: Array<Record<string, unknown>> = []
      const max_inventory_index = math.min(entity.get_max_inventory_index(), MAX_ENTITY_INVENTORIES)
      let returned_items = 0
      let inventory_items_truncated = false

      for (let index = 1; index <= max_inventory_index; index++) {
        const inventory = entity.get_inventory(index)
        if (!inventory) {
          continue
        }

        const items: Array<{ name: string, quality: string, count: number }> = []
        for (const item of inventory.get_contents()) {
          if (returned_items >= MAX_ENTITY_INVENTORY_ITEMS) {
            inventory_items_truncated = true
            break
          }
          items.push({
            name: item.name,
            quality: item.quality,
            count: item.count,
          })
          returned_items += 1
        }

        inventories.push({
          index,
          items,
        })

        if (inventory_items_truncated) {
          break
        }
      }

      let recipe_name: string | undefined
      if (entity.type === 'assembling-machine') {
        const [recipe] = entity.get_recipe()
        recipe_name = recipe?.name
      }

      return {
        found: true,
        actor_position: actor.position,
        radius: bounded_radius,
        entity: {
          name: entity.name,
          type: entity.type,
          position: entity.position,
          force: entity.force?.name,
          unit_number: entity.unit_number,
          amount: entity.type === 'resource' ? entity.amount : undefined,
          recipe: recipe_name,
          inventories,
          inventories_truncated: entity.get_max_inventory_index() > MAX_ENTITY_INVENTORIES,
          inventory_items_truncated,
        },
      }
    },
  })
}
