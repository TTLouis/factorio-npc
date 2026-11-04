import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { is_chunk_known_visible } from './map_knowledge'
import { find_world_entities } from './npc_vision'

// How much ore lies in a square of tiles: native resource entity amounts, read
// only in chunks the NPC sees now. Facts only; which patch to mine is the
// caller's decision.

export interface ResourceAmountRequest {
  resource_name?: string
  center?: { x: number, y: number }
  radius?: number
}

export const DEFAULT_RESOURCE_RADIUS = 16
export const MAX_RESOURCE_RADIUS = 48
const MAX_RESOURCE_KINDS = 8
const MAX_REPORTED_TILES = 64
const MAX_REPORTED_UNSEEN_CHUNKS = 8

interface ResourceTotal {
  name: string
  tile_count: number
  total_amount: number
  min_amount: number
  max_amount: number
  infinite: boolean
  bounding_box: { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }
}

function finite_number(value: unknown, minimum: number, maximum: number) {
  return typeof value === 'number' && value === value && value >= minimum && value <= maximum
}

function refuse(code: string, details: Record<string, unknown> = {}) {
  return { ok: false, code, ...details }
}

export function resource_amount_observation(actor: ControlledActor | undefined, request: ResourceAmountRequest) {
  if (!actor || !actor.is_valid || !actor.character) return refuse('no_actor')
  const radius = request.radius ?? DEFAULT_RESOURCE_RADIUS
  if (!finite_number(radius, 0, MAX_RESOURCE_RADIUS) || radius !== math.floor(radius)) {
    return refuse('invalid_radius', { maximum: MAX_RESOURCE_RADIUS })
  }
  const resource_name = request.resource_name
  if (resource_name !== undefined) {
    const prototype = prototypes.entity[resource_name]
    if (!prototype || prototype.type !== 'resource') return refuse('unknown_resource', { resource_name })
  }
  const requested_center = request.center ?? actor.position
  if (!finite_number(requested_center.x, -1000000, 1000000) || !finite_number(requested_center.y, -1000000, 1000000)) {
    return refuse('invalid_center')
  }
  // Tiles are whole: the square covers the tile holding the centre and `radius`
  // tiles each side, so radius 2 is a 5x5 square (an electric drill's area).
  const tile_x = math.floor(requested_center.x)
  const tile_y = math.floor(requested_center.y)
  const area = {
    left_top: { x: tile_x - radius, y: tile_y - radius },
    right_bottom: { x: tile_x + radius + 1, y: tile_y + radius + 1 },
  }
  const surface = actor.surface
  const force = actor.force

  const totals = new Map<string, ResourceTotal>()
  const tiles: { name: string, position: { x: number, y: number }, amount: number, distance: number }[] = []
  const unseen: { x: number, y: number, distance: number }[] = []
  let visible_chunks = 0
  let total_chunks = 0
  const min_chunk_x = math.floor(area.left_top.x / 32)
  const min_chunk_y = math.floor(area.left_top.y / 32)
  const max_chunk_x = math.floor((area.right_bottom.x - 1) / 32)
  const max_chunk_y = math.floor((area.right_bottom.y - 1) / 32)
  for (let chunk_x = min_chunk_x; chunk_x <= max_chunk_x; chunk_x++) {
    for (let chunk_y = min_chunk_y; chunk_y <= max_chunk_y; chunk_y++) {
      total_chunks++
      const chunk = { x: chunk_x, y: chunk_y }
      if (!is_chunk_known_visible(force, surface, chunk)) {
        const dx = chunk_x * 32 + 16 - tile_x
        const dy = chunk_y * 32 + 16 - tile_y
        unseen.push({ x: chunk_x, y: chunk_y, distance: math.sqrt(dx * dx + dy * dy) })
        continue
      }
      visible_chunks++
      const part = {
        left_top: { x: math.max(area.left_top.x, chunk_x * 32), y: math.max(area.left_top.y, chunk_y * 32) },
        right_bottom: { x: math.min(area.right_bottom.x, chunk_x * 32 + 32), y: math.min(area.right_bottom.y, chunk_y * 32 + 32) },
      }
      const found: LuaEntity[] = find_world_entities(surface, {
        area: part,
        type: 'resource',
        ...(resource_name !== undefined ? { name: resource_name } : {}),
      })
      for (const entity of found) {
        const position = entity.position
        // The engine also returns resources whose box touches this part's edge;
        // count each tile once, in the chunk part holding its centre.
        if (position.x < part.left_top.x || position.x >= part.right_bottom.x
          || position.y < part.left_top.y || position.y >= part.right_bottom.y) continue
        const amount = entity.amount
        let total = totals.get(entity.name)
        if (!total) {
          total = {
            name: entity.name,
            tile_count: 0,
            total_amount: 0,
            min_amount: amount,
            max_amount: amount,
            infinite: entity.prototype.infinite_resource === true,
            bounding_box: { left_top: { x: position.x, y: position.y }, right_bottom: { x: position.x, y: position.y } },
          }
          totals.set(entity.name, total)
        }
        total.tile_count++
        total.total_amount += amount
        total.min_amount = math.min(total.min_amount, amount)
        total.max_amount = math.max(total.max_amount, amount)
        const box = total.bounding_box
        box.left_top.x = math.min(box.left_top.x, position.x)
        box.left_top.y = math.min(box.left_top.y, position.y)
        box.right_bottom.x = math.max(box.right_bottom.x, position.x)
        box.right_bottom.y = math.max(box.right_bottom.y, position.y)
        if (resource_name !== undefined) {
          const dx = position.x - (tile_x + 0.5)
          const dy = position.y - (tile_y + 0.5)
          tiles.push({ name: entity.name, position: { x: position.x, y: position.y }, amount, distance: math.sqrt(dx * dx + dy * dy) })
        }
      }
    }
  }

  const resources: ResourceTotal[] = []
  for (const [, total] of totals) resources.push(total)
  resources.sort((a, b) => b.total_amount - a.total_amount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  tiles.sort((a, b) => a.distance - b.distance || a.position.y - b.position.y || a.position.x - b.position.x)
  unseen.sort((a, b) => a.distance - b.distance)

  return {
    ok: true,
    observed_tick: game.tick,
    surface_index: surface.index,
    actor_position: actor.position,
    center_tile: { x: tile_x, y: tile_y },
    radius,
    area,
    ...(resource_name !== undefined ? { resource_name } : {}),
    resources: resources.slice(0, MAX_RESOURCE_KINDS),
    resource_kinds: resources.length,
    resources_truncated: resources.length > MAX_RESOURCE_KINDS,
    // Per-tile amounts, nearest the centre first, only when one resource is named.
    ...(resource_name !== undefined
      ? {
          tiles: tiles.slice(0, MAX_REPORTED_TILES).map(tile => ({ position: tile.position, amount: tile.amount })),
          tiles_truncated: tiles.length > MAX_REPORTED_TILES,
        }
      : {}),
    // Chunks not seen now are not read: their ore is unknown, not absent.
    visible_chunks,
    unseen_chunk_count: total_chunks - visible_chunks,
    unseen_chunks: unseen.slice(0, MAX_REPORTED_UNSEEN_CHUNKS).map(chunk => ({ x: chunk.x, y: chunk.y })),
    coverage_complete: visible_chunks === total_chunks,
  }
}
