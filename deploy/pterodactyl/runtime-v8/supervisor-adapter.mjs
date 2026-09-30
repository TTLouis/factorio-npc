import { NpcAgentLoop as BaseNpcAgentLoop } from '../staging/npc-agent-loop.mjs'

const ENTITY_STATUS_TOOL = 'getEntityStatus'
const ENTITY_STATUS_BASELINE_LIMIT = 4
const ENTITY_STATUS_CONTEXT_CHARS = 12000
const NEARBY_ENTITIES_TOOL = 'getNearbyEntities'
const NEARBY_ENTITIES_BASELINE_LIMIT = 4
const NEARBY_ENTITIES_CONTEXT_CHARS = 18000
const INSTALL_MARK = Symbol.for('sgluna.runtime-v8.entity-status-diff')

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function boundedRadius(value) {
  if (!Number.isFinite(value)) return 8
  return Math.max(1, Math.min(32, Math.floor(value)))
}

function queryFor(args = {}) {
  return {
    name: String(args.name ?? '').slice(0, 200),
    radius: boundedRadius(args.radius),
  }
}

function queryKey(args) {
  return JSON.stringify(queryFor(args))
}

function entityReference(status, query) {
  if (status?.found !== true) return `entity-query:${query.name}@${query.radius}`
  const entity = status.entity
  if (Number.isSafeInteger(entity?.unit_number)) return `entity:${entity.unit_number}`
  const position = entity?.position
  return `entity-fallback:${entity?.name ?? query.name}:${entity?.type ?? 'unknown'}:${position?.x ?? '?'}:${position?.y ?? '?'}`
}

function decisionView(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined
  return {
    found: status.found === true,
    error: typeof status.error === 'string' ? status.error : undefined,
    entity: status.entity && typeof status.entity === 'object' && !Array.isArray(status.entity)
      ? status.entity
      : undefined,
  }
}

function changedEntity(previous, current) {
  const changes = {}
  const keys = new Set([
    ...Object.keys(previous ?? {}),
    ...Object.keys(current ?? {}),
  ])
  for (const key of keys) {
    if (!sameJson(previous?.[key], current?.[key])) changes[key] = current?.[key] ?? null
  }
  return changes
}

function fullObservation(status, query, reference, identityChanged) {
  return {
    observation_mode: 'full',
    source: 'live_factorio_entity_status',
    reference,
    query,
    ...(identityChanged ? { identity_changed: true } : {}),
    found: status.found === true,
    ...(status.error !== undefined ? { error: status.error } : {}),
    ...(status.actor_position !== undefined ? { actor_position: status.actor_position } : {}),
    ...(status.entity !== undefined ? { entity: status.entity } : {}),
  }
}

function diffObservation(previous, status, query, reference) {
  const current = decisionView(status)
  if (!current) return undefined
  if (!previous || previous.reference !== reference || previous.view.found !== current.found) {
    return fullObservation(status, query, reference, !!previous)
  }

  const changes = {}
  if (!sameJson(previous.view.error, current.error)) changes.error = current.error ?? null
  const entityChanges = changedEntity(previous.view.entity, current.entity)
  if (Object.keys(entityChanges).length > 0) changes.entity = entityChanges
  if (Object.keys(changes).length === 0) {
    return {
      observation_mode: 'unchanged',
      source: 'live_factorio_entity_status',
      reference,
      query,
    }
  }
  return {
    observation_mode: 'diff',
    source: 'live_factorio_entity_status',
    reference,
    query,
    changes,
  }
}

function ensureState(loop) {
  loop.entityStatusBaselines ??= new Map()
  loop.entityStatusBaselineOrder ??= []
}

function rememberBaseline(loop, key, entry) {
  ensureState(loop)
  loop.entityStatusBaselines.set(key, entry)
  const previousIndex = loop.entityStatusBaselineOrder.indexOf(key)
  if (previousIndex >= 0) loop.entityStatusBaselineOrder.splice(previousIndex, 1)
  loop.entityStatusBaselineOrder.push(key)
  while (loop.entityStatusBaselineOrder.length > ENTITY_STATUS_BASELINE_LIMIT) {
    const oldest = loop.entityStatusBaselineOrder.shift()
    if (oldest !== undefined) loop.entityStatusBaselines.delete(oldest)
  }
}

function baselineContext(loop) {
  ensureState(loop)
  const selected = []
  let chars = 0
  for (let index = loop.entityStatusBaselineOrder.length - 1; index >= 0; index--) {
    const entry = loop.entityStatusBaselines.get(loop.entityStatusBaselineOrder[index])
    if (!entry) continue
    const visible = {
      reference: entry.reference,
      query: entry.query,
      ...entry.view,
    }
    const candidateChars = JSON.stringify(visible).length
    if (selected.length > 0 && chars + candidateChars > ENTITY_STATUS_CONTEXT_CHARS) break
    selected.push(visible)
    chars += candidateChars
    if (selected.length >= ENTITY_STATUS_BASELINE_LIMIT) break
  }
  if (selected.length === 0) return ''
  selected.reverse()
  return `[ENTITY_STATUS_BASELINE] Last live mutable entity-status snapshots for this request. These snapshots may now be stale; use them only to interpret later getEntityStatus diff/unchanged responses. Re-observe live mutable state before depending on it.\n${JSON.stringify(selected)}`
}

