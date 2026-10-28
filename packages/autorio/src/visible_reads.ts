import type { LuaEntity, LuaForce, LuaSurface } from 'factorio:runtime'
import { area_known_visible } from './map_knowledge'

// Reads that reach past an entity the NPC sees now (M3): the neighbours the engine links to it and the areas a summary
// scans around it. A neighbour or area in a chunk the NPC does not see now is unknown, never absent or disconnected:
// nothing there is read, so the answer is the same whether a fogged neighbour still stands.

interface Point { x: number, y: number }
interface Area { left_top: Point, right_bottom: Point }

export type SeenArea = (area: Area) => boolean

// Pipe-to-ground pairs link up to 10 tiles apart in vanilla: an underground link is read only when this far around the
// entity is seen (the margin topology uses for its own scan).
export const UNDERGROUND_LINK_REACH = 12

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
  if (seen !== undefined && area !== undefined && !seen(area)) return { seen: false as const }
  const entity = read()
  if (seen !== undefined && entity !== undefined && entity.valid && !seen(entity_area(entity))) return { seen: false as const }
  return { seen: true as const, entity }
}

// Where a pipe connection's neighbour can be: next to its target position, or for an underground link anywhere within
// reach of the entity (the far end is not a fixed tile).
export function pipe_link_area(entity: LuaEntity, connection: { position: Point, target_position?: Point, connection_type?: string }): Area {
  if (connection.connection_type === 'underground') return grown(entity_area(entity), UNDERGROUND_LINK_REACH)
  const target = connection.target_position ?? connection.position
  return {
    left_top: { x: math.min(connection.position.x, target.x), y: math.min(connection.position.y, target.y) },
    right_bottom: { x: math.max(connection.position.x, target.x), y: math.max(connection.position.y, target.y) },
  }
}
