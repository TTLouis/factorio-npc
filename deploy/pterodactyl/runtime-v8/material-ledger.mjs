import { itemName, normalizeCounts, normalizeTargets, quantity } from './quantity-compiler.mjs'
import { createHash } from 'node:crypto'

export const MATERIAL_LEDGER_LIMIT = 64
export function materialOwnerKey(owner) {
  if (!owner || !['goal_id', 'plan_id', 'step_id'].every(key => typeof owner[key] === 'string' && owner[key].length > 0 && owner[key].length <= 200)
    || !Number.isSafeInteger(owner.plan_version) || owner.plan_version < 1) throw new Error('invalid_material_owner')
  return JSON.stringify([owner.goal_id, owner.plan_id, owner.plan_version, owner.step_id])
}
export function checkpointMaterialOwner(owner) {
  return { ...owner, step_id: `checkpoint-${createHash('sha256').update(materialOwnerKey(owner)).digest('hex').slice(0, 32)}` }
}
export function restoreMaterialLedger(raw) {
  if (raw === undefined) return { version: 1, sequence: 0, claims: [] }
  if (raw?.version !== 1 || !Number.isSafeInteger(raw.sequence) || raw.sequence < 0
    || !Array.isArray(raw.claims) || raw.claims.length > MATERIAL_LEDGER_LIMIT) throw new Error('invalid_material_ledger')
  const seen = new Set()
  const claims = raw.claims.map(claim => {
    const owner = { goal_id: claim.owner?.goal_id, plan_id: claim.owner?.plan_id, plan_version: claim.owner?.plan_version, step_id: claim.owner?.step_id }
    const key = materialOwnerKey(owner)
    if (seen.has(key) || !['reservation', 'forecast'].includes(claim.kind)) throw new Error('invalid_material_claim')
    seen.add(key)
    return { owner, kind: claim.kind, items: normalizeTargets(claim.items), revision: quantity(claim.revision) }
  })
  return { version: 1, sequence: raw.sequence, claims }
}
export function claimMaterials(raw, { owner, items, kind = 'reservation' }) {
  const ledger = restoreMaterialLedger(raw)
  const key = materialOwnerKey(owner)
  if (!['reservation', 'forecast'].includes(kind)) throw new Error('invalid_material_claim_kind')
  const previous = ledger.claims.find(claim => materialOwnerKey(claim.owner) === key)
  const claim = { owner: { ...owner }, kind, items: normalizeTargets(items), revision: (previous?.revision ?? 0) + 1 }
  if (claim.revision > 10000) throw new Error('material_revision_exhausted')
  const claims = [...ledger.claims.filter(row => materialOwnerKey(row.owner) !== key), claim]
  if (claims.length > MATERIAL_LEDGER_LIMIT) throw new Error('material_ledger_exhausted')
  return { version: 1, sequence: ledger.sequence + 1, claims }
}
export function releaseMaterials(raw, owner) {
  const ledger = restoreMaterialLedger(raw)
  return { ...ledger, sequence: ledger.sequence + 1, claims: ledger.claims.filter(row => materialOwnerKey(row.owner) !== materialOwnerKey(owner)) }
}
export function materialAvailability(raw, { owner, inventory, fresh, pending = [] }) {
  if (fresh !== true) throw new Error('material_inventory_not_fresh')
  const ledger = restoreMaterialLedger(raw)
  const held = normalizeCounts(inventory)
  const key = materialOwnerKey(owner)
  const reserved = Object.create(null); const forecast = Object.create(null); const in_flight = Object.create(null)
  for (const claim of ledger.claims) for (const row of claim.items) {
    if (claim.kind === 'forecast') forecast[row.item_name] = (forecast[row.item_name] ?? 0) + row.count
    else if (materialOwnerKey(claim.owner) !== key) reserved[row.item_name] = (reserved[row.item_name] ?? 0) + row.count
  }
  if (!Array.isArray(pending) || pending.length > MATERIAL_LEDGER_LIMIT) throw new Error('invalid_pending_materials')
  for (const row of pending) {
    // Pending/prospective output is useful planning context, never executable stock.
    const name = itemName(row.item_name)
    in_flight[name] = (in_flight[name] ?? 0) + quantity(row.count)
  }
  const available = Object.fromEntries(Object.entries(held).map(([name, n]) => [name, Math.max(0, n - (reserved[name] ?? 0))]))
  return { held, reserved, available, forecast, in_flight, pending_is_inventory: false }
}