function transformEntityStatus(loop, entry, resultMessage) {
  if (entry?.tool?.function?.name !== ENTITY_STATUS_TOOL) return
  const raw = String(resultMessage?.content ?? '')
  if (!raw || raw.startsWith('[HARNESS]')) return
  let status
  try { status = JSON.parse(raw) }
  catch { return }
  const view = decisionView(status)
  if (!view) return
  const query = queryFor(entry.args)
  const key = queryKey(entry.args)
  ensureState(loop)
  const previous = loop.entityStatusBaselines.get(key)
  const reference = entityReference(status, query)
  const providerObservation = diffObservation(previous, status, query, reference)
  if (!providerObservation) return
  rememberBaseline(loop, key, { query, reference, view })
  resultMessage.content = JSON.stringify(providerObservation)
}

function boundedNearbyRadius(value) {
  if (!Number.isFinite(value)) return 20
  return Math.max(1, Math.min(64, Math.floor(value)))
}

function boundedNearbyLimit(value) {
  if (!Number.isFinite(value)) return 50
  return Math.max(1, Math.min(100, Math.floor(value)))
}

function nearbyQueryFor(args = {}) {
  return {
    radius: boundedNearbyRadius(args.radius),
    ...(typeof args.name === 'string' ? { name: args.name.slice(0, 200) } : {}),
    ...(typeof args.type === 'string' ? { type: args.type.slice(0, 200) } : {}),
    limit: boundedNearbyLimit(args.limit),
  }
}

function nearbyQueryKey(args) {
  return JSON.stringify(nearbyQueryFor(args))
}

function nearbyEntityReference(entity) {
  if (Number.isSafeInteger(entity?.unit_number)) return `entity:${entity.unit_number}`
  const position = entity?.position
  return `entity-fallback:${entity?.name ?? 'unknown'}:${entity?.type ?? 'unknown'}:${position?.x ?? '?'}:${position?.y ?? '?'}`
}

function canonicalNearbyEntity(entity) {
  if (!entity || typeof entity !== 'object' || Array.isArray(entity)) return undefined
  return {
    ...entity,
    reference: nearbyEntityReference(entity),
  }
}

function nearbyDecisionView(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return undefined
  const entities = Array.isArray(status.entities)
    ? status.entities.map(canonicalNearbyEntity).filter(Boolean).sort((left, right) => left.reference.localeCompare(right.reference))
    : []
  return {
    ...(typeof status.error === 'string' ? { error: status.error } : {}),
    actor_position: status.actor_position,
    radius: status.radius,
    matched_count: status.matched_count,
    returned_count: status.returned_count,
    truncated: status.truncated === true,
    entities,
  }
}

function nearbyIdentitySummary(entity) {
  return {
    reference: entity.reference,
    name: entity.name,
    type: entity.type,
    position: entity.position,
    ...(Number.isSafeInteger(entity.unit_number) ? { unit_number: entity.unit_number } : {}),
  }
}

function nearbyFullObservation(view, query, unsafeReason) {
  return {
    observation_mode: 'full',
    source: 'live_factorio_nearby_entities',
    query,
    ...(unsafeReason ? { diff_unsafe_reason: unsafeReason } : {}),
    ...view,
  }
}

function nearbyDiffObservation(previous, current, query) {
  if (!previous) return nearbyFullObservation(current, query, current.truncated ? 'truncated_scan' : undefined)
  if (previous.view.truncated || current.truncated) return nearbyFullObservation(current, query, 'truncated_scan')

  const previousByRef = new Map(previous.view.entities.map(entity => [entity.reference, entity]))
  const currentByRef = new Map(current.entities.map(entity => [entity.reference, entity]))
  const added = []
  const removed = []
  const changed = []

  for (const entity of current.entities) {
    const before = previousByRef.get(entity.reference)
    if (!before) {
      added.push(entity)
      continue
    }
    const changes = changedEntity(before, entity)
    delete changes.reference
    if (Object.keys(changes).length > 0) changed.push({ reference: entity.reference, changes })
  }
  for (const entity of previous.view.entities) {
    if (!currentByRef.has(entity.reference)) removed.push(nearbyIdentitySummary(entity))
  }

  const metadataChanges = {}
  for (const key of ['error', 'actor_position', 'radius', 'matched_count', 'returned_count']) {
    if (!sameJson(previous.view[key], current[key])) metadataChanges[key] = current[key] ?? null
  }

  if (added.length === 0 && removed.length === 0 && changed.length === 0 && Object.keys(metadataChanges).length === 0) {
    return {
      observation_mode: 'unchanged',
      source: 'live_factorio_nearby_entities',
      query,
    }
  }

  return {
    observation_mode: 'diff',
    source: 'live_factorio_nearby_entities',
    query,
    ...(Object.keys(metadataChanges).length > 0 ? { metadata_changes: metadataChanges } : {}),
    added,
    removed,
    changed,
  }
}

