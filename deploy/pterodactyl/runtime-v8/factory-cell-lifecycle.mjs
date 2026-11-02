import { factoryMetadataDigest as digest } from './factory-dependencies.mjs'
import { emptyFurnaceAssignment } from './factory-reassignment.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { completedOperationReceipt, operationSignature, operationIdentity } from './operation-reconciliation.mjs'
import { deriveFactoryPlacementReceipt } from './factory-placement-provenance.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'

// Private host ledger, never a model tool. Its installation projection is the
// current truth; the registry's original assignment/members remain history.
export const FACTORY_LIFECYCLE_LIMITS = Object.freeze({ events: 2048, operations: 64, receipts: 64, beneficiaries: 64 })
const clone = value => structuredClone(value)
const same = (a, b) => a === undefined || b === undefined ? a === b : digest(a) === digest(b)
const fail = code => { throw new FactoryRegistryError(code, code) }
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const OWNER = ['world_id', 'surface_index', 'force_index', 'actor_id', 'actor_epoch', 'session_id', 'goal_id', 'plan_id', 'plan_version', 'semantic_step_id', 'request_id']
const TERMINAL = new Set(['installed', 'retired'])
const locator = value => Object.fromEntries(['unit_number', 'name', 'position', 'surface_index', 'force_index'].map(key => [key, value?.[key]]))
const exactMember = (a, b) => same(locator(a), locator(b))
const safeData = value => {
  let bytes = 0
  const visit = (v, depth = 0) => {
    if (depth > 32 || ++bytes > 500000) fail('factory_lifecycle_capacity')
    if (v === null || ['string', 'boolean'].includes(typeof v) || typeof v === 'number' && Number.isFinite(v)) return
    if (!v || typeof v !== 'object' || !Array.isArray(v) && ![Object.prototype, null].includes(Object.getPrototypeOf(v))) fail('factory_lifecycle_schema')
    for (const key of Reflect.ownKeys(v)) {
      if (Array.isArray(v) && key === 'length') continue
      const d = Object.getOwnPropertyDescriptor(v, key)
      if (typeof key !== 'string' || !d.enumerable || !Object.hasOwn(d, 'value')) fail('factory_lifecycle_schema')
      visit(d.value, depth + 1)
    }
  }
  visit(value)
  if (JSON.stringify(value).length > 4000000) fail('factory_lifecycle_capacity')
}
function owner(context, idle = false) {
  if (!context || OWNER.some(key => ['surface_index', 'force_index', 'actor_id', 'actor_epoch', 'plan_version'].includes(key) ? !integer(context[key]) : !token(context[key]))
    || context.actor_id < 1 || context.plan_version < 1 || context.surface_index < 1 || context.force_index < 1 || !token(context.request_id)
    || context.paused === true || context.cancelled === true || context.goal_status && context.goal_status !== 'active') fail('factory_lifecycle_owner_invalid')
  if (idle && (context.native_idle !== true || context.pending !== false || context.uncertain !== false)) fail('factory_lifecycle_native_not_idle')
  return Object.fromEntries([...OWNER, 'request_id'].map(key => [key, context[key]]))
}
function assertOwner(tx, context, idle = false) {
  const current = owner(context, idle)
  if (OWNER.some(key => tx.owner[key] !== current[key])) fail('factory_lifecycle_owner_stale')
  return current
}
function nativeList(raw, limit = 512) {
  // Factorio's JSON encoder represents an empty Lua sequence as {}. Preserve
  // the raw receipt and accept only this exact empty-table representation.
  if (raw && !Array.isArray(raw) && Object.getPrototypeOf(raw) === Object.prototype && Reflect.ownKeys(raw).length === 0) return []
  if (!Array.isArray(raw) || raw.length > limit) fail('factory_lifecycle_custody_unknown')
  return raw
}
function items(raw) {
  const rows = nativeList(raw)
  const result = new Map()
  for (const row of rows) {
    if (!token(row?.name) || !token(row?.quality) || !integer(row?.count) || row.count < 1) fail('factory_lifecycle_custody_unknown')
    const key = JSON.stringify([row.name, row.quality])
    if (result.has(key)) fail('factory_lifecycle_custody_unknown')
    result.set(key, row.count)
  }
  return result
}
function add(a, b) {
  const result = new Map(a)
  for (const [key, count] of b) {
    const value = (result.get(key) ?? 0) + count
    if (!Number.isSafeInteger(value)) fail('factory_lifecycle_custody_unknown')
    result.set(key, value)
  }
  return result
}
const itemEqual = (a, b) => a.size === b.size && [...a].every(([key, count]) => b.get(key) === count)
function snapshotDomain(snapshot) {
  if (!snapshot || snapshot.fluids_empty !== true || !integer(snapshot.fluidboxes) || snapshot.fluidboxes > 32
    || !token(snapshot.target?.quality)) fail('factory_lifecycle_custody_unknown')
  const indexes = new Set(); let slots = 0
  const actual = nativeList(snapshot.inventories, 32).reduce((sum, inventory) => {
    if (!integer(inventory.index) || inventory.index < 1 || inventory.index > 32 || !integer(inventory.size)
      || indexes.has(inventory.index)) fail('factory_lifecycle_custody_unknown')
    slots += inventory.size
    if (slots > 512) fail('factory_lifecycle_custody_unknown')
    indexes.add(inventory.index)
    return add(sum, items(inventory.items))
  }, new Map())
  const contents = items(snapshot.contents); const products = items(snapshot.products)
  if (!products.size || !itemEqual(actual, contents)) fail('factory_lifecycle_custody_unknown')
  return { contents, products }
}
export function verifyFactoryRemovalReadiness(value) {
  try {
    if (value?.schema_version !== 1 || value.scope !== 'exact_building_only' || value.state !== 'known' || value.recovery_capacity !== 'verified' || !integer(value.tick)) return false
    snapshotDomain(value.snapshot); items(value.actor_inventory)
    return true
  } catch { return false }
}

