import type { LuaEntity, LuaFluidBoxPrototype, LuaForce, LuaSurface, PipeConnectionDefinition } from 'factorio:runtime'
import { area_known_visible } from './map_knowledge'

// Reads that reach past an entity the NPC sees now (M3): the neighbours the engine links to it and the areas a summary
// scans around it. A neighbour or area in a chunk the NPC does not see now is unknown, never absent or disconnected:
// nothing there is read, so the answer is the same whether a fogged neighbour still stands.

interface Point { x: number, y: number }
interface Area { left_top: Point, right_bottom: Point }

export type SeenArea = (area: Area) => boolean

export function seen_now(force: LuaForce, surface: LuaSurface): SeenArea {
  return area => area_known_visible(force, surface, area)
}

export function point_area(position: Point): Area {
  return { left_top: { x: position.x, y: position.y }, right_bottom: { x: position.x, y: position.y } }
}

export function area_around(center: Point, reach: number): Area {
  return {
    left_top: { x: center.x - reach, y: center.y - reach },
    right_bottom: { x: center.x + reach, y: center.y + reach },
  }
}

export function entity_area(entity: LuaEntity): Area {
  return entity.bounding_box ?? point_area(entity.position)
}

function grown(area: Area, reach: number): Area {
  return {
    left_top: { x: area.left_top.x - reach, y: area.left_top.y - reach },
    right_bottom: { x: area.right_bottom.x + reach, y: area.right_bottom.y + reach },
  }
}

// The neighbour the engine links in `area`, read only when that area and the neighbour's whole box are seen now. With no
// `seen` (a harness or reconciliation read) it is read as before.
export function seen_link(seen: SeenArea | undefined, area: Area | undefined, read: () => LuaEntity | undefined) {
  if (seen !== undefined && (area === undefined || !seen(area))) return { seen: false as const }
  const entity = read()
  if (seen !== undefined && entity !== undefined && entity.valid && !seen(entity_area(entity))) return { seen: false as const }
  return { seen: true as const, entity }
}

// A runtime fluidbox can merge several prototype boxes. Inspect every underground definition, including custom-table
// collections, rather than assuming a vanilla distance or matching a runtime index to a prototype index. Missing,
// malformed or excessively large definitions are unbounded. Linked connections have no spatial bound at all.
export function pipe_link_area(entity: LuaEntity, connection: { position: Point, target_position?: Point, connection_type?: string }, fluidbox_index: number): Area | undefined {
  if (connection.connection_type === 'linked') return undefined
  if (connection.connection_type === 'underground') {
    const raw = entity.fluidbox.get_prototype(fluidbox_index)
    if (!raw) return undefined
    const definitions = ('production_type' in raw ? [raw] : raw) as Record<number, LuaFluidBoxPrototype>
    let reach: number | undefined
    let boxes = 0
    let ports = 0
    for (const [, definition] of pairs(definitions)) {
      if (++boxes > 64 || !definition.pipe_connections) return undefined
      for (const [, port] of pairs(definition.pipe_connections as Record<number, PipeConnectionDefinition>)) {
        if (++ports > 256) return undefined
        if (port.connection_type !== 'underground') continue
        const distance = port.max_underground_distance
        if (distance === undefined || distance !== distance || distance < 0 || distance > 4096) return undefined
        reach = math.max(reach ?? 0, distance)
      }
    }
    if (reach === undefined) return undefined
    // Include offsets of modded ports from the entity box, plus one tile for the connection/target tile boundary.
    const offset = math.max(math.abs(connection.position.x - entity.position.x), math.abs(connection.position.y - entity.position.y))
    return grown(entity_area(entity), reach + offset + 1)
  }
  if (connection.connection_type !== 'normal') return undefined
  const target = connection.target_position ?? connection.position
  return {
    left_top: { x: math.min(connection.position.x, target.x), y: math.min(connection.position.y, target.y) },
    right_bottom: { x: math.max(connection.position.x, target.x), y: math.max(connection.position.y, target.y) },
  }
}

// Belt neighbours are local except for underground/linked variants. Script-linked belts have no spatial bound.
export function belt_link_area(entity: LuaEntity): Area | undefined {
  if (entity.type === 'linked-belt') return undefined
  if (entity.type !== 'underground-belt') return grown(entity_area(entity), 2)
  const reach = entity.prototype?.max_underground_distance
  if (reach === undefined || reach !== reach || reach < 0 || reach > 4096) return undefined
  return grown(entity_area(entity), reach + 2)
}