function ensureNearbyState(loop) {
  loop.nearbyEntitiesBaselines ??= new Map()
  loop.nearbyEntitiesBaselineOrder ??= []
}

function rememberNearbyBaseline(loop, key, entry) {
  ensureNearbyState(loop)
  loop.nearbyEntitiesBaselines.set(key, entry)
  const previousIndex = loop.nearbyEntitiesBaselineOrder.indexOf(key)
  if (previousIndex >= 0) loop.nearbyEntitiesBaselineOrder.splice(previousIndex, 1)
  loop.nearbyEntitiesBaselineOrder.push(key)
  while (loop.nearbyEntitiesBaselineOrder.length > NEARBY_ENTITIES_BASELINE_LIMIT) {
    const oldest = loop.nearbyEntitiesBaselineOrder.shift()
    if (oldest !== undefined) loop.nearbyEntitiesBaselines.delete(oldest)
  }
}

function nearbyBaselineContext(loop) {
  ensureNearbyState(loop)
  const selected = []
  let chars = 0
  for (let index = loop.nearbyEntitiesBaselineOrder.length - 1; index >= 0; index--) {
    const entry = loop.nearbyEntitiesBaselines.get(loop.nearbyEntitiesBaselineOrder[index])
    if (!entry) continue
    const visible = { query: entry.query, ...entry.view }
    const candidateChars = JSON.stringify(visible).length
    if (selected.length > 0 && chars + candidateChars > NEARBY_ENTITIES_CONTEXT_CHARS) break
    selected.push(visible)
    chars += candidateChars
    if (selected.length >= NEARBY_ENTITIES_BASELINE_LIMIT) break
  }
  if (selected.length === 0) return ''
  selected.reverse()
  return `[NEARBY_ENTITIES_BASELINE] Last live nearby-entity snapshots for this request. These snapshots may now be stale; use them only to interpret later getNearbyEntities diff/unchanged responses. Re-observe live mutable state before depending on it.\n${JSON.stringify(selected)}`
}

function transformNearbyEntities(loop, entry, resultMessage) {
  if (entry?.tool?.function?.name !== NEARBY_ENTITIES_TOOL) return
  const raw = String(resultMessage?.content ?? '')
  if (!raw || raw.startsWith('[HARNESS]')) return
  let status
  try { status = JSON.parse(raw) }
  catch { return }
  const view = nearbyDecisionView(status)
  if (!view) return
  const query = nearbyQueryFor(entry.args)
  const key = nearbyQueryKey(entry.args)
  ensureNearbyState(loop)
  const previous = loop.nearbyEntitiesBaselines.get(key)
  const providerObservation = nearbyDiffObservation(previous, view, query)
  rememberNearbyBaseline(loop, key, { query, view })
  resultMessage.content = JSON.stringify(providerObservation)
}

function installObservationDiffs(Base) {
  const prototype = Base.prototype
  if (prototype[INSTALL_MARK]) return
  Object.defineProperty(prototype, INSTALL_MARK, { value: true })

  const originalRequest = prototype.request
  prototype.request = async function (...args) {
    this.entityStatusBaselines = new Map()
    this.entityStatusBaselineOrder = []
    this.nearbyEntitiesBaselines = new Map()
    this.nearbyEntitiesBaselineOrder = []
    return originalRequest.apply(this, args)
  }

  const originalPrepareContinuationContext = prototype.prepareContinuationContext
  prototype.prepareContinuationContext = function (...args) {
    const result = originalPrepareContinuationContext.apply(this, args)
    const entityContext = baselineContext(this)
    if (entityContext) this.messages.push({ role: 'user', content: entityContext })
    const nearbyContext = nearbyBaselineContext(this)
    if (nearbyContext) this.messages.push({ role: 'user', content: nearbyContext })
    return result
  }

  const originalHandleToolBatch = prototype.handleToolBatch
  prototype.handleToolBatch = async function (message, prepared = this.prepareToolBatch(message)) {
    const beforeCount = this.messages.length
    await originalHandleToolBatch.call(this, message, prepared)
    const results = this.messages.slice(beforeCount + 1).filter(item => item.role === 'tool')
    for (let index = 0; index < prepared.length; index++) {
      const result = results.find(item => item.tool_call_id === prepared[index]?.tool?.id)
      if (!result) continue
      transformEntityStatus(this, prepared[index], result)
      transformNearbyEntities(this, prepared[index], result)
    }
    this.compactWorkingContext()
  }
}

installObservationDiffs(BaseNpcAgentLoop)

export * from '../staging/supervisor-adapter.mjs'
