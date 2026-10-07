// A closed decision can request one exact fact, without opening discovery or
// granting gameplay authority. The allowance follows native receipt progress,
// not provider rounds, context restages, or prose claims of progress.
export function normalizeObservationRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('observationRequest must be an object')
  if (Object.keys(value).some(key => !['stepId', 'tool', 'args', 'rationale'].includes(key))) throw new Error('Unexpected observationRequest field')
  if (typeof value.stepId !== 'string' || !value.stepId.trim() || value.stepId.length > 240) throw new Error('observationRequest needs the exact active stepId')
  if (typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale.length > 500) throw new Error('observationRequest needs a bounded missing-fact rationale')
  const args = value.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('observationRequest.args must be an object')
  if (value.tool === 'getEntityStatus') {
    if (Object.keys(args).length !== 1 || !Number.isSafeInteger(args.unit_number) || args.unit_number < 1) throw new Error('Targeted entity status requires only an exact unit_number')
  }
  else if (['getInventoryItems', 'getResearchStatus'].includes(value.tool)) {
    if (Object.keys(args).length !== 0) throw new Error('Targeted inventory/research status takes no arguments')
  }
  else throw new Error('Targeted recovery permits only exact getEntityStatus, getInventoryItems, or getResearchStatus; discovery is unavailable')
  return { stepId: value.stepId, tool: value.tool, args: { ...args }, rationale: value.rationale.trim() }
}

export function observationRecoveryBasis({ goalId, planId, stepId, receiptRef, actorId, epoch }) {
  return JSON.stringify([goalId, planId, stepId, receiptRef ?? null, actorId, epoch])
}

export function restoreObservationLedger(rows) {
  const ledger = new Map()
  for (const row of Array.isArray(rows) ? rows.slice(0, 128) : []) {
    if (!Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' || row[0].length > 240 || typeof row[1] !== 'string' || row[1].length > 1500) continue
    let basis
    try { basis = JSON.parse(row[1]) } catch { continue }
    if (!Array.isArray(basis) || basis.length !== 6 || !basis.slice(0, 3).every(id => typeof id === 'string' && id.length > 0 && id.length <= 240)
      || !(basis[3] === null || (typeof basis[3] === 'string' && basis[3].length <= 240))
      || !basis.slice(4).every(id => Number.isSafeInteger(id) && id >= 0)) continue
    ledger.set(row[0], row[1])
  }
  return ledger
}

export const TARGETED_OBSERVATION_GUIDANCE = 'When a specific missing live fact prevents the next action after observations close, return one JSON control decision with the unchanged plan/currentStep, operations:[], and observationRequest:{stepId:"<exact active reducer step id>",tool:"getEntityStatus",args:{unit_number:<observed exact unit>},rationale:"<missing fact and why needed>"}. getInventoryItems or getResearchStatus with args:{} are also supported. This requests one bounded harness read, not a tool invocation. No discovery, plan edits or completion claims may accompany it. The allowance is one read until a new correlated operation receipt or active step; restaging/restarting does not renew it. After the result, return an action, grounded completion, or truthful blocker. A previous_recipe_name is historical and does not mean a machine currently has that recipe.'
