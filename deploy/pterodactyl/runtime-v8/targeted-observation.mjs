// A closed decision can request one exact fact or a grounded resource location, without opening general discovery or
// granting gameplay authority. The allowance follows native receipt progress,
// not provider rounds, context restages, or prose claims of progress.
export function normalizeObservationRequest(value, { normalTools = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('observationRequest must be an object')
  const draft = value.scope === 'draft'
  const identityKeys = draft ? ['scope', 'goalId', 'planId', 'planVersion', 'draftRevision'] : ['scope', 'stepId']
  if (Object.keys(value).some(key => ![...identityKeys, 'tool', 'args', 'rationale'].includes(key))) throw new Error('Unexpected observationRequest field')
  if (value.scope !== undefined && !['step', 'draft'].includes(value.scope)) throw new Error('Unsupported observationRequest scope')
  if (draft) {
    if (![value.goalId, value.planId].every(id => typeof id === 'string' && id.trim() && id.length <= 240)
      || !Number.isSafeInteger(value.planVersion) || value.planVersion < 1
      || !Number.isSafeInteger(value.draftRevision) || value.draftRevision < 0) throw new Error('Draft observationRequest needs exact goalId, planId, planVersion and draftRevision')
  }
  else if (typeof value.stepId !== 'string' || !value.stepId.trim() || value.stepId.length > 240) throw new Error('observationRequest needs the exact active stepId')
  if (typeof value.rationale !== 'string' || !value.rationale.trim() || value.rationale.length > 500) throw new Error('observationRequest needs a bounded missing-fact rationale')
  const args = value.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('observationRequest.args must be an object')
  // The control transport has the same identity/envelope in both phases. Only
  // closed recovery has the narrow fact grammar below. Open requests still
  // require ordinary tool-name/argument validation and admission in the loop.
  if (normalTools) {
    if (typeof value.tool !== 'string' || !value.tool.trim() || value.tool.length > 160) throw new Error('observationRequest needs an observation tool name')
  }
  else if (value.tool === 'getEntityStatus') {
    if (Object.keys(args).length !== 1 || !Number.isSafeInteger(args.unit_number) || args.unit_number < 1) throw new Error('Targeted entity status requires only an exact unit_number')
  }
  else if (['getInventoryItems', 'getResearchStatus'].includes(value.tool)) {
    if (Object.keys(args).length !== 0) throw new Error('Targeted inventory/research status takes no arguments')
  }
  else if (value.tool === 'findLongRangeEntities') {
    if (Object.keys(args).some(key => !['name', 'max_radius', 'limit'].includes(key))
      || typeof args.name !== 'string' || !args.name.trim() || args.name.length > 200
      || !Number.isSafeInteger(args.max_radius) || args.max_radius < 64 || args.max_radius > 1024
      || args.limit !== 1) throw new Error('Targeted resource search requires an exact native source name, max_radius 64..1024 and limit 1')
  }
  else if (value.tool === 'getFluidSourceTiles') {
    if (draft || Object.keys(args).some(key => !['fluid_name', 'search_radius', 'limit'].includes(key))
      || args.fluid_name !== 'water' || !Number.isSafeInteger(args.search_radius) || args.search_radius < 1 || args.search_radius > 256
      || !Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 8) throw new Error('Targeted water coverage requires committed execution, water, search_radius 1..256 and limit 1..8; no center override')
  }
  else throw new Error('Targeted recovery permits exact status facts or one native-grounded resource search; general discovery is unavailable')
  const identity = draft
    ? { scope: 'draft', goalId: value.goalId, planId: value.planId, planVersion: value.planVersion, draftRevision: value.draftRevision }
    : { ...(value.scope ? { scope: value.scope } : {}), stepId: value.stepId }
  return { ...identity, tool: value.tool, args: { ...args }, rationale: value.rationale.trim() }
}

export function observationRecoveryBasis({ goalId, planId, stepId, receiptRef, actorId, epoch }) {
  return JSON.stringify([goalId, planId, stepId, receiptRef ?? null, actorId, epoch])
}

// Native search facts only. An empty local search is not evidence that the
// world cannot supply water. Never turn an unexplored center into a placement
// or reachability claim; it is a bounded location the model may explore.
export function localFluidSearchFact(raw, args) {
  if (typeof raw !== 'string' || raw.length > 8192 || args?.fluid_name !== 'water') return undefined
  let value
  try { value = JSON.parse(raw) } catch { return undefined }
  const radius = args.search_radius ?? 128
  const empty = table => (Array.isArray(table) && table.length === 0)
    || (table && typeof table === 'object' && Object.keys(table).length === 0)
  const point = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Math.abs(p.x) <= 10000256 && Math.abs(p.y) <= 10000256
  if (value?.ok !== true || value.fluid_name !== 'water' || value.coverage !== 'generated_bounding_square'
    || !Number.isSafeInteger(radius) || radius < 1 || radius > 256 || value.search_radius !== radius
    || !Number.isSafeInteger(value.surface_index) || value.surface_index < 1
    || !Number.isSafeInteger(value.observed_tick) || value.observed_tick < 0 || !point(value.actor_position)
    || value.returned_count !== 0 || !empty(value.samples) || value.empty_result_is_conclusive !== false
    || value.coverage_complete !== false || !Number.isSafeInteger(value.ungenerated_chunk_count) || value.ungenerated_chunk_count < 1
    || !Array.isArray(value.ungenerated_chunks) || value.ungenerated_chunks.length > 8) return undefined
  if (![value.checked_chunks, value.generated_chunk_count, value.ungenerated_chunk_count].every(n => Number.isSafeInteger(n) && n >= 0 && n <= 289)
    || value.generated_chunk_count < 1 || value.generated_chunk_count + value.ungenerated_chunk_count !== value.checked_chunks) return undefined
  if (value.ungenerated_chunks.some(c => !Number.isSafeInteger(c?.x) || !Number.isSafeInteger(c?.y)
    || c.center?.x !== c.x * 32 + 16 || c.center?.y !== c.y * 32 + 16)) return undefined
  const centers = value.ungenerated_chunks.map(chunk => chunk?.center)
  if (centers.length === 0 || centers.some(p => !point(p)
    || Math.abs(p.x - value.actor_position.x) > radius + 32 || Math.abs(p.y - value.actor_position.y) > radius + 32)) return undefined
  return { fluid_name: 'water', surface_index: value.surface_index, observed_tick: value.observed_tick,
    actor_position: { x: value.actor_position.x, y: value.actor_position.y }, search_radius: radius,
    coverage_complete: false, empty_result_is_conclusive: false, ungenerated_chunk_count: value.ungenerated_chunk_count,
    exploration_centers: centers.map(p => ({ x: p.x, y: p.y })) }
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

export const TARGETED_OBSERVATION_GUIDANCE = 'When CONTROL_DECISION_STATE.toolsEnabled is true, use ordinary observation tool calls; they follow the existing observation budget, cache and recovery limits. An observationRequest in that open phase uses the same ordinary pipeline and does not consume or activate the closed-round allowance. Only when toolsEnabled is false and targetedReadEligible is true may a specific missing live fact use the one-read closed-round allowance as a JSON control decision with unchanged plan/currentStep and operations:[]. Follow the scope and exact identities in the current [CONTROL_DECISION_STATE]. For committed execution use observationRequest:{stepId:"<active reducer step id>",tool,args,rationale}. For draft planning use observationRequest:{scope:"draft",goalId,planId,planVersion,draftRevision,tool,args,rationale}; no committed step is required to correct or author a draft. For that closed-round allowance, supported facts are exact getEntityStatus({unit_number:<observed exact unit>}), getInventoryItems({}) and getResearchStatus({}). If native recipe data identifies a mined_from resource, the same one-read allowance can instead request findLongRangeEntities({name:<that exact resource>,max_radius:1024,limit:1}) after an empty nearby scan or a missing location. Only names in resourceSearchNames in CONTROL_DECISION_STATE are eligible; a name guessed from an item is not sufficient. When targetedWaterSearch is present in CONTROL_DECISION_STATE, a fresh native water_search_required refusal or empty actor-centered offshore-pump search permits getFluidSourceTiles using the supplied water args through that SAME one-read allowance. It reads actor-centered native water coverage, not a legal placement or reachable destination; no center override is allowed. Local absence cannot establish a world blocker. After a movement receipt, use fresh water and placement observations. In that closed phase, no general discovery, plan edits or completion claims may accompany the read. It grants no gameplay authority. Draft revision/restaging/restart cannot renew its one-read allowance; committed execution renews only with native receipt or active-step progress. Reuse sufficient facts instead of requesting a read. A previous_recipe_name is historical, not current configuration.'