/** Recompute custody instead of trusting a native success label or disappearance. */
export function verifyFactoryRemovalCustody(receipt) {
  try {
    if (receipt?.schema_version !== 1 || receipt.state !== 'verified' || receipt.code !== 'removal_custody_verified'
      || !integer(receipt.operation_id) || receipt.operation_id < 1
      || receipt.target_gone !== true || receipt.native_call !== 'returned_true' || receipt.before?.fluids_empty !== true
      || !integer(receipt.before?.fluidboxes) || receipt.before.fluidboxes > 32
      || !integer(receipt.before_tick) || !integer(receipt.after_tick) || receipt.after_tick < receipt.before_tick
      || !token(receipt.before?.target?.quality)) return false
    const domain = snapshotDomain(receipt.before)
    const expected = add(domain.contents, domain.products)
    const before = items(receipt.actor_before); const after = items(receipt.actor_after)
    return itemEqual(after, add(before, expected))
      && itemEqual(items(receipt.recovered_items), expected)
  } catch { return false }
}

// A false native return may still move contents. Only exact conservation of
// the remaining target plus actor custody can release that attempt for a
// bounded fresh attempt; disappearance or an unknown inventory never can.
export function verifyFactoryResidualCustody(receipt) {
  try {
    if (receipt?.schema_version !== 1 || !integer(receipt.operation_id) || receipt.operation_id < 1
      || !['partial', 'refused'].includes(receipt.state) || receipt.native_call !== 'returned_false' || receipt.target_gone !== false
      || receipt.before?.fluids_empty !== true || receipt.after?.fluids_empty !== true
      || !integer(receipt.before_tick) || !integer(receipt.after_tick) || receipt.after_tick < receipt.before_tick
      || !exactMember(receipt.before.target, receipt.after.target) || receipt.before.target.quality !== receipt.after.target.quality
      || !same(receipt.before.products, receipt.after.products)) return false
    const before = snapshotDomain(receipt.before); const after = snapshotDomain(receipt.after)
    const recovered = items(receipt.recovered_items)
    return itemEqual(items(receipt.actor_after), add(items(receipt.actor_before), recovered))
      && itemEqual(before.contents, add(after.contents, recovered)) && itemEqual(before.products, after.products)
  } catch { return false }
}

function transaction(state, id) {
  const tx = state.transactions.find(row => row.transaction_id === id)
  if (!tx) fail('factory_lifecycle_transaction_missing')
  return tx
}
function operationBinding(pending) {
  if (pending?.protocol_version !== 2 || !token(pending.operation_key) || !token(pending.attempt_id) || !token(pending.signature)
    || !integer(pending.ordinal) || pending.ordinal < 1 || !integer(pending.actor?.actor_id) || !integer(pending.actor?.epoch)
    || !Array.isArray(pending.operations) || pending.operations.length !== 1) fail('factory_lifecycle_pending_identity_unknown')
  return { operation_key: pending.operation_key, attempt_id: pending.attempt_id, signature: pending.signature, ordinal: pending.ordinal,
    actor_id: pending.actor.actor_id, epoch: pending.actor.epoch }
}
function partialTerminal(witness, binding, operation, receipt) {
  const record = witness?.admission; const batch = witness?.batch; const ref = receipt?.binding
  return Boolean(record && batch && ['partial', 'refused'].includes(receipt?.state)
    && Object.keys(binding).every(key => record[key] === binding[key])
    && witness.generation === ref.batch_generation && record.generation === ref.batch_generation
    && record.operation_count === 1 && ['uncertain', 'failed', 'partial'].includes(record.state)
    && same(record.entity_removal, receipt) && record.slots?.length === 1 && record.slots[0].index === 1
    && record.slots[0].ok === true && record.slots[0].operation === operation.name && record.slots[0].queued_tasks === 1
    && record.slots[0].batch_refs?.length === 1
    && ['batch_id', 'batch_generation', 'batch_ref'].every(key => record.slots[0].batch_refs[0][key] === ref[key] && batch[key] === ref[key])
    && batch.state === 'cancelled' && ['mining:entity_removal_refused', 'mining:entity_removal_uncertain'].includes(batch.reason)
    && batch.tick === receipt.after_tick && batch.task_count === 1 && batch.started_count === 1
    && batch.task_types?.length === 1 && batch.task_types[0] === 'mining')
}
function reduce(state, event) {
  const p = event.payload
  if (event.type === 'reassign') {
    if (state.transactions.some(tx => tx.transaction_id === p.transaction_id || !TERMINAL.has(tx.state))) fail('factory_lifecycle_duplicate_transaction')
    state.transactions.push({ ...clone(p), original_owner: clone(p.owner), owner_history: [], state: 'installed', claims: [], operations: [], next_operation: 0, current_members: clone(p.members), physical_revision: p.previous_physical_revision + 1 })
  } else if (event.type === 'begin') {
    if (state.transactions.some(tx => tx.transaction_id === p.transaction_id || tx.cell_id === p.cell_id && !TERMINAL.has(tx.state))) fail('factory_lifecycle_duplicate_transaction')
    state.transactions.push({ ...clone(p), original_owner: clone(p.owner), owner_history: [], state: 'degraded', claims: [], next_operation: 0, current_members: clone(p.members), physical_revision: p.previous_physical_revision + 1 })
  } else if (event.type === 'rebind') {
    const tx = transaction(state, p.transaction_id)
    if (!same(tx.owner, p.previous_owner) || p.authority_fingerprint !== tx.authority_fingerprint || !['degraded', 'installed'].includes(tx.state)
      || tx.claims.some(claim => !['verified', 'residual_reconciled', 'not_sent'].includes(claim.state))) fail('factory_lifecycle_rebind_uncertain')
    tx.owner_history.push({ previous_owner: clone(tx.owner), owner: clone(p.owner), evidence: clone(p.evidence) }); tx.owner = clone(p.owner)
  } else if (event.type === 'claim') {
    const tx = transaction(state, p.transaction_id)
    if (tx.state !== 'degraded' || tx.next_operation >= tx.operations.length || tx.claims.length >= tx.action_limit
      || tx.claims.some(row => row.binding.operation_key === p.binding.operation_key)
      || state.transactions.some(other => other.claims.some(row => row.binding.operation_key === p.binding.operation_key))) fail('factory_lifecycle_claim_forbidden')
    tx.claims.push({ binding: clone(p.binding), operation_index: tx.next_operation, operation: clone(tx.operations[tx.next_operation]), state: 'pending' })
    tx.state = 'awaiting_receipt'
  } else if (event.type === 'receipt') {
    const tx = transaction(state, p.transaction_id); const claim = tx.claims.at(-1)
    if (!claim || !['awaiting_receipt', 'uncertain', 'partial', 'refused'].includes(tx.state)
      || claim.binding.operation_key !== p.operation_key) fail('factory_lifecycle_receipt_without_claim')
    if (claim.receipt && !same(claim.receipt, p.receipt)) fail('factory_lifecycle_receipt_conflict')
    if (['partial', 'refused'].includes(p.state) && !partialTerminal(p.terminal, claim.binding, claim.operation.operation, p.receipt)) fail('factory_lifecycle_terminal_uncorrelated')
    claim.receipt = clone(p.receipt); claim.state = p.state; tx.state = p.state === 'verified' ? 'degraded' : p.state
    if (p.terminal) claim.terminal = clone(p.terminal)
    if (p.state === 'verified') {
      tx.next_operation++
      if (claim.operation.kind === 'remove') tx.current_members = tx.current_members.filter(member => !exactMember(member, claim.operation.member))
      else if (claim.operation.kind === 'add') {
        if (tx.current_members.some(member => member.unit_number === p.member.unit_number)) fail('factory_lifecycle_member_duplicate')
        tx.current_members.push(clone(p.member))
      }
    }
  } else if (event.type === 'residual_reconciled') {
    const tx = transaction(state, p.transaction_id); const claim = tx.claims.at(-1)
    if (!claim || !['partial', 'refused'].includes(tx.state) || !verifyFactoryResidualCustody(claim.receipt)
      || !partialTerminal(claim.terminal, claim.binding, claim.operation.operation, claim.receipt)
      || tx.claims.length >= tx.action_limit || claim.binding.operation_key !== p.operation_key) fail('factory_lifecycle_recovery_exhausted')
    claim.state = 'residual_reconciled'; claim.reconciliation = clone(p.evidence); tx.state = 'degraded'
  } else if (event.type === 'not_sent') {
    const tx = transaction(state, p.transaction_id); const claim = tx.claims.at(-1)
    if (!claim || tx.state !== 'awaiting_receipt' || claim.binding.operation_key !== p.operation_key || claim.receipt) fail('factory_lifecycle_no_send_conflict')
    claim.state = 'not_sent'; claim.no_send = clone(p.witness); tx.state = 'degraded'
  } else if (event.type === 'finish') {
    const tx = transaction(state, p.transaction_id)
    if (tx.state !== 'degraded' || tx.next_operation !== tx.operations.length || tx.claims.some(row => !['verified', 'residual_reconciled', 'not_sent'].includes(row.state))) fail('factory_lifecycle_incomplete')
    if (['retire', 'cleanup'].includes(tx.kind) && tx.current_members.length || !['retire', 'cleanup'].includes(tx.kind) && !tx.current_members.length) fail('factory_lifecycle_members_incomplete')
    tx.state = ['retire', 'cleanup'].includes(tx.kind) ? 'retired' : 'installed'
    tx.final_evidence = clone(p.evidence)
  } else if (event.type === 'temporary_intent') {
    if (state.temporary_intents.some(row => row.intent_id === p.intent_id)) fail('factory_temporary_duplicate')
    state.temporary_intents.push(clone(p))
  } else if (event.type === 'temporary_binding') {
    const intent = state.temporary_intents.find(row => row.intent_id === p.intent_id)
    if (!intent || intent.binding || state.temporary_intents.some(row => row.binding?.operation_key === p.binding.operation_key)) fail('factory_temporary_binding_conflict')
    intent.binding = clone(p.binding)
  } else if (event.type === 'temporary') {
    if (state.temporary.some(row => row.receipt_id === p.receipt_id || row.unit_number === p.unit_number)) fail('factory_temporary_duplicate')
    state.temporary.push(clone(p))
  } else if (event.type === 'beneficiary_completed') {
    if (!state.completions.some(row => same(row, p))) state.completions.push(clone(p))
  } else fail('factory_lifecycle_event_unknown')
  return state
}

