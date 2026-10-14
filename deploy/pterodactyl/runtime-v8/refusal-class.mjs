// Refusal classes: what kind of recovery a preflight/admission refusal gets.
//
// The class is declared once by whoever PRODUCES the refusal and travels on it as `refusal_class`:
//   - the mod's `autorio_preflight.operation` attaches it to every ok:false result (packages/autorio/src/refusal_classes.ts);
//   - admission refusals get it from authorization.mjs (ADMISSION_REFUSAL_CLASS);
//   - the few refusals the loop itself raises (transport error, checkpoint stock guard, duplicate-effect hold, pending
//     step contract) set it where they build the refusal.
// The loop only reads it (refusalClassOf). It keeps no list of codes to decide between recovery paths.
//
// The closed set below must equal REFUSAL_CLASSES in the mod's refusal_classes.ts; refusal-class.test.mjs proves it.
//   argument      the model named or shaped something wrongly: one bounded correction turn, plan unchanged
//   authority     a protected, reserved or player-owned target: one authorization retry inside the grant
//   prerequisite  a research precondition: bounded research recovery inside the same step
//   world         everything else, and the fail-closed class: the request ends as blocked_preflight

import { PAUSE_CLASS } from './pause-class.mjs'

export const REFUSAL_CLASS = Object.freeze({
  ARGUMENT: 'argument',
  AUTHORITY: 'authority',
  PREREQUISITE: 'prerequisite',
  WORLD: 'world',
})
export const REFUSAL_CLASSES = Object.freeze(Object.values(REFUSAL_CLASS))

// { refusal_class, classified }: a refusal with a missing or unknown class is not guessed at. It takes the world path and the
// caller reports it (operations.preflight_unclassified) so the producer that forgot to declare a class gets fixed.
export function refusalClassOf(preflight) {
  const declared = preflight?.refusal_class
  if (typeof declared === 'string' && REFUSAL_CLASSES.includes(declared)) return { refusal_class: declared, classified: true }
  return { refusal_class: REFUSAL_CLASS.WORLD, classified: false }
}

// The class as it is written on trace rows: the declared class, or 'unclassified' (never silently 'world').
export function refusalClassLabel(preflight) {
  const { refusal_class: refusalClass, classified } = refusalClassOf(preflight)
  return classified ? refusalClass : 'unclassified'
}

// --- who can fix a refusal -----------------------------------------------------------------------------------------------------
//
// The class above picks the in-request recovery. It does not say who can fix a refusal that outlived it. That is a second, separate
// question (NEVER_WAKE_PREFLIGHT_CODES in replacement-wake.mjs answers a third: "is this harness evidence of world change that may
// wake a replan"). It decides the pause class at the end of a request.
//
// A 'world' refusal the executor cannot fix by changing its own batch. Declared here, once, with the reason; everything else is
// something a fresh executor on a fresh observation can still get right (its own inventory accounting such as supply_missing, a
// placement or source that moved, a stale snapshot), so it gets one correction turn and, if that fails, a restageable pause.
export const EXECUTOR_CANNOT_FIX = Object.freeze({
  PLAN_LEVEL: 'plan_level', // the plan itself is wrong for the game's current state (a locked recipe): a planning decision is needed
  AUTHORITY_GRANT: 'authority_grant', // the grant the work runs under is no longer current: a person or a new grant is needed
  HARNESS_HOLD: 'harness_hold', // an effect that is not proven absent is held: reconciliation owns it, not a new batch
  LIFECYCLE: 'lifecycle', // the actor or surface is not the one the plan assumed: an actor lifecycle event owns it
})
export const EXECUTOR_UNFIXABLE_WORLD_CODES = Object.freeze({
  recipe_locked: EXECUTOR_CANNOT_FIX.PLAN_LEVEL,
  authorization_stale: EXECUTOR_CANNOT_FIX.AUTHORITY_GRANT,
  duplicate_effect_suppressed: EXECUTOR_CANNOT_FIX.HARNESS_HOLD,
  no_actor: EXECUTOR_CANNOT_FIX.LIFECYCLE,
  different_surface: EXECUTOR_CANNOT_FIX.LIFECYCLE,
  bootstrap_dependency_unresolved: EXECUTOR_CANNOT_FIX.LIFECYCLE,
})

export function executorCannotFix(preflight) {
  const code = preflight?.code
  return typeof code === 'string' && Object.hasOwn(EXECUTOR_UNFIXABLE_WORLD_CODES, code) ? EXECUTOR_UNFIXABLE_WORLD_CODES[code] : undefined
}

// The recoveries a request can spend on a refusal, named for the trace.
export const EXECUTOR_RECOVERY = Object.freeze({
  ARGUMENT_RETRY: 'argument_retry',
  SUPPLY_RECOVERY: 'supply_recovery',
  WORLD_CORRECTION: 'world_correction',
})

// The pause class of a request that ends on a refusal. Pure and total: the same inputs always give the same answer and every answer
// names its reason. 'model_recoverable' means a fresh executor can still fix it (the request ends paused, not blocked, and the
// supervisor restages it under its caps); 'guard' means a person or a planning decision is needed and no timer resumes it.
//   preflight      the refusal as the loop saw it (code, refusal_class)
//   recoverySpent  which of EXECUTOR_RECOVERY this request already spent on it
//   worldEvidence  the refusal is harness evidence of world change (replacement-wake.mjs); its MW5 wake was skipped or unavailable
export function classifyBlockedEnd({ preflight, recoverySpent = [], worldEvidence = false } = {}) {
  const { refusal_class: refusalClass, classified } = refusalClassOf(preflight)
  const guard = reason => ({ pause_class: PAUSE_CLASS.GUARD, reason, executor_correctable: false })
  const executor = reason => ({ pause_class: PAUSE_CLASS.MODEL_RECOVERABLE, reason, executor_correctable: true })
  if (!classified) return guard('unclassified_refusal_fails_closed')
  if (refusalClass === REFUSAL_CLASS.AUTHORITY) return guard('authority_refusal_needs_a_person')
  if (refusalClass === REFUSAL_CLASS.PREREQUISITE) return guard('prerequisite_refusal_outside_research_recovery')
  if (worldEvidence) return guard('world_evidence_wake_skipped')
  const unfixable = executorCannotFix(preflight)
  if (unfixable) return guard(`executor_cannot_fix:${unfixable}`)
  if (refusalClass === REFUSAL_CLASS.ARGUMENT) return executor('argument_refusal_after_retry')
  if (recoverySpent.length > 0) return executor(`world_refusal_after_${recoverySpent[0]}`)
  return guard('no_executor_recovery_spent')
}
