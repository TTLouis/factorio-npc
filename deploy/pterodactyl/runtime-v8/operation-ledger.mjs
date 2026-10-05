import { sanitizePendingOperation, duplicateEffectGuard } from './operation-reconciliation.mjs'

export const OPERATION_LEDGER_LIMIT = 64
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
  const closed = (Array.isArray(raw?.closed) ? raw.closed : []).slice(-64).map(sanitizePendingOperation).filter(Boolean)
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
  ledger.closed = [...ledger.closed, record].slice(-64)
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
  return { refuse: false }
}
