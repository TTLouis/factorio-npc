// Waits from game data (work plan item 2.5; W2b first item; the "calculated /
// condition-based waits" section of NPC_PROVIDER_CONTINUATION_RECOVERY.md).
//
// While a furnace or assembler works toward the active step, the planner stays
// asleep on a runtime condition wait instead of guessing a `wait {ticks}`. The
// mod answers each condition poll with the machine's expected time
// (packages/autorio/src/production_eta.ts: recipe energy over the live
// crafting speed, the craft under way, loaded inputs and fuel). From that the
// harness derives:
//   - expected_seconds / expected_finish_at, shown in observations and traced;
//   - the wake deadline: expected x OVERRUN_FACTOR + a fixed margin, bounded,
//     after which the planner wakes with an overrun (condition_timeout);
//   - a check budget that never ends the wait before that deadline.
// The wait still ends early when the checkpoint holds (the step closes only on
// that verified condition) or when the machine stops working. Elapsed time is
// never proof of production. Without an expectation from the game the
// existing bounded defaults stay in force; nothing is guessed.

export const OVERRUN_FACTOR = 1.5
export const MARGIN_SECONDS = 30
export const POLL_SECONDS = 2
export const MAX_WAIT_MS = 2 * 60 * 60 * 1000
export const MAX_CHECKS = 7200
export const WAIT_BASIS = 'recipe energy / live crafting speed, loaded inputs and fuel (Autorio machine_eta)'
const LIMITS = new Set(['inputs', 'fuel', 'power', 'output_full'])

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function round1(value) {
  return Math.round(value * 10) / 10
}

// The machine expectation a condition observation carries, compact. A
// completion checkpoint uses the time to its target; a passive wait the time
// until the loaded inputs or fuel run out.
export function conditionEta(observation) {
  const eta = observation?.eta
  if (!eta || typeof eta !== 'object' || Array.isArray(eta)) return undefined
  const toTarget = finiteNonNegative(eta.seconds_to_target)
  const untilIdle = finiteNonNegative(eta.seconds_until_idle)
  const secondsPerCraft = finiteNonNegative(eta.seconds_per_craft)
  if (toTarget === undefined && untilIdle === undefined) return undefined
  return {
    ...(typeof eta.recipe === 'string' ? { recipe: eta.recipe.slice(0, 120) } : {}),
    ...(toTarget !== undefined ? { seconds_to_target: round1(toTarget) } : {}),
    ...(untilIdle !== undefined ? { seconds_until_idle: round1(untilIdle) } : {}),
    ...(secondsPerCraft !== undefined ? { seconds_per_craft: secondsPerCraft } : {}),
    ...(Number.isSafeInteger(eta.crafts_needed) ? { crafts_needed: eta.crafts_needed } : {}),
    ...(LIMITS.has(eta.limited_by) ? { limited_by: eta.limited_by } : {}),
  }
}

// Seconds the wait is expected to last from now, for this wait's mode.
export function expectedSecondsFor(wait, eta) {
  if (!eta) return undefined
  return wait?.mode === 'passive_progress' ? eta.seconds_until_idle : eta.seconds_to_target
}

// Schedule a wait from the first game-data expectation it sees. The deadline
// is fixed once so a slow machine cannot keep pushing it out; later polls only
// refresh the expected finish shown to the planner.
export function scheduleWait(wait, eta, { now = Date.now() } = {}) {
  const expected = expectedSecondsFor(wait, eta)
  if (!wait || expected === undefined) return { wait, scheduled: false }
  const refreshed = {
    ...wait,
    expected_seconds: round1(expected),
    expected_finish_at: now + Math.round(expected * 1000),
    ...(eta.limited_by ? { eta_limited_by: eta.limited_by } : { eta_limited_by: undefined }),
  }
  if (Number.isFinite(wait.eta_scheduled_at)) return { wait: refreshed, scheduled: false }

  const registeredAt = Number.isFinite(wait.registered_at) ? wait.registered_at : now
  const elapsedMs = Math.max(0, now - registeredAt)
  const derivedMs = elapsedMs + Math.ceil((expected * OVERRUN_FACTOR + MARGIN_SECONDS) * 1000)
  // A passive wait also wakes when the machine stops, and a machine fed by a
  // drill or inserter outlives its loaded inputs, so game data may lengthen a
  // passive wait but never cut it below the default bound.
  const timeoutMs = Math.min(MAX_WAIT_MS, wait.mode === 'passive_progress'
    ? Math.max(derivedMs, Number.isSafeInteger(wait.timeout_ms) ? wait.timeout_ms : 0)
    : Math.max(1000, derivedMs))
  const checks = Math.min(MAX_CHECKS, Math.ceil(timeoutMs / (POLL_SECONDS * 1000)) + 2)
  return {
    wait: {
      ...refreshed,
      timeout_ms: timeoutMs,
      max_checks: Math.max(Number.isSafeInteger(wait.max_checks) ? wait.max_checks : 0, checks),
      eta_scheduled_at: now,
    },
    scheduled: true,
  }
}

// Keep only the scheduling fields a persisted wait may carry.
export function safeWaitSchedule(value) {
  if (!value || typeof value !== 'object') return {}
  const result = {}
  const expected = finiteNonNegative(value.expected_seconds)
  if (expected !== undefined) result.expected_seconds = round1(expected)
  if (Number.isFinite(value.expected_finish_at)) result.expected_finish_at = value.expected_finish_at
  if (Number.isFinite(value.eta_scheduled_at)) result.eta_scheduled_at = value.eta_scheduled_at
  if (LIMITS.has(value.eta_limited_by)) result.eta_limited_by = value.eta_limited_by
  return result
}

// The single-requirement checkpoint on a crafting machine's output that a
// completion wait can hold on, when the machine was last seen working. Other
// contracts (several requirements, the actor's own inventory) stay with the
// planner.
export function checkpointWaitRequirement(contract, isWorking) {
  const requirements = Array.isArray(contract?.requirements) ? contract.requirements : []
  if (contract?.mode === 'semantic_unknown' || requirements.length !== 1) return undefined
  const requirement = requirements[0]
  if (requirement?.kind !== 'entity_inventory_count' || !Number.isSafeInteger(requirement.unit_number)) return undefined
  return isWorking(requirement.unit_number) ? requirement : undefined
}
