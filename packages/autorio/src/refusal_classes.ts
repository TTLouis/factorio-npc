// The one place that says what KIND of refusal each `autorio_preflight.operation` code is.
//
// The harness (deploy/pterodactyl/runtime-v8/npc-agent-loop.mjs) never looks a preflight code up in its own list to pick a
// recovery path. It reads `refusal_class` off the refusal, which `autorio_preflight.operation` attaches to every ok:false
// result (see `with_refusal_class`, called once from control.ts). Whoever adds a refusal code adds it here; the completeness
// test in refusal_classes.test.ts fails when a producer and this table disagree.
//
// A class names the recovery path the harness takes, not a taxonomy of causes:
//   argument      The model named or shaped something wrongly (prototype, recipe, identity, radius, position, count, stale
//                 candidate). One bounded correction turn, committed plan unchanged.
//   authority     A protected, reserved or player-owned target. Admission refusals of this class are produced by the
//                 harness itself (authorization.mjs); the mod's preflight has none today.
//   prerequisite  A research precondition the NPC can satisfy first (queue prerequisites, wait for the busy queue). Bounded
//                 research recovery inside the same step.
//   world         Everything else: the current world, the actor or a harness-owned condition blocks the operation, or a
//                 dedicated code-keyed recovery exists and, once spent, ends in the blocker path. The request ends as
//                 blocked_preflight. This is also the fail-closed class for a refusal that carries no class.
//
// Codes that have a dedicated recovery in the harness (stale_exact_target, supply_missing, extraction_empty,
// destination_full, requires_machine, bootstrap_dependency_unresolved, recipe_locked, placement_item_missing) are `world`:
// their dedicated handler runs first, and `world` is where they land when its budget is spent.
//
// Keep this file's shape simple (one `code: 'class'` entry per line): the runtime-v8 tests read it as text to prove the mod
// and the harness agree on the closed set of classes.

export const REFUSAL_CLASSES = ['argument', 'authority', 'prerequisite', 'world'] as const
export type RefusalClass = (typeof REFUSAL_CLASSES)[number]

export const refusal_class_by_code: Record<string, RefusalClass> = {
  // --- argument: the model's own naming or arguments ---------------------------------------------------------------
  unknown_prototype: 'argument',
  unknown_recipe: 'argument',
  invalid_unit_number: 'argument',
  invalid_target_kind: 'argument',
  invalid_preflight_args: 'argument',
  not_recipe_machine: 'argument',
  navigation_position_inside_furnace_collision: 'argument',
  invalid_navigation_position: 'argument',
  invalid_navigation_reach_distance: 'argument',
  invalid_navigation_search_radius: 'argument',
  invalid_harvest_search_radius: 'argument',
  invalid_resource_count: 'argument',
  invalid_resource_position: 'argument',
  invalid_resource_search_radius: 'argument',
  placement_candidate_unavailable: 'argument',
  no_natural_harvest_source: 'argument',
  // A wrong technology name is the same kind of naming error as an unknown recipe or prototype.
  invalid_name: 'argument',
  unknown_technology: 'argument',

  // --- prerequisite: research preconditions ------------------------------------------------------------------------
  missing_prerequisites: 'prerequisite',
  trigger_research: 'prerequisite',
  force_busy: 'prerequisite',

  // --- world: the world, the actor or a dedicated recovery decides ---------------------------------------------------
  no_actor: 'world',
  no_inventory: 'world',
  player_unavailable: 'world',
  different_surface: 'world',
  stale_exact_target: 'world',
  resource_source_not_found: 'world',
  resource_source_insufficient: 'world',
  navigation_target_not_found: 'world',
  natural_harvest_source_not_found: 'world',
  supply_missing: 'world',
  extraction_empty: 'world',
  destination_full: 'world',
  supply_destination_conflict: 'world',
  requires_machine: 'world',
  recipe_locked: 'world',
  bootstrap_dependency_unresolved: 'world',
  placement_item_missing: 'world',
  placement_item_unreadable: 'world',
  unknown_entity: 'world',
  not_item_placeable: 'world',
  ambiguous_placement_item: 'world',
  invalid_placement_item: 'world',
  technology_disabled: 'world',
  research_disabled: 'world',
}

export function refusal_class_of(code: unknown): RefusalClass | undefined {
  if (typeof code !== 'string') return undefined
  return refusal_class_by_code[code]
}

// Attach `refusal_class` to a failed preflight result. An accepted result, or a code with no entry, is returned untouched: a
// missing class is what the harness treats as unclassified (fail closed to `world`, with a trace), so it is never invented.
export function with_refusal_class<T extends Record<string, any>>(result: T): T {
  if (!result || result.ok !== false || result.refusal_class !== undefined) return result
  const refusal_class = refusal_class_of(result.code)
  if (refusal_class === undefined) return result
  return { ...result, refusal_class }
}