function consumerIds(registry, cellId) {
  const result = new Set([cellId]); let changed = true
  while (changed) {
    changed = false
    for (const edge of registry.dependencies) if (edge.supplier?.kind === 'cell' && result.has(edge.supplier.cell_id) && !result.has(edge.consumer.cell_id)) {
      result.add(edge.consumer.cell_id); changed = true
    }
  }
  return [...result].sort()
}
function evidenceFence(evidence, context, registry, members) {
  if (!evidence || evidence.world_id !== context.world_id || evidence.registry_revision !== registry.revision
    || evidence.request_id !== context.request_id || evidence.actor_id !== context.actor_id || evidence.actor_epoch !== context.actor_epoch
    || evidence.session_id !== context.session_id || evidence.fresh !== true || evidence.truncated !== false
    || evidence.native_idle !== true || evidence.pending !== false || evidence.uncertain !== false
    || !integer(evidence.tick) || !Array.isArray(evidence.members) || evidence.members.length !== members.length
    || members.some(member => !evidence.members.some(row => exactMember(row, member)))) fail('factory_lifecycle_evidence_unknown')
}
function consumerFence(evidence, registry, cellId, destructive) {
  const ids = consumerIds(registry, cellId).filter(id => id !== cellId)
  if (evidence.consumers?.coverage !== 'complete' || evidence.consumers.truncated !== false
    || !Array.isArray(evidence.consumers.rows) || evidence.consumers.unresolved !== false
    || ids.some(id => !evidence.consumers.rows.some(row => row.cell_id === id))
    || evidence.consumers.rows.some(row => !['preserved', 'migrated', 'ceased'].includes(row.state)
      || destructive && row.state === 'preserved' || row.verified !== true || !token(row.evidence_ref))) fail('factory_lifecycle_consumer_unresolved')
  // A cycle is not evidence of redundancy, even when each metadata edge exists.
  if (destructive && registry.dependencies.some(edge => edge.supplier?.kind === 'cell' && ids.includes(edge.supplier.cell_id)
    && edge.consumer.cell_id === cellId)) fail('factory_lifecycle_consumer_cycle')
}

