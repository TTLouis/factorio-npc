import { HANDOFF_PACKET_MAX_CHARS, handoffPacketChars, isHandoffPacketRow as isPacketRow } from './handoff-format.mjs'

// Bounded native facts, never placement authority or an instruction to modify a plan.
export const TOPOLOGY_PREFIX = 'fresh_topology: '
export const TOPOLOGY_LIMITS = Object.freeze({ chars: 1950, rawChars: 49152, entities: 4, radius: 32, scan: 16, reads: 3 })

// Loaded details live in the task prefix. Under packet pressure their duplicate
// ID-only record must not evict live geometry from the separate topology slot.
export function deduplicateTopologySkillRefs(messages) {
  const chars = handoffPacketChars(messages)
  const skillContext = messages.findLast(row => row.role === 'user' && typeof row.content === 'string' && row.content.startsWith('[SKILL_CONTEXT]'))?.content
  if (!chars || chars + TOPOLOGY_LIMITS.chars <= HANDOFF_PACKET_MAX_CHARS || !skillContext?.startsWith('[SKILL_CONTEXT]')) return { messages, removed: 0 }
  let details
  try { details = JSON.parse(skillContext.slice(skillContext.indexOf('\n') + 1)) }
  catch { return { messages, removed: 0 } }
  if (!Array.isArray(details)) return { messages, removed: 0 }
  const loaded = new Set(details.map(skill => skill?.id).filter(id => typeof id === 'string'))
  let removed = 0
  const result = messages.map(row => {
    if (!isPacketRow(row) || !row.content.startsWith('--- step block ---')) return row
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
// What a block over its room gives up before any live entity (Run AJ, 2026-10-21): the block was cut to fit a room its packet left
// while it was empty, and the entity the batch had just placed was the first thing to go.
//  1. The lossless part: an entity's empty power/thermal summary and false truncation flags, whose absence says the same thing.
//  2. Fields that carry no world fact: the expansion advice, the session and the read reason.
//  3. The held counts with their scope, but only when the same request already shows a live inventory read (`heldShown`: the
//     post-batch facts after a batch). Otherwise held counts outlast entities, as before.
// Each dropped group is named in `fields_omitted` and sets `truncated`.
const TOPOLOGY_SUMMARY_GROUPS = Object.freeze([['expansion'], ['session'], ['reason'], ['held', 'held_scope', 'held_omitted']])
const isEmptyObject = value => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
function compactEntity(entity) {
  if (!entity || typeof entity !== 'object') return entity
  const out = { ...entity }
  for (const key of ['power', 'thermal']) if (isEmptyObject(out[key])) delete out[key]
  if (out.fluid_truncated === false) delete out.fluid_truncated
  if (Array.isArray(out.fluid)) out.fluid = out.fluid.map(storage => storage?.truncated === false ? Object.fromEntries(Object.entries(storage).filter(([key]) => key !== 'truncated')) : storage)
  return out
}

export function topologyText(facts, maxChars = TOPOLOGY_LIMITS.chars, { heldShown = false } = {}) {
  if (!facts) return ''
  const bounded = structuredClone(facts)
  let text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
  if (text.length > maxChars && Array.isArray(bounded.entities)) {
    bounded.entities = bounded.entities.map(compactEntity)
    text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
  }
  for (const group of TOPOLOGY_SUMMARY_GROUPS) {
    if (text.length <= maxChars) break
    if (group[0] === 'held' && !heldShown) continue
    if (!group.some(key => bounded[key] !== undefined)) continue
    for (const key of group) delete bounded[key]
    bounded.truncated = true
    bounded.fields_omitted = [...(bounded.fields_omitted ?? []), group[0]]
    text = TOPOLOGY_PREFIX + JSON.stringify(bounded)
  }
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
export function fitTopologyBlock(facts, room, options = {}) {
  const full = topologyText(facts)
  const text = room >= 120 ? topologyText(facts, room, options) : ''
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
// Fluid-source anchors of a fluid the step's own unplaced entities carry are never shed. The packet keeps those in its late
// 'fluid_source_hints_for_step' tier because they cannot be re-read once the actor leaves (HANDOFF_DROP_ORDER), and it names those
// fluids at the end of the line (FLUID_HINTS_STEP_MARK). A line without the mark serves no step fluid; its packet tier is the
// early 'fluid_source_hints' one. When step anchors leave too little room, the block makes room inside itself instead (topologyText).
const SHED_LINES = Object.freeze([
  { record: 'jev_facts', match: line => line.startsWith('jev_fact[') || line.startsWith('jev_fact_hint ') },
  { record: 'note', match: line => line.startsWith('note (UNVERIFIED') },
  { record: 'historical_entities', match: line => line.startsWith('historical_entities (') },
])
export const FLUID_HINTS_LINE_PREFIX = 'fluid_source_hints (HISTORICAL'
// Ends a fluid_source_hints line whose anchors include fluids the active step still places entities for: ` [serves this step: water]`.
export const FLUID_HINTS_STEP_MARK = ' [serves this step: '
const STEP_MARK = / \[serves this step: ([a-z0-9._-]+(?:,[a-z0-9._-]+)*)\]$/
const MORE_HINTS = /^\(\+(\d+) more\)$/

// The hints line with anchors of no step fluid cut from its tail until `need` characters are saved. `line` is undefined when no
// anchor is left (only possible without step anchors); `saved` counts the characters freed, `kept_step` the step anchors kept.
function shorterHintsLine(line, need) {
  const mark = STEP_MARK.exec(line)
  const stepFluids = new Set(mark ? mark[1].split(',') : [])
  const body = mark ? line.slice(0, mark.index) : line
  const suffix = mark ? mark[0] : ''
  const head = body.indexOf('): ')
  if (head < 0) return { line, removed: 0, saved: 0, kept_step: 0, step_fluids: [...stepFluids] }
  const label = body.slice(0, head + 3)
  const parts = body.slice(head + 3).split(' | ')
  let more = 0
  const tail = MORE_HINTS.exec(parts.at(-1) ?? '')
  if (tail) { more = Number(tail[1]); parts.pop() }
  const fluidOf = part => part.slice(0, Math.max(0, part.indexOf(':')))
  let removed = 0
  let text = line
  while (line.length - text.length < need && parts.length > 0 && !stepFluids.has(fluidOf(parts.at(-1)))) {
    parts.pop(); removed++; more++
    text = parts.length > 0 ? `${label}${parts.join(' | ')} | (+${more} more)${suffix}` : ''
  }
  const keptStep = parts.filter(part => stepFluids.has(fluidOf(part))).length
  if (parts.length === 0) return { line: undefined, removed, saved: line.length + 1, kept_step: 0, step_fluids: [...stepFluids] }
  return { line: text, removed, saved: line.length - text.length, kept_step: keptStep, step_fluids: [...stepFluids] }
}

export function reclaimTopologyRoom(messages, need, { liveEntities = false } = {}) {
  const shed = []
  let reclaimed = 0
  if (!Array.isArray(messages) || !(need > 0)) return { messages, reclaimed, shed }
  const rows = messages.map(row => isPacketRow(row) ? row.content.split('\n') : undefined)
  const note = (record, chars, extra = {}) => {
    const held = shed.find(entry => entry.record === record)
    if (held) {
      held.chars += chars; held.lines_removed += extra.lines_removed ?? 0; held.hints_removed = (held.hints_removed ?? 0) + (extra.hints_removed ?? 0)
      if (extra.step_anchors_kept !== undefined) held.step_anchors_kept = (held.step_anchors_kept ?? 0) + extra.step_anchors_kept
    }
    else shed.push({ record, chars, lines_removed: extra.lines_removed ?? 0, ...extra })
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
        const cut = shorterHintsLine(lines[i], need - reclaimed)
        if (cut.saved <= 0) continue
        if (cut.line === undefined) lines.splice(i, 1)
        else lines[i] = cut.line
        reclaimed += cut.saved
        note('fluid_source_hints', cut.saved, { lines_removed: cut.line === undefined ? 1 : 0, hints_removed: cut.removed,
          step_anchors_kept: cut.kept_step, ...(cut.step_fluids.length ? { step_fluids: cut.step_fluids } : {}) })
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
