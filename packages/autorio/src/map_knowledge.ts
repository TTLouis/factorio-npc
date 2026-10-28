import type { LuaForce, LuaSurface } from 'factorio:runtime'

// The NPC's own map knowledge (docs/NPC_CHARACTER_ARCHITECTURE.md, "Map
// knowledge"). With zero connected players Factorio charts nothing for the
// force, so map operations read this record as well as the engine's chart.

// Chunks within this many chunks of the NPC are loaded and visible: a 5x5 area.
export const KNOWLEDGE_CHUNK_RADIUS = 2
// How many explored chunks a sync pushes to the force chart per tick.
const PUSH_CHUNKS_PER_TICK = 8
// A map crop is at most (2r+1)^2 chunks: 9x9 = 81 cells, one character each.
export const MAP_CROP_MAX_RADIUS = 4
export const MAP_CROP_DEFAULT_RADIUS = 3

interface ChunkPosition { x: number, y: number }

interface KnownChunk { surface_index: number, x: number, y: number }

interface MapKnowledge {
  force_index: number
  explored: Record<string, KnownChunk>
  visible_surface_index?: number
  visible_chunk_x?: number
  visible_chunk_y?: number
  push_queue: KnownChunk[]
  // Counts every change of what the NPC knows: the visible window moved or a chunk joined the explored record. A crop and a
  // candidate answer carrying the same revision were read against the same knowledge. A save from before the counter reads 0.
  revision?: number
}

interface WorldArea { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }

declare const storage: {
  sgluna_map_knowledge?: MapKnowledge
}

function chunk_key(surface_index: number, x: number, y: number) {
  return `${surface_index}:${x}:${y}`
}