export class FactoryCellLifecycleStore {
  #worldId
  #events = []
  #state = { transactions: [], temporary_intents: [], temporary: [], completions: [] }
  #fault
  #durable
  #readPlacementReceipt
  #readPlacementReceipts
  constructor({ readPlacementReceipt, readPlacementReceipts } = {}) {
    this.#readPlacementReceipt = readPlacementReceipt
    this.#readPlacementReceipts = readPlacementReceipts
  }
  temporaryAssets() {
    this.#assert()
    return this.#state.temporary.map(row => ({ ...clone(row), beneficiaries_complete: row.beneficiaries.every(beneficiary =>
      this.#state.completions.some(completion => same(completion.beneficiary, beneficiary) && completion.goal_id === row.goal_id)) }))
  }
  #assert() { if (this.#fault) fail('factory_lifecycle_fault') }
  #body() { return { schema_version: 1, world_id: this.#worldId, events: clone(this.#events) } }
  #append(type, payload) {
    this.#assert(); safeData(payload)
    if (this.#events.length >= FACTORY_LIFECYCLE_LIMITS.events) fail('factory_lifecycle_capacity')
    const next = reduce(clone(this.#state), { type, payload })
    const body = { sequence: this.#events.length + 1, previous_digest: this.#events.at(-1)?.digest ?? null, type, payload: clone(payload) }
    this.#events.push({ ...body, digest: digest(body) }); this.#state = next
    return clone(next)
  }
  snapshot() { return { ...(this.#worldId ? { factory_lifecycle: this.#body() } : {}), ...(this.#fault ? { factory_lifecycle_fault: this.#fault } : {}) } }
  markPersisted(snapshot) {
    this.#assert()
    if (!same(snapshot?.factory_lifecycle, this.snapshot().factory_lifecycle)) return false
    this.#durable = digest(this.#body()); return true
  }
  assertDurable() { this.#assert(); if (this.#events.length && this.#durable !== digest(this.#body())) fail('factory_lifecycle_persistence_required') }
  revision() { this.#assert(); return this.#events.length }
  pending() { return Boolean(this.#fault || this.#state.transactions.some(tx => !TERMINAL.has(tx.state))) }
  current(id) { this.#assert(); return clone(transaction(this.#state, id)) }
  transactions() { this.#assert(); return clone(this.#state.transactions) }
  pendingTemporaryIntents() { this.#assert(); return clone(this.#state.temporary_intents.filter(row => !this.#state.temporary.some(asset => asset.intent_id === row.intent_id))) }
  restore(snapshot, worldId) {
    if (this.#fault) return
    try {
      const raw = snapshot?.factory_lifecycle
      if (snapshot?.factory_lifecycle_fault) fail('factory_lifecycle_persisted_fault')
      if (!raw) { if (this.#events.length) fail('factory_lifecycle_history_rewritten'); return }
      safeData(raw)
      if (raw.schema_version !== 1 || raw.world_id !== worldId || !Array.isArray(raw.events) || raw.events.length > FACTORY_LIFECYCLE_LIMITS.events) fail('factory_lifecycle_schema')
      const next = { transactions: [], temporary_intents: [], temporary: [], completions: [] }; const events = []
      for (const event of raw.events) {
        const { digest: hash, ...body } = event
        if (event.sequence !== events.length + 1 || event.previous_digest !== (events.at(-1)?.digest ?? null) || hash !== digest(body)) fail('factory_lifecycle_history_rewritten')
        reduce(next, event); events.push(clone(event))
      }
      if (!same(this.#events, events.slice(0, this.#events.length))) fail('factory_lifecycle_history_rewritten')
      this.#worldId = worldId; this.#events = events; this.#state = next; this.#durable = digest(this.#body())
    } catch (error) { this.#fault = error.code ?? 'factory_lifecycle_restore_failed' }
  }
  project(cell) {
    this.#assert()
    const history = this.#state.transactions.filter(row => row.cell_id === cell.cell_id)
    const tx = history.at(-1)
    if (!tx) return clone(cell)
    let assignment = cell.assignment; let ports = cell.ports
    for (const transition of history) {
      if (!same(transition.assignment, assignment)) fail('factory_lifecycle_assignment_changed')
      if (transition.kind === 'reassign') { assignment = transition.next_assignment; ports = transition.next_ports }
    }
    const bindings = cell.port_bindings?.filter(binding => tx.current_members.some(member => exactMember(member, binding.member)))
    const durable = this.#durable === digest(this.#body())
    return { ...clone(cell), assignment: clone(assignment), ports: clone(ports), members: clone(tx.current_members), ...(bindings ? { port_bindings: clone(bindings) } : {}),
      state: !durable ? 'degraded' : tx.state === 'installed' ? 'unverified' : tx.state === 'retired' ? 'retired' : 'degraded',
      physical_revision: tx.physical_revision, lifecycle_state: tx.state,
      lifecycle: { transaction_id: tx.transaction_id, kind: tx.kind, state: tx.state, revision: tx.physical_revision, commissioning: 'unverified' } }
  }
  #cas(change, registry) {
    if (change.expected_registry_revision !== registry.revision || change.expected_lifecycle_revision !== this.revision()) fail('factory_lifecycle_revision_stale')
    const ids = consumerIds(registry, change.cell_id)
    if (!Array.isArray(change.expected_cells) || change.expected_cells.length !== ids.length
      || new Set(change.expected_cells.map(row => row.cell_id)).size !== ids.length) fail('factory_lifecycle_affected_cells_missing')
    for (const id of ids) {
      const cell = registry.cells.find(row => row.cell_id === id); const expected = change.expected_cells.find(row => row.cell_id === id)
      if (!cell || !expected || cell.revision !== expected.revision || digest(cell) !== expected.digest) fail('factory_lifecycle_cell_revision_stale')
    }
  }
  #continuationCas(tx, registry) {
    if (registry.revision !== tx.base_registry_revision) fail('factory_lifecycle_revision_stale')
    for (const expected of tx.affected_cells) {
      const cell = registry.cells.find(row => row.cell_id === expected.cell_id)
      if (!cell || cell.revision !== expected.revision || cell.cell_id !== tx.cell_id && digest(cell) !== expected.digest) fail('factory_lifecycle_cell_revision_stale')
      if (cell.cell_id === tx.cell_id && !same(cell.assignment, tx.assignment)) fail('factory_lifecycle_assignment_changed')
    }
  }
  reassign(change, registry, context, evidence) {
    this.#assert(); this.assertDurable(); const scope = owner(context, true); safeData(change)
    if (this.pending()) fail('factory_reassignment_pending')
    this.#cas(change, registry)
    const cell = registry.cells.find(row => row.cell_id === change.cell_id)
    if (!cell || registry.world_id !== scope.world_id || cell.surface_index !== scope.surface_index || cell.force_index !== scope.force_index
      || !token(change.transaction_id) || this.#state.transactions.some(tx => tx.transaction_id === change.transaction_id)
      || registry.dependencies.some(edge => edge.consumer.cell_id === cell.cell_id || edge.supplier?.cell_id === cell.cell_id)) fail('factory_reassignment_consumers_or_scope')
    evidenceFence(evidence, context, registry, cell.members); consumerFence(evidence, registry, cell.cell_id, true)
    if (evidence.consumers.rows.length || evidence.authorized !== true || !token(evidence.evidence_ref)) fail('factory_reassignment_authority_missing')
    const next = emptyFurnaceAssignment(cell, change.declaration, evidence.raw.observation)
    if (!same(next, evidence.next)) fail('factory_reassignment_evidence_mismatch')
    this.#worldId ??= scope.world_id
    this.#append('reassign', { transaction_id: change.transaction_id, cell_id: cell.cell_id, kind: 'reassign', owner: scope,
      authority_fingerprint: context.authority_fingerprint, assignment: clone(cell.assignment), next_assignment: next.assignment, next_ports: next.ports,
      members: clone(cell.members), previous_physical_revision: cell.physical_revision ?? 0, evidence: clone(evidence) })
    return this.current(change.transaction_id)
  }
  begin(change, registry, context, evidence) {
    this.#assert(); this.assertDurable(); const scope = owner(context, true); safeData(change)
    const prior = this.#state.transactions.find(tx => tx.transaction_id === change?.transaction_id)
    if (prior) {
      if (!same(prior.change, change) || OWNER.some(key => prior.owner[key] !== scope[key])) fail('factory_lifecycle_transaction_conflict')
      return clone(prior)
    }
    this.#cas(change, registry)
    const cell = registry.cells.find(row => row.cell_id === change.cell_id)
    if (!cell || registry.world_id !== scope.world_id || this.#worldId && this.#worldId !== scope.world_id
      || cell.surface_index !== scope.surface_index || cell.force_index !== scope.force_index
      || cell.state === 'retired' || !['expand', 'modify', 'retire', 'cleanup'].includes(change.kind)
      || !token(change.transaction_id) || !Array.isArray(change.operations) || !change.operations.length
      || change.operations.length > FACTORY_LIFECYCLE_LIMITS.operations || !integer(change.action_limit)
      || change.action_limit < change.operations.length || change.action_limit > Math.min(FACTORY_LIFECYCLE_LIMITS.operations, change.operations.length + 2)
      || !same(change.assignment, cell.assignment)) fail('factory_lifecycle_change_invalid')
    evidenceFence(evidence, context, registry, cell.members)
    const destructive = ['retire', 'cleanup'].includes(change.kind)
    consumerFence(evidence, registry, cell.cell_id, destructive)
    if (evidence.job_preserved !== true || !token(evidence.evidence_ref)) fail('factory_lifecycle_job_unproven')
    const removed = new Set()
    for (const op of change.operations) {
      if (!['remove', 'add'].includes(op.kind) || !op.operation || Object.keys(op.operation).some(key => !['name', 'args', 'placed_entity'].includes(key))) fail('factory_lifecycle_operation_invalid')
      if (op.kind === 'remove') {
        if (change.kind === 'expand' || op.operation.name !== 'mine_entity_exact' || op.operation.args?.unit_number !== op.member?.unit_number
          || !cell.members.some(row => exactMember(row, op.member)) || removed.has(op.member.unit_number)
          || !token(op.quality) || !evidence.members.some(row => exactMember(row, op.member) && row.quality === op.quality
            && row.contents_known === true && row.recovery_capacity === 'verified')) fail('factory_lifecycle_removal_unproven')
        removed.add(op.member.unit_number)
      } else if (destructive || !['place_entity', 'place_candidate'].includes(op.operation.name) || !token(op.name)
        || !Number.isFinite(op.position?.x) || !Number.isFinite(op.position?.y)) fail('factory_lifecycle_placement_invalid')
    }
    if (destructive && removed.size !== cell.members.length) fail('factory_lifecycle_retirement_incomplete')
    if (change.kind === 'cleanup') {
      if (evidence.redundancy !== 'verified') fail('factory_cleanup_redundancy_unknown')
      for (const member of cell.members) {
        const temp = this.#state.temporary.find(row => row.unit_number === member.unit_number)
        if (!temp || temp.world_id !== scope.world_id || temp.goal_id !== scope.goal_id
          || temp.beneficiaries.some(b => !this.#state.completions.some(c => same(c.beneficiary, b) && c.goal_id === temp.goal_id))) fail('factory_cleanup_beneficiary_incomplete')
      }
    }
    this.#worldId ??= scope.world_id
    this.#append('begin', { transaction_id: change.transaction_id, cell_id: cell.cell_id, kind: change.kind, owner: scope,
      authority_fingerprint: context.authority_fingerprint ?? null,
      change: clone(change), assignment: clone(cell.assignment), members: clone(cell.members), operations: clone(change.operations), action_limit: change.action_limit,
      previous_physical_revision: cell.physical_revision ?? 0, base_registry_revision: registry.revision,
      affected_cells: clone(change.expected_cells), evidence: clone(evidence) })
    return this.current(change.transaction_id)
  }
  rebind(id, registry, context, evidence) {
    this.assertDurable(); const tx = transaction(this.#state, id); const current = owner(context, true); this.#continuationCas(tx, registry)
    if (!/^[a-f0-9]{64}$/.test(tx.authority_fingerprint ?? '') || context.authority_fingerprint !== tx.authority_fingerprint) fail('factory_lifecycle_rebind_authority_changed')
    const fixed = ['world_id', 'surface_index', 'force_index', 'actor_id', 'goal_id', 'plan_id', 'plan_version', 'semantic_step_id']
    if (fixed.some(key => current[key] !== tx.original_owner[key]) || current.actor_epoch < tx.owner.actor_epoch) fail('factory_lifecycle_rebind_owner_changed')
    if (!['degraded', 'installed'].includes(tx.state) || tx.claims.some(claim => !['verified', 'residual_reconciled', 'not_sent'].includes(claim.state))) fail('factory_lifecycle_rebind_uncertain')
    evidenceFence(evidence, context, registry, tx.current_members); consumerFence(evidence, registry, tx.cell_id, ['retire', 'cleanup'].includes(tx.kind))
    const native = evidence.native_status; const deployment = evidence.native_owner
    const journal = nativeAdmissionJournal(native?.admission_journal)
    if (!journal.known || journal.unresolved || native?.task_state !== 'idle' || native.queue_empty !== true || native.queue_length !== 0 || native.active_batch
      || !deployment || deployment.allowed !== true || deployment.idle !== true || deployment.actor_kind !== 'standalone_character'
      || deployment.actor_id !== current.actor_id || deployment.epoch !== current.actor_epoch || deployment.session !== current.session_id
      || deployment.surface_index !== current.surface_index || deployment.force_index !== current.force_index || evidence.job_preserved !== true) fail('factory_lifecycle_rebind_native_unknown')
    for (const claim of tx.claims.filter(row => row.state === 'verified' && row.operation.kind === 'remove')) {
      if (!verifyFactoryRemovalCustody(claim.receipt) || !Array.isArray(evidence.removed_members)
        || !evidence.removed_members.some(row => exactMember(row, claim.operation.member) && row.state === 'absent' && row.coverage === 'complete')) fail('factory_lifecycle_rebind_custody_unknown')
    }
    const last = tx.claims.at(-1)
    if (last?.state === 'verified' && last.operation.kind === 'remove' && !itemEqual(items(evidence.actor_inventory), items(last.receipt.actor_after))) fail('factory_lifecycle_rebind_custody_unknown')
    if (same(tx.owner, current)) return clone(tx)
    this.#append('rebind', { transaction_id: id, previous_owner: tx.owner, owner: current, authority_fingerprint: tx.authority_fingerprint, evidence })
    return this.current(id)
  }
  claim(id, pending, registry, context) {
    this.assertDurable(); const tx = transaction(this.#state, id); assertOwner(tx, context, true)
    this.#continuationCas(tx, registry)
    if (tx.state !== 'degraded' || tx.next_operation >= tx.operations.length || tx.claims.length >= tx.action_limit) fail('factory_lifecycle_claim_forbidden')
    const binding = operationBinding(pending)
    if (binding.actor_id !== tx.owner.actor_id || binding.epoch !== tx.owner.actor_epoch || pending.goal_id !== tx.owner.goal_id
      || pending.plan_id !== tx.owner.plan_id || pending.request_id !== tx.owner.request_id
      || binding.signature !== operationSignature([tx.operations[tx.next_operation]?.operation])
      || pending.operations[0].identity !== operationIdentity(tx.operations[tx.next_operation]?.operation)) fail('factory_lifecycle_operation_mismatch')
    this.#append('claim', { transaction_id: id, binding }); return this.current(id)
  }
  admission(operations, pending, context) {
    try {
      this.assertDurable()
      if (!this.pending()) return { ok: true, authorized: false }
      const tx = this.#state.transactions.find(row => row.state === 'awaiting_receipt' && row.claims.at(-1)?.binding.operation_key === pending?.operation_key)
      if (!tx) return { ok: false, authorized: false, code: 'factory_lifecycle_reconciliation_required' }
      assertOwner(tx, context)
      const claim = tx.claims.at(-1)
      if (!same(claim.binding, operationBinding(pending)) || operationSignature(operations) !== operationSignature([claim.operation.operation])) fail('factory_lifecycle_operation_mismatch')
      return { ok: true, authorized: true, transaction_id: tx.transaction_id }
    } catch (error) { return { ok: false, authorized: false, code: error.code ?? 'factory_lifecycle_unknown' } }
  }
  notSent(pending, context, witness) {
    this.#assert()
    const tx = this.#state.transactions.find(row => row.claims.some(claim => claim.binding.operation_key === pending?.operation_key))
    if (!tx) return { matched: false, changed: false }
    // This only records a host's exact pre-transport boundary. It cannot execute,
    // refund a claim or lend a cancelled owner's authority to the next request.
    assertOwner(tx, { ...context, paused: false, cancelled: false, goal_status: 'active' })
    const claim = tx.claims.find(row => row.binding.operation_key === pending.operation_key)
    if (!same(claim.binding, operationBinding(pending)) || witness?.not_sent !== true || !token(witness.reason)
      || witness.operation_key !== pending.operation_key || witness.attempt_id !== pending.attempt_id) fail('factory_lifecycle_no_send_unproven')
    if (claim.state === 'not_sent') {
      if (!same(claim.no_send, witness)) fail('factory_lifecycle_no_send_conflict')
      return { matched: true, changed: false }
    }
    this.#append('not_sent', { transaction_id: tx.transaction_id, operation_key: pending.operation_key, witness })
    return { matched: true, changed: true }
  }
  settle(status, pending, context, placementReceipt) {
    this.#assert()
    const tx = this.#state.transactions.find(row => row.claims.some(claim => claim.binding.operation_key === pending?.operation_key))
    if (!tx) return { matched: false, changed: false, hold: false }
    assertOwner(tx, context)
    const claim = tx.claims.find(row => row.binding.operation_key === pending.operation_key)
    if (!same(claim.binding, operationBinding(pending))) fail('factory_lifecycle_receipt_owner_mismatch')
    if (['verified', 'residual_reconciled'].includes(claim.state)) {
      const records = status?.admission_journal?.records ?? status?.admission_journal
      const duplicate = Array.isArray(records) && records.find(row => row.operation_key === pending.operation_key)?.entity_removal
      if (duplicate && !same(duplicate, claim.receipt)) fail('factory_lifecycle_receipt_conflict')
      const dirty = this.#durable !== digest(this.#body())
      return { matched: true, changed: false, hold: dirty, ...(dirty ? { needs_persistence: true } : {}), state: tx.state }
    }
    if (status?.task_state !== 'idle' || status.queue_empty !== true || status.queue_length !== 0 || status.active_batch) return { matched: true, changed: false, hold: true, state: tx.state }
    let receipt; let member; let terminal; let state = 'uncertain'
    if (claim.operation.kind === 'remove') {
      const records = status.admission_journal?.records ?? status.admission_journal
      const record = Array.isArray(records) && records.find(row => row.operation_key === pending.operation_key)
      const fromBasic = status.basic_operation?.last_result?.entity_removal
      receipt = record?.entity_removal ?? (fromBasic?.binding?.operation_key === pending.operation_key ? fromBasic : undefined)
      if (!receipt) return { matched: true, changed: false, hold: true, state: tx.state }
      if (record?.entity_removal && fromBasic?.binding?.operation_key === pending.operation_key && !same(fromBasic, receipt)) fail('factory_lifecycle_receipt_conflict')
      if (receipt.world_id !== tx.owner.world_id || !same(Object.fromEntries(Object.keys(claim.binding).map(k => [k, receipt.binding?.[k]])), claim.binding)
        || receipt.binding?.session !== tx.owner.session_id || receipt.before && (!exactMember(receipt.before.target, claim.operation.member)
          || receipt.before.target.quality !== claim.operation.quality) || !integer(receipt.binding.batch_id) || receipt.binding.batch_id < 1
        || !integer(receipt.binding.batch_generation) || receipt.binding.batch_generation < 1
        || receipt.binding.batch_ref !== `batch-g${receipt.binding.batch_generation}-${receipt.binding.batch_id}`) fail('factory_lifecycle_receipt_owner_mismatch')
      const completed = completedOperationReceipt(pending, { status, actor: { actor_id: context.actor_id, epoch: context.actor_epoch } })
      const correlated = completed && ['batch_id', 'batch_generation', 'batch_ref'].every(key => completed[key] === receipt.binding[key])
        && completed.task_count === 1 && (completed.refused_count ?? 0) === 0 && !completed.outcome && completed.tick === receipt.after_tick
        && completed.task_types?.length === 1 && completed.task_types[0] === 'mining'
        && record?.slots?.length === 1 && record.slots[0].operation === claim.operation.operation.name && record.slots[0].queued_tasks === 1
      const batch = nativeList(status.receipt_journal ?? []).find(row => ['batch_id', 'batch_generation', 'batch_ref'].every(key => row[key] === receipt.binding[key]))
      const witness = record && batch ? { admission: record, batch, generation: status.batch_generation } : undefined
      if (correlated && verifyFactoryRemovalCustody(receipt)) state = 'verified'
      else if (partialTerminal(witness, claim.binding, claim.operation.operation, receipt)) { state = receipt.state; terminal = witness }
    } else {
      receipt = placementReceipt
      if (!receipt) return { matched: true, changed: false, hold: true, state: tx.state }
      const derived = deriveFactoryPlacementReceipt(status, { world_id: tx.owner.world_id,
        actor: { actor_id: tx.owner.actor_id, epoch: tx.owner.actor_epoch },
        candidates: [{ pending, plan_version: tx.owner.plan_version, semantic_step_id: tx.owner.semantic_step_id }] })
      if (!derived || !same(derived, receipt)) fail('factory_lifecycle_placement_unproven')
      if (receipt.operation_key !== pending.operation_key || receipt.world_id !== tx.owner.world_id || receipt.goal_id !== tx.owner.goal_id
        || receipt.actor_id !== tx.owner.actor_id || receipt.actor_epoch !== tx.owner.actor_epoch || receipt.plan_id !== tx.owner.plan_id
        || receipt.semantic_step_id !== tx.owner.semantic_step_id || receipt.name !== claim.operation.name
        || !same(receipt.position, claim.operation.position)) fail('factory_lifecycle_placement_mismatch')
      member = { ...locator(receipt), provenance: { source: 'npc_placement_receipt', receipt_id: receipt.receipt_id,
        goal_id: receipt.goal_id, plan_id: receipt.plan_id, plan_version: receipt.plan_version, semantic_step_id: receipt.semantic_step_id,
        request_id: receipt.request_id, actor_id: receipt.actor_id, actor_epoch: receipt.actor_epoch, tick: receipt.tick } }
      state = 'verified'
    }
    if (claim.receipt && same(claim.receipt, receipt) && claim.state === state && same(claim.terminal, terminal)) {
      const dirty = this.#durable !== digest(this.#body())
      return { matched: true, changed: false, hold: state !== 'verified' || dirty, ...(dirty ? { needs_persistence: true } : {}), state }
    }
    this.#append('receipt', { transaction_id: tx.transaction_id, operation_key: pending.operation_key, state, receipt: clone(receipt), ...(member ? { member } : {}), ...(terminal ? { terminal } : {}) })
    return { matched: true, changed: true, hold: state !== 'verified', state }
  }
  reconcileResidual(id, registry, context, evidence) {
    this.assertDurable(); const tx = transaction(this.#state, id); assertOwner(tx, context, true); this.#continuationCas(tx, registry)
    const claim = tx.claims.at(-1)
    if (!claim || !['partial', 'refused'].includes(claim.state) || !verifyFactoryResidualCustody(claim.receipt)
      || !partialTerminal(claim.terminal, claim.binding, claim.operation.operation, claim.receipt)) fail('factory_lifecycle_residual_unknown')
    if (tx.claims.length >= tx.action_limit) fail('factory_lifecycle_recovery_exhausted')
    evidenceFence(evidence, context, registry, tx.current_members)
    consumerFence(evidence, registry, tx.cell_id, ['retire', 'cleanup'].includes(tx.kind))
    const target = evidence.members.find(row => exactMember(row, claim.operation.member))
    if (!target || target.recovery_capacity !== 'verified' || !same(target.removal_snapshot, claim.receipt.after)
      || !itemEqual(items(evidence.actor_inventory), items(claim.receipt.actor_after)) || evidence.job_preserved !== true
      || evidence.tick < claim.receipt.after_tick) fail('factory_lifecycle_residual_changed')
    this.#append('residual_reconciled', { transaction_id: id, operation_key: claim.binding.operation_key, evidence })
    return this.current(id)
  }
  finish(id, registry, context, evidence) {
    this.assertDurable(); const tx = transaction(this.#state, id); assertOwner(tx, context, true)
    if (TERMINAL.has(tx.state)) return clone(tx)
    this.#continuationCas(tx, registry)
    evidenceFence(evidence, context, registry, tx.current_members)
    consumerFence(evidence, registry, tx.cell_id, ['retire', 'cleanup'].includes(tx.kind))
    if (evidence.job_preserved !== true || evidence.installation !== 'verified' || !token(evidence.evidence_ref)
      || !same(evidence.assignment, tx.assignment)) fail('factory_lifecycle_installation_unverified')
    this.#append('finish', { transaction_id: id, evidence }); return this.current(id)
  }
  declareTemporary(intent, context) {
    this.#assert(); const scope = owner(context, true); safeData(intent)
    if (this.#worldId && this.#worldId !== scope.world_id) fail('factory_lifecycle_world_mismatch')
    if (!intent || intent.classification !== 'temporary' || !token(intent.purpose) || intent.retirement_condition !== 'beneficiaries_complete_and_redundant'
      || !token(intent.intent_id) || !token(intent.placement_intent_digest)
      || !token(intent.placement?.name) || !Number.isFinite(intent.placement?.position?.x) || !Number.isFinite(intent.placement?.position?.y)
      || intent.placement.surface_index !== scope.surface_index || intent.placement.force_index !== scope.force_index
      || !['place_entity', 'place_candidate'].includes(intent.placement.operation?.name)
      || intent.placement_intent_digest !== operationIdentity(intent.placement.operation)
      || !Array.isArray(intent.beneficiaries) || !intent.beneficiaries.length || intent.beneficiaries.length > FACTORY_LIFECYCLE_LIMITS.beneficiaries
      || intent.beneficiaries.some(b => !token(b.goal_id) || !token(b.semantic_step_id))
      || new Set(intent.beneficiaries.map(digest)).size !== intent.beneficiaries.length) fail('factory_temporary_authority_unknown')
    if (typeof this.#readPlacementReceipts !== 'function') fail('factory_temporary_provenance_unavailable')
    const existing = this.#readPlacementReceipts(scope)
    if (!Array.isArray(existing)) fail('factory_temporary_provenance_unavailable')
    const value = { ...clone(intent), owner: scope, excluded_receipt_ids: existing.map(row => row.receipt_id) }
    const previous = this.#state.temporary_intents.find(row => row.intent_id === intent.intent_id)
    if (previous) {
      const { binding, excluded_receipt_ids, ...original } = previous
      if (!same(original, { ...clone(intent), owner: scope })) fail('factory_temporary_conflict')
      return clone(previous)
    }
    this.#worldId ??= context.world_id; this.#append('temporary_intent', value); return clone(value)
  }
  bindTemporaryPlacement(intentId, pending, context) {
    this.#assert(); this.assertDurable(); const scope = owner(context, true)
    const declared = this.#state.temporary_intents.find(row => row.intent_id === intentId)
    if (!declared || !same(declared.owner, scope)) fail('factory_temporary_authority_unknown')
    const binding = operationBinding(pending)
    if (pending.goal_id !== scope.goal_id || pending.plan_id !== scope.plan_id || pending.request_id !== scope.request_id || pending.step_id !== context.step_id
      || binding.actor_id !== scope.actor_id || binding.epoch !== scope.actor_epoch
      || pending.signature !== operationSignature([declared.placement.operation])
      || pending.operations[0].identity !== declared.placement_intent_digest
      || pending.operations[0].placed_entity !== declared.placement.name) fail('factory_temporary_operation_mismatch')
    if (typeof this.#readPlacementReceipts !== 'function' || this.#readPlacementReceipts(scope).some(row => row.operation_key === pending.operation_key)) fail('factory_temporary_placement_already_applied')
    const exactBinding = { ...binding, step_id: pending.step_id }
    if (!token(exactBinding.step_id)) fail('factory_temporary_operation_mismatch')
    if (declared.binding) {
      if (!same(declared.binding, exactBinding)) fail('factory_temporary_binding_conflict')
      return clone(declared)
    }
    this.#append('temporary_binding', { intent_id: intentId, binding: exactBinding })
    return clone(this.#state.temporary_intents.find(row => row.intent_id === intentId))
  }
  temporary(intent, receipt, context) {
    this.#assert(); this.assertDurable(); owner(context)
    if (this.#worldId && this.#worldId !== context.world_id) fail('factory_lifecycle_world_mismatch')
    const declared = this.#state.temporary_intents.find(row => row.intent_id === (typeof intent === 'string' ? intent : intent?.intent_id))
    const { binding, excluded_receipt_ids, ...original } = declared ?? {}
    const retained = typeof this.#readPlacementReceipt === 'function' && this.#readPlacementReceipt(receipt?.receipt_id)
    if (!declared || !binding || !same(declared.owner, owner(context))
      || typeof intent !== 'string' && !same(original, { ...clone(intent), owner: owner(context) }) || !retained || !same(retained, receipt)
      || excluded_receipt_ids.includes(receipt.receipt_id)
      || receipt?.world_id !== context.world_id || receipt?.goal_id !== context.goal_id || receipt.actor_id !== context.actor_id
      || receipt.actor_epoch !== context.actor_epoch || !token(receipt.receipt_id) || !integer(receipt.unit_number) || receipt.unit_number < 1
      || receipt.plan_id !== context.plan_id || receipt.plan_version !== context.plan_version || receipt.semantic_step_id !== context.semantic_step_id
      || receipt.request_id !== context.request_id || receipt.step_id !== binding.step_id || receipt.operation_key !== binding.operation_key
      || receipt.name !== declared.placement.name || !same(receipt.position, declared.placement.position)
      || receipt.surface_index !== declared.placement.surface_index || receipt.force_index !== declared.placement.force_index) fail('factory_temporary_authority_unknown')
    const previous = this.#state.temporary.find(row => row.receipt_id === receipt.receipt_id)
    const { owner: declarationOwner, ...declaration } = original
    const value = { ...clone(declaration), world_id: receipt.world_id, goal_id: receipt.goal_id, unit_number: receipt.unit_number,
      receipt_id: receipt.receipt_id, placement_receipt: clone(receipt) }
    if (previous) { if (!same(previous, value)) fail('factory_temporary_conflict'); return clone(previous) }
    this.#worldId ??= context.world_id; this.#append('temporary', value); return clone(value)
  }
  scheduleCleanup(completions, context) {
    this.#assert(); owner(context)
    if (this.#worldId && this.#worldId !== context.world_id) fail('factory_lifecycle_world_mismatch')
    this.#worldId ??= context.world_id
    if (!Array.isArray(completions) || completions.some(row => row.goal_id !== context.goal_id || !token(row.semantic_step_id)
      || row.status !== 'completed' || row.verified !== true || !token(row.receipt_id))) fail('factory_cleanup_completion_unproven')
    for (const row of completions) {
      const value = { goal_id: context.goal_id, beneficiary: { goal_id: row.goal_id, semantic_step_id: row.semantic_step_id }, receipt_id: row.receipt_id }
      if (!this.#state.completions.some(old => same(old, value))) this.#append('beneficiary_completed', value)
    }
    return this.#state.temporary.filter(row => row.world_id === context.world_id && row.beneficiaries.every(b => this.#state.completions.some(c => same(c.beneficiary, b))))
      .map(row => ({ unit_number: row.unit_number, receipt_id: row.receipt_id, state: 'reconciliation_required' }))
  }
}
