// Dependency-free compatibility mapping shared by the canonical memory and
// lifecycle controller. Importing it must not initialize either runtime.

// Two step lists describe the same slice when their normalized descriptions
// match one for one. Long descriptions are compared on a bounded prefix so a
// truncation on either side cannot split them.
function stepKey(description) {
  return String(description ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().toLocaleLowerCase().slice(0, 200)
}

export function carriedPrefixLength(plan) {
  return Array.isArray(plan?.carried_forward_evidence) ? plan.carried_forward_evidence.length : 0
}

/**
 * How the legacy board and the reducer plan line up: the board index of the
 * reducer plan's first step. A revised plan carries its verified predecessor
 * steps on the board only (offset = carried prefix); every other plan starts
 * at 0. `undefined` when the two do not describe the same steps.
 */
export function boardPlanAlignment(board, plan) {
  if (!Array.isArray(board?.steps) || !Array.isArray(plan?.steps) || plan.steps.length === 0) return undefined
  const aligned = offset => board.steps.length === offset + plan.steps.length
    && plan.steps.every((step, index) => stepKey(step?.description) === stepKey(board.steps[offset + index]?.description))
  const carried = carriedPrefixLength(plan)
  if (carried > 0 && aligned(carried)) return carried
  return aligned(0) ? 0 : undefined
}
