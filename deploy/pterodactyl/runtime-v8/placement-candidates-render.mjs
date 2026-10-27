// How a getPlacementCandidates answer reads to the model. The mod serialises its answer with helpers.table_to_json, whose
// key order is the Lua table's hash order, so the block of rejected-footprint samples could come before the legal
// candidates (Run 19af: both roles read the answer as blocked). The facts are untouched; only their order and a label
// change: the legal candidates lead, and the rejected footprints come last under a label that says they are not candidates.
//
// M2 adds the dimensions a constrained search reports: the region searched, how far the search got (spatial_status and
// search_completeness) and whether the candidates can be executed now (material_status, execution_eligibility). Two short
// sentences state what those fields establish: an empty or truncated answer says what was verified, never that the placement
// cannot exist, and candidates the NPC lacks the item for are marked as planning options. Everything the mod sent is kept.

import { describeRegion } from './placement-region.mjs'

export const REJECTED_FOOTPRINTS_LABEL = 'rejected_footprint_samples_not_candidates'

const LEADING_KEYS = ['ok', 'code', 'error', 'entity_name', 'region', 'region_semantics', 'spatial_status', 'scope_report', 'execution_eligibility', 'material_status', 'execution_report', 'search_completeness', 'ordering', 'legal_candidate_count', 'returned_candidate_count', 'candidates', 'candidates_may_be_incomplete', 'candidates_incomplete_reason']
const MAX_PARSED_CHARS = 200_000

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : undefined)
const short = value => (typeof value === 'string' && value.length > 0 ? value.slice(0, 80) : undefined)

// What the spatial fields establish, in words. Absent fields (an answer from a mod without them) produce no sentence.
function scopeReport(result) {
  const status = result.spatial_status
  if (typeof status !== 'string') return undefined
  const completeness = plainObject(result.search_completeness) ? result.search_completeness : {}
  const where = plainObject(result.region) ? ` (${describeRegion(result.region)})` : ''
  const evaluated = count(completeness.evaluated_positions)
  const outside = count(completeness.region_rejected_count)
  const legal = count(completeness.legal_candidate_count)
  const reason = short(completeness.reason) ?? 'reason not reported'
  const tally = [
    evaluated === undefined ? undefined : `${evaluated} positions evaluated`,
    outside === undefined ? undefined : `${outside} outside the region`,
    legal === undefined ? undefined : `${legal} legal in the region`,
  ].filter(Boolean).join(', ')
  if (status === 'none_in_verified_scope') return `none in the verified region${where}: the search was complete${tally ? ` (${tally})` : ''}. Only that region was verified.`
  if (status === 'search_incomplete') return `search incomplete: ${reason}${tally ? ` (${tally})` : ''}. The region${where} was not fully verified, so the absence of a candidate is not established.`
  if (status === 'candidates_found' && completeness.complete === false) return `candidates found in the region${where}; search incomplete: ${reason}${tally ? ` (${tally})` : ''}, so further in-region positions may exist that were not evaluated.`
  return undefined
}

// Candidates are planning options, not executable now, when the item is not held (stock_shortfall) or cannot be resolved
// (material_unknown). eligible and no_candidate say nothing extra.
function executionReport(result) {
  const eligibility = result.execution_eligibility
  if (eligibility !== 'stock_shortfall' && eligibility !== 'material_unknown') return undefined
  const material = plainObject(result.material_status) ? result.material_status : {}
  const item = short(material.item_name) ?? 'the placement item'
  if (eligibility === 'material_unknown') return `material_unknown: whether ${item} is held could not be resolved. These candidates are planning options, not verified executable.`
  const held = count(material.held_count)
  const required = count(material.required_count) ?? 1
  return `stock_shortfall: ${item} held ${held === undefined ? 'unknown' : held} of ${required} required. These candidates are planning options, not executable now: place_candidate is refused for stock until the item is held.`
}

// The rejected-footprint block, labelled. A block that does not look like the mod's is left as it is.
function labelled(block) {
  if (!plainObject(block)) return block
  return { label: REJECTED_FOOTPRINTS_LABEL, ...block }
}

// maxChars is the message limit the caller will cut the text to (the staging loop passes its own constant).
export function renderPlacementCandidatesResult(raw, maxChars) {
  if (typeof raw !== 'string' || raw.length > MAX_PARSED_CHARS || !Number.isSafeInteger(maxChars) || maxChars < 200) return raw
  let parsed
  try { parsed = JSON.parse(raw) }
  catch { return raw }
  if (!plainObject(parsed)) return raw
  const source = { ...parsed }
  const scope = scopeReport(parsed)
  if (scope !== undefined) source.scope_report = scope
  const execution = executionReport(parsed)
  if (execution !== undefined) source.execution_report = execution
  if (execution !== undefined && Array.isArray(source.candidates)) source.candidates = source.candidates.map(candidate => (plainObject(candidate) ? { ...candidate, executable_now: false } : candidate))
  const ordered = {}
  for (const key of LEADING_KEYS) if (Object.hasOwn(source, key)) ordered[key] = source[key]
  for (const [key, value] of Object.entries(source)) if (key !== 'obstructions' && !Object.hasOwn(ordered, key)) ordered[key] = value
  if (Object.hasOwn(parsed, 'obstructions')) ordered.obstructions = labelled(parsed.obstructions)
  let text = JSON.stringify(ordered)
  // The message limit cuts the tail. Drop rejected-footprint samples (the part least needed) so the candidates stay
  // whole, valid JSON, and say so, instead of a cut through the middle of the text.
  const samples = ordered.obstructions?.samples
  if (text.length > maxChars && Array.isArray(samples) && samples.length > 0) {
    const kept = [...samples]
    while (kept.length > 0 && text.length > maxChars) {
      kept.pop()
      ordered.obstructions = { ...ordered.obstructions, samples: kept, samples_omitted_for_size: samples.length - kept.length }
      text = JSON.stringify(ordered)
    }
  }
  // Then the lowest-ranked candidates, from the tail, so what is returned is still whole, valid JSON.
  if (text.length > maxChars && Array.isArray(ordered.candidates) && ordered.candidates.length > 0) {
    const all = ordered.candidates
    const kept = [...all]
    while (kept.length > 0 && text.length > maxChars) {
      kept.pop()
      ordered.candidates = kept
      ordered.returned_candidate_count = kept.length
      ordered.candidates_omitted_for_size = all.length - kept.length
      text = JSON.stringify(ordered)
    }
  }
  // Last resort: the answer's headline facts, never a cut through the middle of the text.
  if (text.length > maxChars) {
    const headline = {}
    for (const key of LEADING_KEYS) if (key !== 'candidates' && Object.hasOwn(source, key)) headline[key] = source[key]
    text = JSON.stringify({ ...headline, truncated_for_size: true })
  }
  return text
}
