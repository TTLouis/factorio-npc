// Bounded native facts, never placement authority or an instruction to modify a plan.
export const TOPOLOGY_PREFIX = 'fresh_topology: '
export const TOPOLOGY_LIMITS = Object.freeze({ chars: 1950, rawChars: 49152, entities: 4, radius: 32, scan: 16, reads: 3 })

// Loaded details live in the task prefix. Under packet pressure their duplicate
// ID-only record must not evict live geometry from the separate topology slot.
export function deduplicateTopologySkillRefs(messages) {
  const packet = row => row.role === 'user' && (String(row.content).startsWith('[HANDOFF]') || String(row.content).startsWith('--- step block ---'))
  const chars = messages.filter(packet).reduce((sum, row) => sum + row.content.length + 1, 0)
  const skillContext = messages.findLast(row => row.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[SKILL_CONTEXT]'))?.content
  if (!chars || chars + TOPOLOGY_LIMITS.chars <= 6000 || !skillContext?.startsWith('[SKILL_CONTEXT]')) return { messages, removed: 0 }
  let details
  try { details = JSON.parse(skillContext.slice(skillContext.indexOf('\n') + 1)) }
  catch { return { messages, removed: 0 } }
  if (!Array.isArray(details)) return { messages, removed: 0 }
  const loaded = new Set(details.map(skill => skill?.id).filter(id => typeof id === 'string'))
  let removed = 0
  const result = messages.map(row => {
    if (!packet(row) || !row.content.startsWith('--- step block ---')) return row
    const content = row.content.split('\n').filter(line => {
      if (!line.startsWith('loaded_skills: ')) return true
      const ids = line.slice('loaded_skills: '.length).split(', ')
      if (!ids.length || !ids.every(id => loaded.has(id))) return true
      removed += line.length + 1
      return false
    }).join('\n')
    return content === row.content ? row : { ...row, content }
  })
  return { messages: result, removed }
}
const name = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value) ? value : undefined
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : undefined
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : undefined
const position = value => number(value?.x) !== undefined && number(value?.y) !== undefined ? { x: value.x, y: value.y } : undefined
const unitNumber = value => Number.isSafeInteger(value) && value > 0 ? value : undefined
export function topologyJson(raw) {
  if (typeof raw !== 'string' || raw.length > TOPOLOGY_LIMITS.rawChars) return undefined
  try { const value = JSON.parse(raw); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined }
  catch { return undefined }
}
const cleanScalars = (value, keys) => Object.fromEntries(keys.flatMap(key => {
  const item = value?.[key]
  return typeof item === 'boolean' || number(item) !== undefined || name(item) ? [[key, item]] : []
}))
// A drill or inserter output point and what receives it, as getEntityStatus
// reports them, so a fresh executor can address the machine it already built.
function itemDrop(io) {
  const at = position(io?.drop_position)
  if (!at) return {}
  const target = io.drop_target ? cleanScalars(io.drop_target, ['name', 'unit_number']) : undefined
  return { drop_position: at, ...(target && Object.keys(target).length ? { drop_target: target } : {}) }
}
function fluidSummary(fluid) {
  if (!fluid || !Array.isArray(fluid.storages)) return undefined
  return fluid.storages.slice(0, 2).map(storage => ({
    ...cleanScalars(storage, ['index', 'filter', 'fluid', 'amount', 'temperature', 'capacity']),
    truncated: storage.connections_truncated === true || (storage.connections?.length ?? 0) > 3,
    ...(storage.contents ? { contents: cleanScalars(storage.contents, ['name', 'amount', 'temperature']) } : {}),
    ports: (Array.isArray(storage.connections) ? storage.connections : []).slice(0, 3).map(port => ({
      ...cleanScalars(port, ['connection_index', 'direction', 'flow_direction', 'connected', 'reciprocal']),
      ...(position(port.position ?? port.tile) ? { tile: position(port.position ?? port.tile) } : {}),
      ...(position(port.target_position) ? { opens: position(port.target_position) } : {}),
      ...(port.target ? { target: cleanScalars(port.target, ['name', 'unit_number', 'storage_index']) } : {}),
    })),
  }))
}
export function topologyEntities(answer) {
  if (!answer || answer.ok === false || !Array.isArray(answer.entities) || integer(answer.observed_tick) === undefined || integer(answer.surface_index) === undefined) return undefined
  const relevant = answer.entities.filter(entity => entity && (entity.spatial?.fluid || entity.spatial?.power || entity.spatial?.item_io || ['boiler', 'generator', 'electric-pole'].includes(entity.type)))
    .sort((a, b) => Number(Boolean(b.spatial?.power?.prototype?.thermal)) - Number(Boolean(a.spatial?.power?.prototype?.thermal)) || Number(Boolean(b.spatial?.fluid)) - Number(Boolean(a.spatial?.fluid)))
  return { actor_id: integer(answer.actor_id), observed_tick: answer.observed_tick, surface_index: answer.surface_index, force_index: integer(answer.force_index),
    truncated: answer.truncated === true || relevant.length > TOPOLOGY_LIMITS.entities || relevant.some(entity => {
      const fluid = entity.spatial?.fluid
      return fluid?.storages_truncated === true || (fluid?.storages?.length ?? 0) > 2
        || (Array.isArray(fluid?.storages) && fluid.storages.some(storage => storage.connections_truncated === true || (storage.connections?.length ?? 0) > 3))
    }),
    entities: relevant.slice(0, TOPOLOGY_LIMITS.entities).map(entity => ({
      name: name(entity.name), type: name(entity.type), unit_number: unitNumber(entity.unit_number), position: position(entity.position), direction: integer(entity.direction),
      ...itemDrop(entity.spatial?.item_io),
      status: name(entity.status_name ?? entity.spatial?.power?.status_name),
      fluid: fluidSummary(entity.spatial?.fluid),
      fluid_truncated: entity.spatial?.fluid?.storages_truncated === true || (entity.spatial?.fluid?.storages?.length ?? 0) > 2,
      power: { ...cleanScalars(entity.spatial?.power, ['stored_energy_joules', 'electric_network_id']), ...cleanScalars(entity.spatial?.power?.prototype?.power, ['production_watts', 'consumption_watts', 'fluid_usage_per_second', 'maximum_temperature']) },
      thermal: cleanScalars(entity.spatial?.power?.prototype?.thermal, ['target_temperature', 'output_fluid', 'fluid_output_per_second_at_target', 'source', 'conditional_on', 'prototype_quality']),
    })),
  }
}
export function topologyCapacity(nearby, generator) {
  const capacity = []
  const engine = generator?.entity
  const use = engine?.power?.fluid_usage_per_second
  if (!(use > 0) || !Number.isFinite(use)) return capacity
  for (const entity of nearby?.entities ?? []) {
    const thermal = entity.thermal
    const rate = thermal?.fluid_output_per_second_at_target
    // These are compatible prototype maxima, not current output or a performance guarantee.
    if (!(rate > 0) || !Number.isFinite(rate) || !Number.isFinite(rate / use) || thermal.source !== 'running_prototype' || !name(thermal.output_fluid)
      || !(thermal.target_temperature > 0) || !(engine.power.maximum_temperature >= thermal.target_temperature)) continue
    const filter = engine?.fluidboxes?.[0]?.filter ?? engine?.fluid_filter ?? engine?.power?.fluid_filter
    if (filter !== thermal.output_fluid) continue
    const box = engine?.fluidboxes?.[0]
    if (number(box?.minimum_temperature) !== undefined && thermal.target_temperature < box.minimum_temperature) continue
    if (number(box?.maximum_temperature) !== undefined && thermal.target_temperature > box.maximum_temperature) continue
    capacity.push({ producer: entity.name, consumer: name(engine.name), fluid: thermal.output_fluid,
      producer_units_per_second: rate, consumer_units_per_second: use, consumers_per_producer: rate / use,
      state: 'conditional_prototype_capacity', prototype_quality: thermal.prototype_quality ?? 'unknown', condition: thermal.conditional_on ?? 'full_energy_supply_and_input_fluid_at_default_temperature' })
  }
  return capacity.slice(0, 2)
}
export function topologyObstruction(answer) {
  const facts = answer?.obstructions
  if (answer?.ok !== true || !facts || facts.source !== 'native_placement_checks' || integer(facts.observed_tick) === undefined
    || integer(facts.surface_index) === undefined || !Array.isArray(facts.samples)) return undefined
  return { label: 'rejected_footprint_samples_not_candidates', entity_name: name(answer.entity_name), actor_id: integer(facts.actor_id), ...cleanScalars(facts, ['source', 'observed_tick', 'surface_index', 'force_index', 'scope', 'examined_count', 'rejected_count', 'unknown_count']),
    truncated: facts.truncated === true || facts.samples.length > 2 || facts.samples.some(sample => (sample.terrain_tiles?.length ?? 0) > 3 || (sample.entities?.length ?? 0) > 3),
    samples: facts.samples.slice(0, 2).map(sample => ({ position: position(sample.position), direction: integer(sample.direction), unknown: sample.unknown !== false,
      terrain: (Array.isArray(sample.terrain_tiles) ? sample.terrain_tiles : []).slice(0, 3).map(tile => ({ name: name(tile.name), position: position(tile.position) })),
      entities: (Array.isArray(sample.entities) ? sample.entities : []).slice(0, 3).map(entity => ({ name: name(entity.name), position: position(entity.position) })),
    })),
    authority: 'sampled_obstructions_only_not_clearance_or_removal_permission' }
}
export function topologyText(facts, maxChars = TOPOLOGY_LIMITS.chars) {
  if (!facts) return ''
  const bounded = structuredClone(facts)
  let text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
  // Keep the first (thermal producer) and sampled obstacles ahead of peripheral entities.
  while (text.length > maxChars && bounded.entities?.length > 1) {
    bounded.entities.pop(); bounded.truncated = true; text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
  }
  const drop = ['entities', 'obstructions', 'capacity']
  for (const key of drop) {
    while (text.length > maxChars && bounded[key]?.length) {
      bounded[key].pop(); bounded.truncated = true
      text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
    }
  }
  if (text.length > maxChars) return TOPOLOGY_PREFIX + JSON.stringify({ state: 'unavailable', reason: 'size_limit', truncated: true })
  return text
}

