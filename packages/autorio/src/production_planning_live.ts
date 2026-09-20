import type { ControlledActor } from './actors/types'
import { crafting_categories_support_recipe } from './recipe_categories'
import type {
  ProductionEvidenceRef,
  ProductionMachineSelection,
  ProductionMaterialAmount,
  ProductionMaterialType,
  ProductionRecipeModel,
  ProductionSolveFailure,
  ProductionSolveResult,
  ProductionTarget,
} from './production_planning'
import { solve_production } from './production_planning'

export interface LiveProductionMachineSelection {
  recipe_name: string
  machine_name: string
}

export interface LiveProductionSolveRequest {
  calculation_id: string
  target: ProductionTarget
  /** When provided, these recipes define the internal production scope. Materials
   * with no included producer are intentionally treated as external inputs. */
  included_recipe_names?: string[]
  /** Machine choices are explicit. The adapter never silently picks an assembler
   * tier merely because several compatible prototypes exist. */
  machine_selections?: LiveProductionMachineSelection[]
}

const MAX_INCLUDED_RECIPES = 64
const MAX_MACHINE_SELECTIONS = 64
const MAX_DISCOVERED_RECIPES = 128
const MAX_PRODUCERS_PER_MATERIAL = 8
const MAX_NAME_LENGTH = 200
const MAX_RATE = 1000000000

function valid_name(value: string) {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function valid_positive_number(value: number, max: number = MAX_RATE) {
  return typeof value === 'number'
    && value === value
    && value > 0
    && value < math.huge
    && value <= max
}

function fail(calculation_id: string | undefined, message: string, code: 'INVALID_REQUEST' | 'LIMIT_EXCEEDED' = 'INVALID_REQUEST'): ProductionSolveFailure {
  return {
    ok: false,
    calculation_id,
    error: { code, message },
  }
}

function string_in(values: string[], wanted: string) {
  for (const value of values) {
    if (value === wanted) return true
  }
  return false
}

function material_type(value: unknown): ProductionMaterialType | undefined {
  if (value === 'item' || value === 'fluid') return value
  return undefined
}

function material_matches(product: any, material: { type: ProductionMaterialType, name: string }) {
  return product?.type === material.type && product?.name === material.name
}

function sort_recipes(values: any[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j].name < values[i].name) {
        const swap = values[i]
        values[i] = values[j]
        values[j] = swap
      }
    }
  }
}

function recipe_available(recipe: any) {
  return recipe !== undefined && recipe.enabled === true && recipe.hidden !== true
}

function enabled_producers(actor: ControlledActor, material: { type: ProductionMaterialType, name: string }) {
  const candidates: any[] = []
  for (const [, recipe] of pairs(actor.force.recipes)) {
    if (!recipe_available(recipe)) continue
    for (const product of recipe.products ?? []) {
      if (material_matches(product, material)) {
        candidates.push(recipe)
        break
      }
    }
  }
  sort_recipes(candidates)
  return candidates
}

function machine_selection_for(selections: LiveProductionMachineSelection[], recipe_name: string) {
  for (const selection of selections) {
    if (selection.recipe_name === recipe_name) return selection
  }
  return undefined
}

function machine_supports_recipe(machine: any, recipe: any) {
  return crafting_categories_support_recipe(machine?.crafting_categories, recipe)
}

function fixed_amount_or_placeholder(product: any) {
  if (valid_positive_number(product?.amount)) return product.amount as number
  if (valid_positive_number(product?.amount_min)) return product.amount_min as number
  if (valid_positive_number(product?.amount_max)) return product.amount_max as number
  return 1
}

function product_is_probabilistic(product: any) {
  if (product?.amount === undefined) return true
  if (product.amount_min !== undefined || product.amount_max !== undefined) return true
  if (product.probability !== undefined && product.probability !== 1) return true
  if (product.independent_probability === true) return true
  return false
}

