import type { LuaEntity } from 'factorio:runtime'
import { create_actor_remote_interface, get_controlled_actor } from './actors/actor_controller'
import type { ControlledActor } from './actors/types'
import { remember_entity_reference, resolve_exact_entity } from './entity_reference'
import { create_placement_candidate_set, type PlacementCandidateRequest } from './placement_candidates'
import { compact_spatial_summary } from './spatial_semantics'
import { get_actor_inventory_items } from './utils/inventory'

const MAX_NEARBY_RADIUS = 64
const MAX_NEARBY_RESULTS = 40
const MAX_ENTITY_STATUS_RADIUS = 32
const MAX_ENTITY_INVENTORIES = 8
const MAX_ENTITY_INVENTORY_ITEMS = 20

function squared_distance(a: { x: number, y: number }, b: { x: number, y: number }) {
  return (a.x - b.x) ** 2 + (a.y - b.y) ** 2
}

function positive_integer(value: unknown) {
  return typeof value === 'number' && value === math.floor(value) && value > 0
}

function actor_item_count(actor: ControlledActor, item_name: string) {
  const item = get_actor_inventory_items(actor).find(entry => entry.name === item_name)
  return item?.count ?? 0
}

function entity_item_count(entity: LuaEntity, item_name: string) {
  let count = 0
  const max_inventory_index = math.min(entity.get_max_inventory_index(), MAX_ENTITY_INVENTORIES)
  for (let index = 1; index <= max_inventory_index; index++) {
    const inventory = entity.get_inventory(index)
    if (!inventory) continue
    for (const item of inventory.get_contents()) {
      if (item.name === item_name) count += item.count
    }
  }
  return count
}

function evaluate_runtime_condition(request: Record<string, unknown>) {
  const actor = get_controlled_actor()
  if (!actor) return { ok: false, error: 'no_actor' }
  if (!request || typeof request !== 'object') return { ok: false, error: 'invalid_condition' }
  const kind = request.kind
  if (kind === 'inventory_count') {
    const item_name = request.item_name
    const minimum = request.minimum
    if (typeof item_name !== 'string' || !positive_integer(minimum)) return { ok: false, error: 'invalid_inventory_count_condition' }
    if (!prototypes.item[item_name]) return { ok: false, error: 'unknown_item', item_name }
    const current = actor_item_count(actor, item_name)
    return { ok: true, kind, satisfied: current >= (minimum as number), current, minimum, progress_known: false }
  }

  if (kind === 'entity_exists' || kind === 'entity_state' || kind === 'entity_inventory_count') {
    const unit_number = request.unit_number
    if (!positive_integer(unit_number)) return { ok: false, error: 'invalid_exact_identity', stale: true }
    const entity = resolve_exact_entity(actor, unit_number as number)
    if (!entity || !entity.valid) return { ok: false, error: 'stale_exact_identity', stale: true, unit_number }
    const status = entity.status
    const progress_known = status !== undefined
    const progressing = status === defines.entity_status.working

    if (kind === 'entity_exists') {
      return { ok: true, kind, satisfied: true, unit_number, progressing, progress_known, entity_status: status }
    }

    if (kind === 'entity_state') {
      const expected = request.expected
      if (expected !== 'working' && expected !== 'not_working' && expected !== 'exists') return { ok: false, error: 'invalid_entity_state_condition' }
      const satisfied = expected === 'exists'
        ? true
        : expected === 'working'
          ? progressing
          : !progressing
      return { ok: true, kind, satisfied, unit_number, progressing, progress_known, entity_status: status }
    }

    const item_name = request.item_name
    const minimum = request.minimum
    if (typeof item_name !== 'string' || !positive_integer(minimum)) return { ok: false, error: 'invalid_entity_inventory_count_condition' }
    if (!prototypes.item[item_name]) return { ok: false, error: 'unknown_item', item_name }
    const current = entity_item_count(entity, item_name)
    return {
      ok: true,
      kind,
      satisfied: current >= (minimum as number),
      current,
      minimum,
      unit_number,
      progressing,
      progress_known,
      entity_status: status,
    }
  }

  return { ok: false, error: 'unsupported_condition_kind' }
}

export function create_tools_remote_interface() {
  create_actor_remote_interface()

  remote.add_interface('autorio_tools', {
    evaluate_condition: (request: Record<string, unknown>) => evaluate_runtime_condition(request),
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

      const matches = actor.surface.find_entities_filtered(filters as any)
      const entities: Array<Record<string, unknown>> = []
      const returned = math.min(matches.length, bounded_limit)
      for (let i = 0; i < returned; i++) {
        const entity = matches[i]
        remember_entity_reference(entity)
        const summary: Record<string, unknown> = {
          name: entity.name,
          type: entity.type,
          position: entity.position,
          force: entity.force?.name,
          unit_number: entity.unit_number,
          direction: entity.direction,
          supports_direction: entity.supports_direction,
          rotatable: entity.rotatable,
          amount: entity.type === 'resource' ? entity.amount : undefined,
        }
        const spatial = compact_spatial_summary(entity)
        if (spatial !== undefined) summary.spatial = spatial
        entities.push(summary)
      }

      return {
        actor_position: actor.position,
        radius: bounded_radius,
        entities,
        matched_count: matches.length,
        returned_count: entities.length,
        truncated: matches.length > entities.length,
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
      const matches = actor.surface.find_entities_filtered({
        position: actor.position,
        radius: bounded_radius,
        name,
      })

      let entity = matches[0]
      let nearest_distance = entity !== undefined ? squared_distance(actor.position, entity.position) : math.huge
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

      const entity_summary: Record<string, unknown> = {
        name: entity.name,
        type: entity.type,
        position: entity.position,
        force: entity.force?.name,
        unit_number: entity.unit_number,
        direction: entity.direction,
        supports_direction: entity.supports_direction,
        rotatable: entity.rotatable,
        amount: entity.type === 'resource' ? entity.amount : undefined,
        recipe: recipe_name,
        status: entity.status,
        working: entity.status === defines.entity_status.working,
        inventories,
        inventories_truncated: entity.get_max_inventory_index() > MAX_ENTITY_INVENTORIES,
        inventory_items_truncated,
      }
      const spatial = compact_spatial_summary(entity)
      if (spatial !== undefined) entity_summary.spatial = spatial

      return {
        found: true,
        actor_position: actor.position,
        radius: bounded_radius,
        entity: entity_summary,
      }
    },
    get_placement_candidates: (request: PlacementCandidateRequest) => {
      const actor = get_controlled_actor()
      if (!actor) return { ok: false, error: 'no controlled actor' }
      return create_placement_candidate_set(actor, request)
    },
  })
}