// Room a restage packet leaves for the fresh_topology block the next provider request inserts after it (protocol 3 keeps the
// geometry slot out of the packet). None when no block is produced; the block's own length plus the line break that joins it when a
// fresh read is in hand; the whole slot when the read was deferred or unavailable, because the request takes a fresh read that
// can be larger. Never above the slot, so packet and block together stay within the same 6000 characters.
export function topologyReserve(facts) {
  if (!facts) return 0
  if (facts.state !== 'fresh') return TOPOLOGY_LIMITS.chars
  return Math.min(TOPOLOGY_LIMITS.chars, topologyText(facts).length + 1)
}

// The block a request sends in the room the packet left. The packet was sized from the block measured at its restage, and a later
// read can be larger (an obstruction sample, a re-read), so the trimmed or omitted share is reported for a trace, never silent.
export function fitTopologyBlock(facts, room) {
  const full = topologyText(facts)
  const text = room >= 120 ? topologyText(facts, room) : ''
  return { text, full_chars: full.length, sent_chars: text.length, trimmed: text !== full, omitted: !text }
}

// Run AJ (2026-10-21): the C3 packet was sized while fresh_topology had no entities (a 679-char reserve). After the batch placed the
// offshore pump, the block was 1,080 chars in a 734-char room, and fitTopologyBlock trimmed the pump away while the packet still
// carried 11 historical fluid-source anchors. When the live block does not fit, a provider request may shed these packet lines from
// its own copy, in this order, until the block fits:
//  - Jev advisory facts, the ending conversation's note, and historical entity counts. All of them drop before topology in
//    HANDOFF_DROP_ORDER.
//  - Then, only when the block carries live entities, fluid-source anchors one at a time from the tail. The record lists the
//    anchors the step needs first and the newest first, so the tail is the lowest priority. The "(+N more)" count reports the cut,
//    and the line goes only when no anchor is left.
// Nothing else is touched: no mandatory record, review notes, residual, receipt or contract. The canonical conversation is not
// mutated. Packet and block together stay within the same 6,000 characters, because the room is recomputed from what is left.
const SHED_LINES = Object.freeze([
  { record: 'jev_facts', match: line => line.startsWith('jev_fact[') || line.startsWith('jev_fact_hint ') },
  { record: 'note', match: line => line.startsWith('note (UNVERIFIED') },
  { record: 'historical_entities', match: line => line.startsWith('historical_entities (') },
])
export const FLUID_HINTS_LINE_PREFIX = 'fluid_source_hints (HISTORICAL'
const MORE_HINTS = /^\(\+(\d+) more\)$/
const isPacketRow = row => row?.role === 'user' && typeof row.content === 'string' && (row.content.startsWith('[HANDOFF]') || row.content.startsWith('--- step block ---'))

