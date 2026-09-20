import type { LuaEntity, LuaSurface, UnitNumber } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { crafting_categories_support_recipe } from './recipe_categories'

const MAX_MAP_QUERY_RADIUS = 256
const MAX_MAP_QUERY_RESULTS = 64

interface QueryArea {
  left_top: { x: number, y: number }
  right_bottom: { x: number, y: number }
}

type MapObservationCode = 'ok' | 'no_actor' | 'invalid_surface' | 'invalid_position' | 'invalid_radius' | 'invalid_limit' | 'invalid_entity_name' | 'area_uncharted' | 'area_not_visible' | 'entity_not_found'
type MapMutationCode = 'completed' | 'already_configured' | 'no_actor' | 'entity_not_found' | 'area_uncharted' | 'area_not_visible' | 'wrong_force' | 'not_operable' | 'not_recipe_machine' | 'invalid_recipe' | 'recipe_disabled' | 'incompatible_recipe' | 'recipe_change_unsafe' | 'set_recipe_failed'

function valid_number(value: number) {
  return typeof value === 'number' && value === value && value >= -1000000 && value <= 1000000
}

function valid_integer(value: number, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function chunk_position(position: { x: number, y: number }) {
  return {
    x: math.floor(position.x / 32),
    y: math.floor(position.y / 32),
  }
}

export function is_position_charted(actor: ControlledActor, surface: LuaSurface, position: { x: number, y: number }) {
  return actor.force.is_chunk_charted(surface, chunk_position(position))
}

export function is_position_visible(actor: ControlledActor, surface: LuaSurface, position: { x: number, y: number }) {
  return actor.force.is_chunk_visible(surface, chunk_position(position))
}

function map_coverage(actor: ControlledActor, surface: LuaSurface, area: QueryArea) {
  const min_chunk_x = math.floor(area.left_top.x / 32)
  const min_chunk_y = math.floor(area.left_top.y / 32)
  const max_chunk_x = math.floor(area.right_bottom.x / 32)
  const max_chunk_y = math.floor(area.right_bottom.y / 32)
  let charted_chunks = 0
  let visible_chunks = 0
  let total_chunks = 0

  for (let chunk_x = min_chunk_x; chunk_x <= max_chunk_x; chunk_x++) {
    for (let chunk_y = min_chunk_y; chunk_y <= max_chunk_y; chunk_y++) {
      total_chunks++
      const chunk = { x: chunk_x, y: chunk_y }
      if (actor.force.is_chunk_charted(surface, chunk)) charted_chunks++
      if (actor.force.is_chunk_visible(surface, chunk)) visible_chunks++
    }
  }

  return {
    charted_chunks,
    uncharted_chunks: total_chunks - charted_chunks,
    visible_chunks,
    fogged_chunks: charted_chunks - visible_chunks,
    total_chunks,
    partial: charted_chunks > 0 && charted_chunks < total_chunks,
    visibility_partial: visible_chunks > 0 && visible_chunks < total_chunks,
  }
}

function visible_query_areas(actor: ControlledActor, surface: LuaSurface, area: QueryArea) {
  const min_chunk_x = math.floor(area.left_top.x / 32)
  const min_chunk_y = math.floor(area.left_top.y / 32)
  const max_chunk_x = math.floor(area.right_bottom.x / 32)
  const max_chunk_y = math.floor(area.right_bottom.y / 32)
  const areas: QueryArea[] = []

  for (let chunk_x = min_chunk_x; chunk_x <= max_chunk_x; chunk_x++) {
    for (let chunk_y = min_chunk_y; chunk_y <= max_chunk_y; chunk_y++) {
      const chunk = { x: chunk_x, y: chunk_y }
      if (!actor.force.is_chunk_visible(surface, chunk)) continue

      const chunk_left = chunk_x * 32
      const chunk_top = chunk_y * 32
      const chunk_right = chunk_left + 32
      const chunk_bottom = chunk_top + 32
      areas.push({
        left_top: {
          x: area.left_top.x > chunk_left ? area.left_top.x : chunk_left,
          y: area.left_top.y > chunk_top ? area.left_top.y : chunk_top,
        },
        right_bottom: {
          x: area.right_bottom.x < chunk_right ? area.right_bottom.x : chunk_right,
          y: area.right_bottom.y < chunk_bottom ? area.right_bottom.y : chunk_bottom,
        },
      })
    }
  }

  return areas
}

function entity_identity(entity: LuaEntity) {
  if (entity.unit_number !== undefined) return `unit:${entity.unit_number}`
  return `${entity.name}|${entity.type}|${entity.surface.index}|${entity.position.x}|${entity.position.y}|${entity.direction}`
}

function entity_snapshot(entity: LuaEntity) {
  let recipe_name: string | undefined
  if (entity.type === 'assembling-machine') {
    const [recipe] = entity.get_recipe()
    recipe_name = recipe?.name
  }

  return {
    name: entity.name,
    type: entity.type,
    position: entity.position,
    surface_index: entity.surface.index,
    surface_name: entity.surface.name,
    force: entity.force?.name,
    force_index: entity.force?.index,
    unit_number: entity.unit_number,
    direction: entity.direction,
    health: entity.health,
    recipe_name,
  }
}

function surface_by_index(surface_index: number) {
  if (!valid_integer(surface_index, 1, 4294967295)) return undefined
  return game.get_surface(surface_index as LuaSurface['index'])
}

export function query_charted_entities(
  actor: ControlledActor,
  surface_index: number,
  x: number,
  y: number,
  radius: number = 32,
  limit: number = 32,
  name?: string,
) {
  if (!valid_number(x) || !valid_number(y)) {
    return { ok: false, code: 'invalid_position' as MapObservationCode, entities: [] }
  }
  if (!valid_integer(radius, 0, MAX_MAP_QUERY_RADIUS)) {
    return { ok: false, code: 'invalid_radius' as MapObservationCode, entities: [] }
  }
  if (!valid_integer(limit, 1, MAX_MAP_QUERY_RESULTS)) {
    return { ok: false, code: 'invalid_limit' as MapObservationCode, entities: [] }
  }
  if (name !== undefined && (typeof name !== 'string' || name.length === 0 || !prototypes.entity[name])) {
    return { ok: false, code: 'invalid_entity_name' as MapObservationCode, entities: [], name }
  }

  const surface = surface_by_index(surface_index)
  if (!surface || !surface.valid) {
    return { ok: false, code: 'invalid_surface' as MapObservationCode, entities: [], surface_index }
  }

  const area: QueryArea = {
    left_top: { x: x - radius, y: y - radius },
    right_bottom: { x: x + radius, y: y + radius },
  }
  const coverage = map_coverage(actor, surface, area)
  if (coverage.charted_chunks === 0) {
    return {
      ok: false,
      code: 'area_uncharted' as MapObservationCode,
      surface_index,
      surface_name: surface.name,
      center: { x, y },
      radius,
      ...coverage,
      entities: [],
    }
  }
  if (coverage.visible_chunks === 0) {
    return {
      ok: false,
      code: 'area_not_visible' as MapObservationCode,
      surface_index,
      surface_name: surface.name,
      center: { x, y },
      radius,
      ...coverage,
      entities: [],
    }
  }

  const entities: Array<ReturnType<typeof entity_snapshot>> = []
  const seen: Record<string, boolean> = {}
  const query_areas = visible_query_areas(actor, surface, area)
  for (const visible_area of query_areas) {
    const filters: any = { area: visible_area }
    if (name !== undefined) filters.name = name
    const candidates = surface.find_entities_filtered(filters)
    for (const entity of candidates) {
      if (!entity.valid) continue
      if (!is_position_visible(actor, surface, entity.position)) continue
      const identity = entity_identity(entity)
      if (seen[identity]) continue
      seen[identity] = true
      entities.push(entity_snapshot(entity))
      if (entities.length >= limit) break
    }
    if (entities.length >= limit) break
  }

  return {
    ok: true,
    code: 'ok' as MapObservationCode,
    surface_index,
    surface_name: surface.name,
    center: { x, y },
    radius,
    ...coverage,
    returned_count: entities.length,
    entities,
  }
}

function resolve_visible_entity(actor: ControlledActor, unit_number: number) {
  if (!valid_integer(unit_number, 1, 9007199254740991)) {
    return { code: 'entity_not_found' as MapObservationCode, entity: undefined }
  }
  const entity = game.get_entity_by_unit_number(unit_number as UnitNumber)
  if (!entity || !entity.valid) {
    return { code: 'entity_not_found' as MapObservationCode, entity: undefined }
  }
  if (!is_position_charted(actor, entity.surface, entity.position)) {
    return { code: 'area_uncharted' as MapObservationCode, entity: undefined }
  }
  if (!is_position_visible(actor, entity.surface, entity.position)) {
    return { code: 'area_not_visible' as MapObservationCode, entity: undefined }
  }
  return { code: 'ok' as MapObservationCode, entity }
}

export function inspect_charted_entity(actor: ControlledActor, unit_number: number) {
  const resolved = resolve_visible_entity(actor, unit_number)
  if (!resolved.entity) {
    return { ok: false, code: resolved.code, unit_number }
  }
  return {
    ok: true,
    code: 'ok' as MapObservationCode,
    entity: entity_snapshot(resolved.entity),
  }
}

function supports_recipe_category(target: LuaEntity, recipe: any) {
  return crafting_categories_support_recipe(target.prototype?.crafting_categories, recipe)
}

function nonempty_inventory(target: LuaEntity, inventory: any) {
  const contents = target.get_inventory(inventory)
  return contents !== undefined && contents !== null && !contents.is_empty()
}

function recipe_change_is_safe(target: LuaEntity) {
  if (target.is_crafting()) return false
  if (target.get_fluid_count() > 0) return false

  const recipe_sensitive_inventories = [
    defines.inventory.crafter_input,
    defines.inventory.crafter_output,
    defines.inventory.crafter_trash,
    defines.inventory.assembling_machine_dump,
  ]
  for (const inventory of recipe_sensitive_inventories) {
    if (nonempty_inventory(target, inventory)) return false
  }
  return true
}

function mutation_result(accepted: boolean, completed: boolean, code: MapMutationCode, details: Record<string, unknown> = {}) {
  return {
    accepted,
    completed,
    code,
    tick: game.tick,
    execution_mode: 'remote',
    ...details,
  }
}

export function set_charted_machine_recipe(actor: ControlledActor, unit_number: number, recipe_name: string) {
  const resolved = resolve_visible_entity(actor, unit_number)
  const target = resolved.entity
  if (!target) {
    let code: MapMutationCode = 'entity_not_found'
    if (resolved.code === 'area_uncharted') code = 'area_uncharted'
    else if (resolved.code === 'area_not_visible') code = 'area_not_visible'
    return mutation_result(false, false, code, { unit_number, recipe_name })
  }
  if (target.force.index !== actor.force.index) {
    return mutation_result(false, false, 'wrong_force', { unit_number, recipe_name })
  }
  if (target.operable === false) {
    return mutation_result(false, false, 'not_operable', { unit_number, recipe_name })
  }
  if (target.type !== 'assembling-machine') {
    return mutation_result(false, false, 'not_recipe_machine', { unit_number, recipe_name })
  }
  if (typeof recipe_name !== 'string' || recipe_name.length === 0) {
    return mutation_result(false, false, 'invalid_recipe', { unit_number, recipe_name })
  }

  const recipe = actor.force.recipes[recipe_name]
  if (!recipe) {
    return mutation_result(false, false, 'invalid_recipe', { unit_number, recipe_name })
  }
  if (!recipe.enabled) {
    return mutation_result(false, false, 'recipe_disabled', { unit_number, recipe_name })
  }
  if (!supports_recipe_category(target, recipe)) {
    return mutation_result(false, false, 'incompatible_recipe', { unit_number, recipe_name })
  }

  const [current_recipe] = target.get_recipe()
  if (current_recipe?.name === recipe_name) {
    return mutation_result(true, true, 'already_configured', {
      unit_number,
      recipe_name,
      surface_index: target.surface.index,
    })
  }
  if (!recipe_change_is_safe(target)) {
    return mutation_result(false, false, 'recipe_change_unsafe', {
      unit_number,
      recipe_name,
      previous_recipe_name: current_recipe?.name,
      reason: 'recipe-dependent machine contents or active crafting would be displaced by LuaEntity.set_recipe',
    })
  }

  const removed_items = target.set_recipe(recipe_name)
  const removed_item_count = removed_items?.length ?? 0
  const [verified_recipe] = target.get_recipe()
  if (verified_recipe?.name !== recipe_name) {
    return mutation_result(false, false, 'set_recipe_failed', { unit_number, recipe_name })
  }

  const details: Record<string, unknown> = {
    unit_number,
    recipe_name,
    previous_recipe_name: current_recipe?.name,
    surface_index: target.surface.index,
    removed_item_count,
  }
  if (removed_item_count > 0) {
    details.warning = 'unexpected_recipe_displacement_after_safe_preflight'
  }
  return mutation_result(true, true, 'completed', details)
}

export function create_map_remote_interface(get_actor: () => ControlledActor | undefined) {
  remote.add_interface('autorio_map', {
    context: () => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { ok: false, code: 'no_actor' as MapObservationCode }
      }
      return {
        ok: true,
        code: 'ok' as MapObservationCode,
        policy: {
          map_first: true,
          charted_only: true,
          live_operations_require_visibility: true,
          physical_fallback_only_when_required: true,
        },
        actor: actor.status_snapshot(),
        physical_surface: {
          index: actor.surface.index,
          name: actor.surface.name,
        },
      }
    },
    query_area: (surface_index: number, x: number, y: number, radius: number = 32, limit: number = 32, name?: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { ok: false, code: 'no_actor' as MapObservationCode, entities: [] }
      }
      return query_charted_entities(actor, surface_index, x, y, radius, limit, name)
    },
    inspect_entity: (unit_number: number) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return { ok: false, code: 'no_actor' as MapObservationCode, unit_number }
      }
      return inspect_charted_entity(actor, unit_number)
    },
    set_machine_recipe: (unit_number: number, recipe_name: string) => {
      const actor = get_actor()
      if (!actor || !actor.is_valid) {
        return mutation_result(false, false, 'no_actor', { unit_number, recipe_name })
      }
      return set_charted_machine_recipe(actor, unit_number, recipe_name)
    },
  })
}
