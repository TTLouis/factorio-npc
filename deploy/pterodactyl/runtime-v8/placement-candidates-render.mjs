// How a getPlacementCandidates answer reads to the model. The mod serialises its answer with helpers.table_to_json, whose
// key order is the Lua table's hash order, so the block of rejected-footprint samples could come before the legal
// candidates (Run 19af: both roles read the answer as blocked). The facts are untouched; only their order and a label
// change: the legal candidates lead, and the rejected footprints come last under a label that says they are not candidates.

export const REJECTED_FOOTPRINTS_LABEL = 'rejected_footprint_samples_not_candidates'

const LEADING_KEYS = ['ok', 'code', 'error', 'entity_name', 'ordering', 'legal_candidate_count', 'returned_candidate_count', 'candidates']
const MAX_PARSED_CHARS = 200_000

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
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
  const ordered = {}
  for (const key of LEADING_KEYS) if (Object.hasOwn(parsed, key)) ordered[key] = parsed[key]
  for (const [key, value] of Object.entries(parsed)) if (key !== 'obstructions' && !Object.hasOwn(ordered, key)) ordered[key] = value
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
      ordered.candidates_omitted_for_size = all.length - kept.length
      text = JSON.stringify(ordered)
    }
  }
  // Last resort: the answer's headline facts, never a cut through the middle of the text.
  if (text.length > maxChars) {
    const headline = {}
    for (const key of LEADING_KEYS) if (key !== 'candidates' && Object.hasOwn(parsed, key)) headline[key] = parsed[key]
    text = JSON.stringify({ ...headline, truncated_for_size: true })
  }
  return text
}
