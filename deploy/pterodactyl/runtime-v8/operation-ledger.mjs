import { sanitizePendingOperation, duplicateEffectGuard, operationSignature, settledSlotMatch, closesSettledPrefix, PLACEMENT_FENCE_CLOSING_OPERATIONS, SETTLED_PREFIX_KIND, EFFECT } from './operation-reconciliation.mjs'

export const OPERATION_LEDGER_LIMIT = 64
// Closed records kept in the window, plus the settled-prefix fences still open that the window would otherwise push out.
export const CLOSED_LEDGER_WINDOW = 64
export const OPEN_FENCE_RETENTION = 8

// A settled-prefix fence is OPEN until a later closed record of the same goal, plan and step is a completed batch containing a
// placement (closesSettledPrefix). It is scoped to its plan and step, so a new step or plan never inherits it.
function isFenceRecord(record) {
  return record?.settlement?.kind === SETTLED_PREFIX_KIND && Boolean(record.plan_id) && Boolean(record.step_id)
}
function fenceOpenAt(closed, index) {
  return isFenceRecord(closed[index]) && !closed.slice(index + 1).some(later => closesSettledPrefix(later, closed[index]))
}
function trimClosed(closed) {
  const window = closed.length - CLOSED_LEDGER_WINDOW
  if (window <= 0) return closed
  const kept = new Set()
  for (let index = window - 1; index >= 0 && kept.size < OPEN_FENCE_RETENTION; index--) if (fenceOpenAt(closed, index)) kept.add(index)
  return closed.filter((_, index) => index >= window || kept.has(index))
}
export function openSettledFences(closed, planId, stepId) {
  if (!planId || !stepId) return []
  return closed.filter((record, index) => record.plan_id === planId && record.step_id === stepId && fenceOpenAt(closed, index))
}
export function operationLedger(raw, legacy) {
  const records = Array.isArray(raw?.records) ? raw.records : []
  if (records.length > OPERATION_LEDGER_LIMIT) throw new Error('Unresolved operation ledger exceeds capacity')
  const unique = new Map()
  for (const value of [...records, ...(legacy ? [legacy] : [])]) {
    const record = sanitizePendingOperation(value)
    // Pre-journal records have no exact receipt identity. They keep blocking every
    // conflicting effect (scope '*'), and keep protocol_version 1 so they can still be
    // reconciled by the batch-baseline algorithm when its evidence applies. Without
    // that evidence they become an explicit user question, never a silent hold.
    if (record && record.protocol_version !== 2) {
      record.legacy = true
      record.scopes = ['*']
    }
    if (record && !unique.has(record.operation_key)) unique.set(record.operation_key, record)
  }
  if (unique.size > OPERATION_LEDGER_LIMIT) throw new Error('Unresolved operation ledger exceeds capacity')
  const closed = trimClosed((Array.isArray(raw?.closed) ? raw.closed : []).map(sanitizePendingOperation).filter(Boolean))
  const sequence = Math.max(Number.isSafeInteger(raw?.sequence) ? raw.sequence : 0, unique.size,
    ...[...unique.values(), ...closed].map(record => Number.isSafeInteger(record?.ordinal) ? record.ordinal : 0))
  return { version: 1, sequence,
    records: [...unique.values()], closed }
}
export function recordOperation(raw, record) {
  const ledger = operationLedger(raw)
  const index = ledger.records.findIndex(item => item.operation_key === record.operation_key)
  if (index < 0 && ledger.records.length >= OPERATION_LEDGER_LIMIT) return null
  if (index < 0) { ledger.records.push(record); ledger.sequence++ }
  else ledger.records[index] = record
  return ledger
}
export function settleOperation(raw, key) {
  const ledger = operationLedger(raw)
  const index = ledger.records.findIndex(item => item.operation_key === key)
  if (index < 0) return ledger
  const [record] = ledger.records.splice(index, 1)
  ledger.closed = trimClosed([...ledger.closed, record])
  return ledger
}
export function pendingOperations(state) {
  return operationLedger(state?.operation_ledger, state?.run?.pending_operation).records
}
export function conflictingOperation(state, proposed) {
  for (const record of pendingOperations(state)) {
    const guard = duplicateEffectGuard(record, proposed)
    if (guard.refuse) return guard
  }
  // A known partial batch is no longer uncertain, but its successful tasks
  // must never be replayed as the original batch for the same committed step.
  const closed = operationLedger(state?.operation_ledger).closed
  const gatherRecovery = proposed.gatherRecoveryKey && proposed.operations?.every(op => ['gather_resource', 'mine_resource_at'].includes(op.name))
    && closed.some(record => record.operation_key === proposed.gatherRecoveryKey && record.reason === 'exact_terminal_gather_cancelled'
      && record.plan_id === proposed.planId && record.step_id === proposed.stepId && record.effect === EFFECT.PARTIAL_KNOWN)
  // A completed prefix the harness settled from the native receipt is never delivered again while its refused placement is
  // still being recovered. The whole-batch signature below cannot see a replay whose placement arguments changed, so the fence
  // is per operation (settledSlotMatch): the canonical identity of the slot, the same exact delivery with another count, or the
  // same item in the same direction when either side names no exact unit (a name-targeted transfer is ambiguous).
  // A settlement that cannot be matched per slot (identity_complete false: a record restored without the slots' identities or
  // delivery facts) admits only placement-only batches while it is open.
  for (const fence of openSettledFences(closed, proposed.planId, proposed.stepId)) {
    const settlement = fence.settlement
    const refusal = (hit, match) => ({ refuse: true, reason: 'settled_prefix_operation_replay', operation_key: fence.operation_key, effect: fence.effect,
      verdict: fence.verdict, state: fence.state, batch_id: fence.batch_id,
      settled: { batch_ref: settlement.batch_ref, replayed_operation: hit.operation, completed_slot: hit.slot,
        completed_operations: settlement.completed.map(item => ({ slot: item.slot, operation: item.operation })),
        refused_slot: settlement.refused_slot, refusal_codes: settlement.refusal_codes, only_placement_remains: true, match } })
    for (const operation of Array.isArray(proposed.operations) ? proposed.operations : []) {
      if (settlement.identity_complete === false) {
        if (!PLACEMENT_FENCE_CLOSING_OPERATIONS.has(operation?.name)) return refusal(settlement.completed[0], 'identity_unavailable')
        continue
      }
      for (const item of settlement.completed) {
        const match = settledSlotMatch(item, operation)
        if (match) return refusal(item, match)
      }
    }
  }
  for (const record of closed) {
    // Only the harness's fresh checkpoint-deficit path can retry a terminal
    // acquisition with the same signature (including a zero-yield attempt).
    // Ordinary model batches and all transfer/mixed batches retain the fence.
    if (gatherRecovery && record.reason === 'exact_terminal_gather_cancelled') continue
    if (record.effect === EFFECT.PARTIAL_KNOWN && record.plan_id === proposed.planId && record.step_id === proposed.stepId
      && record.signature === operationSignature(proposed.operations)) {
      return { refuse: true, reason: 'terminal_partial_batch_replay', operation_key: record.operation_key,
        effect: record.effect, verdict: record.verdict, state: record.state }
    }
  }
  return { refuse: false }
}