// The hints line with anchors cut from its tail until `need` characters are saved, or undefined when the whole line must go.
function shorterHintsLine(line, need) {
  const head = line.indexOf('): ')
  if (head < 0) return { line: undefined, removed: 0 }
  const label = line.slice(0, head + 3)
  const parts = line.slice(head + 3).split(' | ')
  let more = 0
  const tail = MORE_HINTS.exec(parts.at(-1) ?? '')
  if (tail) { more = Number(tail[1]); parts.pop() }
  let removed = 0
  let text = line
  while (line.length - text.length < need && parts.length > 1) {
    parts.pop(); removed++; more++
    text = `${label}${parts.join(' | ')} | (+${more} more)`
  }
  if (line.length - text.length < need) return { line: undefined, removed: removed + parts.length }
  return { line: text, removed }
}

export function reclaimTopologyRoom(messages, need, { liveEntities = false } = {}) {
  const shed = []
  let reclaimed = 0
  if (!Array.isArray(messages) || !(need > 0)) return { messages, reclaimed, shed }
  const rows = messages.map(row => isPacketRow(row) ? row.content.split('\n') : undefined)
  const note = (record, chars, extra = {}) => {
    const held = shed.find(entry => entry.record === record)
    if (held) { held.chars += chars; held.lines_removed += extra.lines_removed ?? 0; held.hints_removed = (held.hints_removed ?? 0) + (extra.hints_removed ?? 0) }
    else shed.push({ record, chars, lines_removed: extra.lines_removed ?? 0, ...(extra.hints_removed !== undefined ? { hints_removed: extra.hints_removed } : {}) })
  }
  // Line 0 of a row is its header ([HANDOFF] / --- step block ---) and is never shed.
  for (const { record, match } of SHED_LINES) {
    for (let r = rows.length - 1; r >= 0 && reclaimed < need; r--) {
      const lines = rows[r]
      for (let i = (lines?.length ?? 0) - 1; i >= 1 && reclaimed < need; i--) {
        if (!match(lines[i])) continue
        reclaimed += lines[i].length + 1
        note(record, lines[i].length + 1, { lines_removed: 1 })
        lines.splice(i, 1)
      }
    }
  }
  if (liveEntities) {
    for (let r = rows.length - 1; r >= 0 && reclaimed < need; r--) {
      const lines = rows[r]
      for (let i = (lines?.length ?? 0) - 1; i >= 1 && reclaimed < need; i--) {
        if (!lines[i].startsWith(FLUID_HINTS_LINE_PREFIX)) continue
        const before = lines[i]
        const cut = shorterHintsLine(before, need - reclaimed)
        if (cut.line === undefined) {
          lines.splice(i, 1)
          reclaimed += before.length + 1
          note('fluid_source_hints', before.length + 1, { lines_removed: 1, hints_removed: cut.removed })
        }
        else {
          lines[i] = cut.line
          reclaimed += before.length - cut.line.length
          note('fluid_source_hints', before.length - cut.line.length, { hints_removed: cut.removed })
        }
      }
    }
  }
  if (reclaimed === 0) return { messages, reclaimed, shed }
  return {
    messages: messages.map((row, index) => rows[index] && rows[index].join('\n') !== row.content ? { ...row, content: rows[index].join('\n') } : row),
    reclaimed,
    shed,
  }
}