// getActorSupplies: an external-only observation served from this session's own
// operation journal, never from the game. It lists each entity the NPC's submitted
// operations moved items into (move_items_exact with to_entity, supply_entity), so an
// operator can tell a machine the base supplies from one the agent is still serving.
// Fuel, science packs and chest stocking all count: the record names what was moved,
// not whether the move was allowed. Facts only; what counts for a goal is library content.

export const ACTOR_SUPPLIES = 'getActorSupplies'
export const MAX_ACTOR_SUPPLY_ENTITIES = 64

export const ACTOR_SUPPLIES_SCHEMA = Object.freeze({
  name: ACTOR_SUPPLIES,
  description: 'List the entities this session\'s own operations moved items into (move_items_exact with to_entity true, and supply_entity), from the external journal. No game call. Optional unit_number limits it to one entity.',
  inputSchema: Object.freeze({ type: 'object', additionalProperties: false,
    properties: Object.freeze({ unit_number: Object.freeze({ type: 'integer', minimum: 1, description: 'Only this target entity.' }) }) }),
})

export const ACTOR_SUPPLIES_NOTE = 'Served from this session\'s external journal, not the game: one row per target entity the NPC\'s own operations moved items into (move_items_exact with to_entity true, and supply_entity), including fuel, science packs and chest stocking. requested is what the operations asked for; actor_decrease is the drop in the NPC inventory for that item observed around each terminal operation (an observation, not a native per-entity count). Submissions refused before sending are not listed. state is as last recorded; read factorio_receipt for a running operation.'

function invalid(message) {
  return Object.assign(new Error(message), { code: 'invalid_observation_arguments', publicMessage: message, effect: 'not_happened' })
}

// The target and the items one journal record moved from the actor into an entity, or undefined.
function supplied(operation) {
  const args = operation?.args
  if (operation?.name === 'move_items_exact' && args?.to_entity === true) {
    return { unit_number: args.unit_number, items: [{ item_name: args.item_name, count: args.max_count }] }
  }
  if (operation?.name === 'supply_entity' && Array.isArray(args?.items)) {
    return { unit_number: args.unit_number, items: args.items.map(item => ({ item_name: item?.item_name, count: item?.count })) }
  }
  return undefined
}

function admissionTick(row) {
  const evidence = row.result?.evidence
  const tick = evidence?.admission?.tick ?? evidence?.tick
  return Number.isSafeInteger(tick) ? tick : null
}

export function actorSupplies(records, args = {}) {
  if (args === null || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => key !== 'unit_number')) {
    throw invalid('getActorSupplies takes only an optional unit_number. Nothing was sent to the game.')
  }
  if (args.unit_number !== undefined && !(Number.isSafeInteger(args.unit_number) && args.unit_number > 0)) {
    throw invalid('unit_number must be a positive integer. Nothing was sent to the game.')
  }
  const byEntity = new Map()
  let operations = 0
  for (const [index, row] of (records ?? []).entries()) {
    if (row?.effect === 'not_happened') continue
    const moved = supplied(row?.operation)
    if (!moved || !Number.isSafeInteger(moved.unit_number)) continue
    if (args.unit_number !== undefined && moved.unit_number !== args.unit_number) continue
    operations++
    const entity = byEntity.get(moved.unit_number) ?? { unit_number: moved.unit_number, operations: 0, states: {}, items: new Map(), order: index }
    byEntity.set(moved.unit_number, entity)
    entity.operations++
    entity.order = index
    entity.states[row.state] = (entity.states[row.state] ?? 0) + 1
    entity.last_operation_id = row.operation_id
    entity.last_tick = admissionTick(row) ?? entity.last_tick ?? null
    const observed = row.observed_effect?.available === true ? row.observed_effect.actor_items ?? {} : undefined
    for (const { item_name, count } of moved.items) {
      if (typeof item_name !== 'string') continue
      const item = entity.items.get(item_name) ?? { item_name, requested: 0, actor_decrease: 0, observed_operations: 0 }
      entity.items.set(item_name, item)
      if (Number.isSafeInteger(count) && count > 0) item.requested += count
      const delta = observed?.[item_name]?.delta
      if (Number.isSafeInteger(delta)) {
        item.observed_operations++
        if (delta < 0) item.actor_decrease -= delta
      }
    }
  }
  // Most recently supplied first, bounded.
  const all = [...byEntity.values()].sort((a, b) => b.order - a.order)
  const entities = all.slice(0, MAX_ACTOR_SUPPLY_ENTITIES).map(entity => ({
    unit_number: entity.unit_number, operations: entity.operations, states: entity.states,
    last_operation_id: entity.last_operation_id, last_tick: entity.last_tick,
    items: [...entity.items.values()].sort((a, b) => a.item_name.localeCompare(b.item_name)),
  }))
  return {
    observation: ACTOR_SUPPLIES, source: 'external_session_journal', world_read: false, current_world_verified: false,
    ...(args.unit_number !== undefined ? { unit_number: args.unit_number } : {}),
    operations, entity_count: all.length, truncated: all.length > entities.length, entities,
  }
}
