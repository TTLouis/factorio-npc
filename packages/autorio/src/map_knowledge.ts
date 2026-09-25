import type { LuaForce, LuaSurface } from 'factorio:runtime'

// The NPC's own map knowledge (docs/NPC_CHARACTER_ARCHITECTURE.md, "Map
// knowledge"). With zero connected players Factorio charts nothing for the
// force, so map operations read this record as well as the engine's chart.

// Chunks within this many chunks of the NPC are loaded and visible: a 5x5 area.
export const KNOWLEDGE_CHUNK_RADIUS = 2
// How many explored chunks a sync pushes to the force chart per tick.
const PUSH_CHUNKS_PER_TICK = 8

interface ChunkPosition { x: number, y: number }

interface KnownChunk { surface_index: number, x: number, y: number }

interface MapKnowledge {
  force_index: number
  explored: Record<string, KnownChunk>
  visible_surface_index?: number
  visible_chunk_x?: number
  visible_chunk_y?: number
  push_queue: KnownChunk[]
}

declare const storage: {
  airi_map_knowledge?: MapKnowledge
}

function chunk_key(surface_index: number, x: number, y: number) {
  return `${surface_index}:${x}:${y}`
}

function knowledge_for(force: LuaForce): MapKnowledge | undefined {
  const knowledge = storage.airi_map_knowledge
  if (!knowledge || knowledge.force_index !== force.index) return undefined
  return knowledge
}

function in_visible_window(knowledge: MapKnowledge, surface: LuaSurface, chunk: ChunkPosition) {
  if (knowledge.visible_surface_index !== surface.index) return false
  if (knowledge.visible_chunk_x === undefined || knowledge.visible_chunk_y === undefined) return false
  return math.abs(chunk.x - knowledge.visible_chunk_x) <= KNOWLEDGE_CHUNK_RADIUS
    && math.abs(chunk.y - knowledge.visible_chunk_y) <= KNOWLEDGE_CHUNK_RADIUS
}

export function is_chunk_known_charted(force: LuaForce, surface: LuaSurface, chunk: ChunkPosition) {
  if (force.is_chunk_charted(surface, chunk)) return true
  const knowledge = knowledge_for(force)
  return knowledge !== undefined && knowledge.explored[chunk_key(surface.index, chunk.x, chunk.y)] !== undefined
}

export function is_chunk_known_visible(force: LuaForce, surface: LuaSurface, chunk: ChunkPosition) {
  if (force.is_chunk_visible(surface, chunk)) return true
  const knowledge = knowledge_for(force)
  return knowledge !== undefined && in_visible_window(knowledge, surface, chunk)
}

function chunk_area(x: number, y: number) {
  return {
    left_top: { x: x * 32, y: y * 32 },
    right_bottom: { x: x * 32 + 31, y: y * 32 + 31 },
  }
}

// Record the 5x5 window around the NPC's chunk as visible and explored, and
// chart it for the force so players see it (the chart has no effect while no
// player is connected; the join sync pushes it again then).
export function observe_window(force: LuaForce, surface: LuaSurface, center_x: number, center_y: number) {
  let knowledge = storage.airi_map_knowledge
  if (!knowledge || knowledge.force_index !== force.index) {
    knowledge = { force_index: force.index, explored: {}, push_queue: [] }
    storage.airi_map_knowledge = knowledge
  }
  knowledge.visible_surface_index = surface.index
  knowledge.visible_chunk_x = center_x
  knowledge.visible_chunk_y = center_y
  for (let x = center_x - KNOWLEDGE_CHUNK_RADIUS; x <= center_x + KNOWLEDGE_CHUNK_RADIUS; x++) {
    for (let y = center_y - KNOWLEDGE_CHUNK_RADIUS; y <= center_y + KNOWLEDGE_CHUNK_RADIUS; y++) {
      knowledge.explored[chunk_key(surface.index, x, y)] = { surface_index: surface.index, x, y }
    }
  }
  force.chart(surface, {
    left_top: { x: (center_x - KNOWLEDGE_CHUNK_RADIUS) * 32, y: (center_y - KNOWLEDGE_CHUNK_RADIUS) * 32 },
    right_bottom: { x: (center_x + KNOWLEDGE_CHUNK_RADIUS) * 32 + 31, y: (center_y + KNOWLEDGE_CHUNK_RADIUS) * 32 + 31 },
  })
}

// Push: queue every explored chunk to be charted for the force, for example
// when a player joins and can now receive the chart.
export function queue_full_push() {
  const knowledge = storage.airi_map_knowledge
  if (!knowledge) return
  const queue: KnownChunk[] = []
  for (const [, chunk] of pairs(knowledge.explored)) queue.push(chunk)
  knowledge.push_queue = queue
}

export function drain_push_queue(force: LuaForce) {
  const knowledge = knowledge_for(force)
  if (!knowledge || knowledge.push_queue.length === 0) return 0
  let pushed = 0
  while (pushed < PUSH_CHUNKS_PER_TICK && knowledge.push_queue.length > 0) {
    const chunk = knowledge.push_queue.pop() as KnownChunk
    pushed++
    const surface = game.get_surface(chunk.surface_index as LuaSurface['index'])
    if (!surface || !surface.valid) continue
    force.chart(surface, chunk_area(chunk.x, chunk.y))
  }
  return pushed
}

// Pull: add chunks the engine has charted for the force (for example by a
// player exploring) to the NPC's explored record.
export function pull_engine_chart(force: LuaForce, surface: LuaSurface) {
  let knowledge = storage.airi_map_knowledge
  if (!knowledge || knowledge.force_index !== force.index) {
    knowledge = { force_index: force.index, explored: {}, push_queue: [] }
    storage.airi_map_knowledge = knowledge
  }
  let added = 0
  for (const chunk of surface.get_chunks()) {
    const key = chunk_key(surface.index, chunk.x, chunk.y)
    if (knowledge.explored[key] !== undefined) continue
    if (!force.is_chunk_charted(surface, chunk)) continue
    knowledge.explored[key] = { surface_index: surface.index, x: chunk.x, y: chunk.y }
    added++
  }
  return added
}

export function map_knowledge_summary(force: LuaForce) {
  const knowledge = knowledge_for(force)
  if (!knowledge) return { explored_chunks: 0, push_queue: 0 }
  let explored = 0
  for (const [_key] of pairs(knowledge.explored)) explored++
  return {
    explored_chunks: explored,
    push_queue: knowledge.push_queue.length,
    visible_center: knowledge.visible_surface_index === undefined
      ? undefined
      : { surface_index: knowledge.visible_surface_index, x: knowledge.visible_chunk_x, y: knowledge.visible_chunk_y },
  }
}