function knowledge_for(force: LuaForce): MapKnowledge | undefined {
  const knowledge = storage.sgluna_map_knowledge
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

// The chunks a world box reads. Never empty: a zero-size box (or a point) still reads the chunk it lies in, and a box ending
// exactly on a chunk edge does not read the next chunk.
export function box_chunk_range(box: WorldArea) {
  const min_x = math.floor(box.left_top.x / 32)
  const min_y = math.floor(box.left_top.y / 32)
  return {
    min_x,
    min_y,
    max_x: math.max(min_x, math.floor((box.right_bottom.x - 0.001) / 32)),
    max_y: math.max(min_y, math.floor((box.right_bottom.y - 0.001) / 32)),
  }
}

// Whether every chunk a world box reads is visible to the NPC now. This is the one rule for live-world authority: a read
// that names facts (an entity, a free footprint) or grants execution covers only chunks seen now. A fogged chunk was seen
// before and an unknown chunk never; neither is probed.
export function area_known_visible(force: LuaForce, surface: LuaSurface, box: WorldArea) {
  const range = box_chunk_range(box)
  for (let chunk_x = range.min_x; chunk_x <= range.max_x; chunk_x++) {
    for (let chunk_y = range.min_y; chunk_y <= range.max_y; chunk_y++) {
      if (!is_chunk_known_visible(force, surface, { x: chunk_x, y: chunk_y })) return false
    }
  }
  return true
}

export function knowledge_revision(force: LuaForce) {
  return knowledge_for(force)?.revision ?? 0
}

function bump_revision(knowledge: MapKnowledge) {
  knowledge.revision = (knowledge.revision ?? 0) + 1
}

// How much of a world area this knowledge covers, counted in whole chunks: charted (explored) and, of those, visible now.
// fogged chunks were seen before but are not observed now; uncharted chunks were never seen.
export function chunk_coverage(force: LuaForce, surface: LuaSurface, area: { left_top: { x: number, y: number }, right_bottom: { x: number, y: number } }) {
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
      if (is_chunk_known_charted(force, surface, chunk)) charted_chunks++
      if (is_chunk_known_visible(force, surface, chunk)) visible_chunks++
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
  let knowledge = storage.sgluna_map_knowledge
  if (!knowledge || knowledge.force_index !== force.index) {
    knowledge = { force_index: force.index, explored: {}, push_queue: [] }
    storage.sgluna_map_knowledge = knowledge
  }
  let changed = knowledge.visible_surface_index !== surface.index || knowledge.visible_chunk_x !== center_x || knowledge.visible_chunk_y !== center_y
  knowledge.visible_surface_index = surface.index
  knowledge.visible_chunk_x = center_x
  knowledge.visible_chunk_y = center_y
  for (let x = center_x - KNOWLEDGE_CHUNK_RADIUS; x <= center_x + KNOWLEDGE_CHUNK_RADIUS; x++) {
    for (let y = center_y - KNOWLEDGE_CHUNK_RADIUS; y <= center_y + KNOWLEDGE_CHUNK_RADIUS; y++) {
      const key = chunk_key(surface.index, x, y)
      if (knowledge.explored[key] === undefined) changed = true
      knowledge.explored[key] = { surface_index: surface.index, x, y }
    }
  }
  if (changed) bump_revision(knowledge)
  force.chart(surface, {
    left_top: { x: (center_x - KNOWLEDGE_CHUNK_RADIUS) * 32, y: (center_y - KNOWLEDGE_CHUNK_RADIUS) * 32 },
    right_bottom: { x: (center_x + KNOWLEDGE_CHUNK_RADIUS) * 32 + 31, y: (center_y + KNOWLEDGE_CHUNK_RADIUS) * 32 + 31 },
  })
}

// Push: queue every explored chunk to be charted for the force, for example
// when a player joins and can now receive the chart.
export function queue_full_push() {
  const knowledge = storage.sgluna_map_knowledge
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
  let knowledge = storage.sgluna_map_knowledge
  if (!knowledge || knowledge.force_index !== force.index) {
    knowledge = { force_index: force.index, explored: {}, push_queue: [] }
    storage.sgluna_map_knowledge = knowledge
  }
  let added = 0
  for (const chunk of surface.get_chunks()) {
    const key = chunk_key(surface.index, chunk.x, chunk.y)
    if (knowledge.explored[key] !== undefined) continue
    if (!force.is_chunk_charted(surface, chunk)) continue
    knowledge.explored[key] = { surface_index: surface.index, x: chunk.x, y: chunk.y }
    added++
  }
  if (added > 0) bump_revision(knowledge)
  return added
}

export function map_knowledge_summary(force: LuaForce) {
  const knowledge = knowledge_for(force)
  if (!knowledge) return { explored_chunks: 0, push_queue: 0, revision: 0 }
  let explored = 0
  for (const [_key] of pairs(knowledge.explored)) explored++
  return {
    explored_chunks: explored,
    push_queue: knowledge.push_queue.length,
    revision: knowledge.revision ?? 0,
    visible_center: knowledge.visible_surface_index === undefined
      ? undefined
      : { surface_index: knowledge.visible_surface_index, x: knowledge.visible_chunk_x, y: knowledge.visible_chunk_y },
  }
}

// A bounded picture of what the NPC knows around one chunk, read from this record and the engine only: nothing is charted,
// generated or written. rows[i][j] is chunk (origin.chunk.x + j, origin.chunk.y + i), north to south and west to east:
// V visible now, F explored but fogged (an old observation, not a fresh fact), U never explored. Explored chunks the crop
// leaves out are counted, so a reader knows the crop is not the whole record.
export function map_crop(force: LuaForce, surface: LuaSurface, center: ChunkPosition, radius: number) {
  const knowledge = knowledge_for(force)
  const origin = { x: center.x - radius, y: center.y - radius }
  const rows: string[] = []
  let visible = 0
  let fogged = 0
  let unknown = 0
  for (let y = origin.y; y <= center.y + radius; y++) {
    let row = ''
    for (let x = origin.x; x <= center.x + radius; x++) {
      const chunk = { x, y }
      if (is_chunk_known_visible(force, surface, chunk)) {
        row += 'V'
        visible++
      }
      else if (is_chunk_known_charted(force, surface, chunk)) {
        row += 'F'
        fogged++
      }
      else {
        row += 'U'
        unknown++
      }
    }
    rows.push(row)
  }

  let explored_on_surface = 0
  let explored_outside_crop = 0
  let bounds: { min: ChunkPosition, max: ChunkPosition } | undefined
  if (knowledge) {
    for (const [, chunk] of pairs(knowledge.explored)) {
      if (chunk.surface_index !== surface.index) continue
      explored_on_surface++
      if (math.abs(chunk.x - center.x) > radius || math.abs(chunk.y - center.y) > radius) explored_outside_crop++
      if (bounds === undefined) bounds = { min: { x: chunk.x, y: chunk.y }, max: { x: chunk.x, y: chunk.y } }
      else {
        bounds.min.x = math.min(bounds.min.x, chunk.x)
        bounds.min.y = math.min(bounds.min.y, chunk.y)
        bounds.max.x = math.max(bounds.max.x, chunk.x)
        bounds.max.y = math.max(bounds.max.y, chunk.y)
      }
    }
  }
  const window = knowledge !== undefined && knowledge.visible_surface_index === surface.index && knowledge.visible_chunk_x !== undefined
    ? { chunk: { x: knowledge.visible_chunk_x, y: knowledge.visible_chunk_y }, chunk_radius: KNOWLEDGE_CHUNK_RADIUS }
    : undefined

  return {
    source: 'npc_map_knowledge',
    surface_index: surface.index,
    surface_name: surface.name,
    force_index: force.index,
    observed_tick: game.tick,
    revision: knowledge?.revision ?? 0,
    chunk_size: 32,
    center_chunk: { x: center.x, y: center.y },
    radius_chunks: radius,
    origin: { chunk: origin, tile: { x: origin.x * 32, y: origin.y * 32 } },
    legend: 'V visible now; F explored, fogged (old observation, not fresh); U never explored',
    rows,
    counts: { visible, fogged, unknown, total: visible + fogged + unknown },
    visible_window: window,
    explored_record: { chunks_on_surface: explored_on_surface, outside_crop: explored_outside_crop, chunk_bounds: bounds },
  }
}