function normalize_material(value: any): ProductionMaterialAmount | undefined {
  const type = material_type(value?.type)
  if (!type || !valid_name(value?.name) || !valid_positive_number(value?.amount)) return undefined
  return { type, name: value.name, amount: value.amount }
}

export function solve_live_production(actor: ControlledActor, request: LiveProductionSolveRequest): ProductionSolveResult {
  if (!actor || !actor.is_valid) return fail(request?.calculation_id, 'controlled actor is unavailable')
  if (!request || !valid_name(request.calculation_id)) return fail(undefined, 'calculation_id must be a non-empty bounded string')
  if (!request.target || (request.target.type !== 'item' && request.target.type !== 'fluid') || !valid_name(request.target.name) || !valid_positive_number(request.target.rate_per_second)) {
    return fail(request.calculation_id, 'target must have item/fluid type, bounded name, and positive rate_per_second')
  }

  const included = request.included_recipe_names
  if (included !== undefined) {
    if (!Array.isArray(included)) return fail(request.calculation_id, 'included_recipe_names must be an array')
    if (included.length > MAX_INCLUDED_RECIPES) return fail(request.calculation_id, `included_recipe_names exceeds ${MAX_INCLUDED_RECIPES}`, 'LIMIT_EXCEEDED')
  }
  const selections = request.machine_selections ?? []
  if (!Array.isArray(selections)) return fail(request.calculation_id, 'machine_selections must be an array')
  if (selections.length > MAX_MACHINE_SELECTIONS) return fail(request.calculation_id, `machine_selections exceeds ${MAX_MACHINE_SELECTIONS}`, 'LIMIT_EXCEEDED')

  const included_seen: string[] = []
  for (const name of included ?? []) {
    if (!valid_name(name)) return fail(request.calculation_id, 'included recipe names must be bounded non-empty strings')
    if (string_in(included_seen, name)) return fail(request.calculation_id, `duplicate included recipe: ${name}`)
    included_seen.push(name)
  }
  const selection_seen: string[] = []
  for (const selection of selections) {
    if (!selection || !valid_name(selection.recipe_name) || !valid_name(selection.machine_name)) {
      return fail(request.calculation_id, 'machine selections require bounded recipe_name and machine_name')
    }
    if (string_in(selection_seen, selection.recipe_name)) return fail(request.calculation_id, `duplicate machine selection for ${selection.recipe_name}`)
    selection_seen.push(selection.recipe_name)
  }

  const evidence: ProductionEvidenceRef[] = []
  const normalized: ProductionRecipeModel[] = []
  let adapter_failure: ProductionSolveFailure | undefined

  function add_evidence(id: string, source: 'engine_read') {
    for (const existing of evidence) {
      if (existing.id === id) return
    }
    evidence.push({ id, source })
  }

  function normalize_recipe(recipe: any) {
    if (adapter_failure) return
    for (const existing of normalized) {
      if (existing.recipe_name === recipe.name) return
    }
    if (normalized.length >= MAX_DISCOVERED_RECIPES) {
      adapter_failure = fail(request.calculation_id, `discovered recipes exceeds ${MAX_DISCOVERED_RECIPES}`, 'LIMIT_EXCEEDED')
      return
    }
    if (!recipe_available(recipe)) {
      adapter_failure = fail(request.calculation_id, `recipe is unavailable or hidden: ${recipe?.name ?? 'unknown'}`)
      return
    }
    if (!valid_positive_number(recipe.energy)) {
      adapter_failure = fail(request.calculation_id, `recipe has invalid energy: ${recipe.name}`)
      return
    }

    const ingredients: ProductionMaterialAmount[] = []
    for (const ingredient of recipe.ingredients ?? []) {
      const normalized_ingredient = normalize_material(ingredient)
      if (!normalized_ingredient) {
        adapter_failure = fail(request.calculation_id, `recipe has unsupported ingredient shape: ${recipe.name}`)
        return
      }
      ingredients.push(normalized_ingredient)
    }

    const products: ProductionMaterialAmount[] = []
    let probabilistic = false
    for (const product of recipe.products ?? []) {
      const type = material_type(product?.type)
      if (!type || !valid_name(product?.name)) {
        adapter_failure = fail(request.calculation_id, `recipe has unsupported product shape: ${recipe.name}`)
        return
      }
      if (product_is_probabilistic(product)) probabilistic = true
      products.push({ type, name: product.name, amount: fixed_amount_or_placeholder(product) })
    }
    if (products.length === 0) {
      adapter_failure = fail(request.calculation_id, `recipe has no products: ${recipe.name}`)
      return
    }

    const recipe_evidence = `engine:recipe:${recipe.name}`
    add_evidence(recipe_evidence, 'engine_read')
    let machine: ProductionMachineSelection | undefined
    const selection = machine_selection_for(selections, recipe.name)
    if (selection) {
      const prototype = (prototypes.entity as any)[selection.machine_name]
      if (!prototype || !valid_positive_number(prototype.crafting_speed)) {
        adapter_failure = fail(request.calculation_id, `machine prototype is missing or has no crafting speed: ${selection.machine_name}`)
        return
      }
      if (!machine_supports_recipe(prototype, recipe)) {
        adapter_failure = fail(request.calculation_id, `machine ${selection.machine_name} is incompatible with recipe ${recipe.name}`)
        return
      }
      const machine_evidence = `engine:prototype:${selection.machine_name}`
      add_evidence(machine_evidence, 'engine_read')
      machine = {
        name: selection.machine_name,
        crafting_speed: prototype.crafting_speed,
        evidence_ids: [machine_evidence],
      }
    }

    normalized.push({
      recipe_name: recipe.name,
      energy_seconds: recipe.energy,
      ingredients,
      products,
      machine,
      evidence_ids: [recipe_evidence],
      probabilistic,
    })
  }

  if (included !== undefined) {
    for (const recipe_name of included) {
      const recipe = actor.force.recipes[recipe_name]
      if (!recipe_available(recipe)) return fail(request.calculation_id, `included recipe is unavailable or hidden: ${recipe_name}`)
      normalize_recipe(recipe)
      if (adapter_failure) return adapter_failure
    }
  }
  else {
    const seen_materials: string[] = []
    function discover(material: { type: ProductionMaterialType, name: string }) {
      if (adapter_failure) return
      const key = `${material.type}:${material.name}`
      if (string_in(seen_materials, key)) return
      seen_materials.push(key)
      const candidates = enabled_producers(actor, material)
      if (candidates.length > MAX_PRODUCERS_PER_MATERIAL) {
        adapter_failure = fail(request.calculation_id, `producer count for ${key} exceeds ${MAX_PRODUCERS_PER_MATERIAL}`, 'LIMIT_EXCEEDED')
        return
      }
      if (candidates.length === 0) return
      for (const candidate of candidates) {
        normalize_recipe(candidate)
        if (adapter_failure) return
      }
      if (candidates.length !== 1) return
      for (const ingredient of candidates[0].ingredients ?? []) {
        const type = material_type(ingredient?.type)
        if (!type || !valid_name(ingredient?.name)) {
          adapter_failure = fail(request.calculation_id, `recipe has unsupported ingredient identity: ${candidates[0].name}`)
          return
        }
        discover({ type, name: ingredient.name })
        if (adapter_failure) return
      }
    }
    discover(request.target)
    if (adapter_failure) return adapter_failure
  }

  for (const selection of selections) {
    let matched = false
    for (const recipe of normalized) {
      if (recipe.recipe_name === selection.recipe_name) {
        matched = true
        break
      }
    }
    if (!matched) return fail(request.calculation_id, `machine selection does not belong to the active production scope: ${selection.recipe_name}`)
  }

  return solve_production({
    calculation_id: request.calculation_id,
    target: request.target,
    recipes: normalized,
    evidence,
  })
}
