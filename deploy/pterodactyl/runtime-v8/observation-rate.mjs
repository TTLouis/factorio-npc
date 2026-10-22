// Harness-owned, per-NPC rate, independent of goals, actor epochs and conversations.
export const OBSERVATION_RATE = Object.freeze({ burst: 4, refillMs: 15_000 })

function validState(value) {
  return value && Number.isSafeInteger(value.tokens) && value.tokens >= 0 && value.tokens <= OBSERVATION_RATE.burst
    && Number.isSafeInteger(value.at) && value.at >= 0
}

export function observationRateClaim(previous, count, now) {
  if (!Number.isSafeInteger(count) || count < 0 || count > OBSERVATION_RATE.burst
    || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid observation rate claim')
  // Absent state is the first use; malformed persisted state fails closed.
  const held = previous === undefined ? { tokens: OBSERVATION_RATE.burst, at: now }
    : validState(previous) ? previous : { tokens: 0, at: now }
  const at = Math.max(held.at, now) // clock rollback cannot mint credit
  const refill = Math.floor((at - held.at) / OBSERVATION_RATE.refillMs)
  const tokens = Math.min(OBSERVATION_RATE.burst, held.tokens + refill)
  const boundary = tokens === OBSERVATION_RATE.burst ? at : held.at + refill * OBSERVATION_RATE.refillMs
  const admitted = tokens >= count
  return {
    admitted,
    state: { tokens: admitted ? tokens - count : tokens, at: boundary },
    retryAfterMs: admitted ? 0 : (count - tokens) * OBSERVATION_RATE.refillMs - (at - boundary),
  }
}

export function restoreObservationRates(raw) {
  const ledger = new Map()
  if (!Array.isArray(raw)) return ledger
  for (const row of raw.slice(-128)) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0].trim() || row[0].length > 160) continue
    // Retain malformed values as closed buckets, rather than treating them as new NPCs.
    ledger.set(row[0], validState(row[1]) ? { tokens: row[1].tokens, at: row[1].at } : null)
  }
  return ledger
}
