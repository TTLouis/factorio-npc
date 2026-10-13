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
