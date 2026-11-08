// Goal-scoped accounting. Strategy revisions never create a new allowance.
// Native peaks are keyed by the requirement's subject, not IDs, wording or targets.
export const GOAL_EFFORT_LIMIT = 24
const record = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype
export function restoreGoalEffort(raw) {
  if (raw === undefined) return { version: 1, spent: 0, total: 0, peaks: {}, raw_peaks: {}, blockers: {}, credits: 0 }
  if (raw?.version !== 1 || !Number.isSafeInteger(raw.spent) || raw.spent < 0
    || !Number.isSafeInteger(raw.total) || raw.total < raw.spent || !Number.isSafeInteger(raw.credits) || raw.credits < 0
    || !record(raw.peaks) || !record(raw.blockers) || Object.keys(raw.peaks).length > 256 || Object.keys(raw.blockers).length > 128
    || Object.values(raw.peaks).some(v => !Number.isFinite(v) || v < 0)
    || raw.raw_peaks !== undefined && (!record(raw.raw_peaks) || Object.keys(raw.raw_peaks).length > 256 || Object.values(raw.raw_peaks).some(v => !Number.isFinite(v) || v < 0))
    || Object.values(raw.blockers).some(v => !Number.isSafeInteger(v) || v < 1)) {
    return { version: 1, spent: GOAL_EFFORT_LIMIT, total: GOAL_EFFORT_LIMIT, peaks: {}, raw_peaks: {}, blockers: {}, credits: 0, fault: true }
  }
  return { ...structuredClone(raw), raw_peaks: { ...(raw.raw_peaks ?? {}) } }
}
export function spendGoalEffort(raw, blocker = 'executor_decision') {
  const held = restoreGoalEffort(raw)
  if (held.fault || held.spent >= GOAL_EFFORT_LIMIT) return undefined
  // Callers supply structured codes/subjects; never include rationale/request/plan IDs.
  const key = String(blocker).slice(0, 240)
  const known = Object.hasOwn(held.blockers, key)
  const subject = known || Object.keys(held.blockers).length < 127 ? key : 'other'
  return { ...held, spent: held.spent + 1, total: held.total + 1,
    blockers: { ...held.blockers, [subject]: (held.blockers[subject] ?? 0) + 1 } }
}
export function creditGoalEffort(raw, contract, facts) {
  const held = restoreGoalEffort(raw)
  if (held.fault) return held
  const peaks = { ...held.peaks }; const rawPeaks = { ...held.raw_peaks }; let progress = false
  for (const requirement of contract?.requirements ?? []) {
    const fact = facts?.[requirement.id]
    if (!fact || fact.authoritative !== true || fact.stale === true || fact.kind !== requirement.kind) continue
    // Counts and completed research are useful native advancement. Receipts,
    // controller health, movement and per-unit replacement are not productivity.
    if (!['inventory_count', 'entity_count', 'research_completed'].includes(requirement.kind)) continue
    const subject = requirement.item_name ?? requirement.prototype ?? requirement.technology
    if (!subject) continue
    const key = JSON.stringify([requirement.kind, subject, requirement.surface_index ?? null])
    const rawValue = requirement.kind === 'research_completed' ? (fact.satisfied === true ? 1 : 0) : fact.current
    const value = requirement.kind === 'research_completed' ? rawValue : Math.min(requirement.minimum, rawValue)
    if (!Number.isFinite(value) || value < 0) continue
    if (!Object.hasOwn(peaks, key)) {
      if (Object.keys(peaks).length < 256) { peaks[key] = value; rawPeaks[key] = rawValue } // first read is baseline, never credit
      continue
    }
    if (Number.isFinite(rawPeaks[key]) && rawValue > rawPeaks[key] && value > peaks[key]) progress = true
    peaks[key] = Math.max(peaks[key], value)
    rawPeaks[key] = Math.max(rawPeaks[key] ?? rawValue, rawValue)
  }
  return { ...held, peaks, raw_peaks: rawPeaks, spent: progress ? 0 : held.spent, credits: held.credits + (progress ? 1 : 0) }
}
