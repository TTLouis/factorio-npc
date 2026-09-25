import type { ControlledActor } from './actors/types'
import type { ProductionMaterialType, ProductionSolveFailure, ProductionSolveSuccess, ProductionTarget } from './production_planning'
import type { ProductionTopologyContext } from './production_topology'
import type { LiveProductionSolveRequest } from './production_planning_live'
import { solve_live_production } from './production_planning_live'
import { production_topology_context } from './production_topology'

export interface ProductionRouteChoice {
  material: { type: ProductionMaterialType, name: string }
  recipe_name: string
}
export interface ProductionSolvedRoute extends ProductionSolveSuccess {
  topology: ProductionTopologyContext
}
export interface ProductionRouteCandidate {
  candidate_id: string
  route_recipe_names: string[]
  route_choices: ProductionRouteChoice[]
  solution: ProductionSolvedRoute
}
export interface ProductionCandidateSolveSuccess {
  ok: true
  calculation_id: string
  target: ProductionTarget
  candidate_count: number
  candidates: ProductionRouteCandidate[]
}
export type LiveProductionCandidateSolveResult = ProductionSolveFailure | ProductionSolvedRoute | ProductionCandidateSolveSuccess

const MAX_CANDIDATES = 5
const MAX_EXPLORED = 16
const MAX_DEPTH = 64
const MAX_PRODUCERS = 8

type Material = { type: ProductionMaterialType, name: string }
type Choice = ProductionRouteChoice & { key: string, ambiguous: boolean }
type Plan = { recipes: string[], choices: Choice[] }
type Enumeration = { plans?: Plan[], failure?: ProductionSolveFailure }

function key(material: Material) { return `${material.type}:${material.name}` }
function has(values: string[], wanted: string) { for (const value of values) if (value === wanted) return true; return false }
function sortStrings(values: string[]) {
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) if (values[j] < values[i]) { const v = values[i]; values[i] = values[j]; values[j] = v }
}
function sortRecipes(values: any[]) {
  for (let i = 0; i < values.length; i++) for (let j = i + 1; j < values.length; j++) if (values[j].name < values[i].name) { const v = values[i]; values[i] = values[j]; values[j] = v }
}
function producers(actor: ControlledActor, material: Material) {
  const result: any[] = []
  for (const [, recipe] of pairs(actor.force.recipes)) {
    if (!recipe || recipe.enabled !== true || recipe.hidden === true) continue
    for (const product of recipe.products ?? []) if (product?.type === material.type && product?.name === material.name) { result.push(recipe); break }
  }
  sortRecipes(result)
  return result
}
function fail(calculation_id: string, code: 'LIMIT_EXCEEDED' | 'INVALID_REQUEST' | 'RECIPE_CYCLE', message: string, material?: Material): ProductionSolveFailure {
  return { ok: false, calculation_id, error: { code, message, material } }
}
function signature(plan: Plan) {
  const choices: string[] = []
  for (const choice of plan.choices) choices.push(`${choice.key}=${choice.recipe_name}`)
  sortStrings(choices)
  return `${plan.recipes.join(',')}|${choices.join(',')}`
}
function addUnique(plans: Plan[], candidate: Plan) {
  const wanted = signature(candidate)
  for (const plan of plans) if (signature(plan) === wanted) return true
  plans.push(candidate)
  return plans.length <= MAX_EXPLORED
}
function merge(left: Plan, right: Plan): Plan | undefined {
  const recipes = left.recipes.slice()
  for (const name of right.recipes) if (!has(recipes, name)) recipes.push(name)
  sortStrings(recipes)
  const choices = left.choices.slice()
  for (const choice of right.choices) {
    let existing: Choice | undefined
    for (const item of choices) if (item.key === choice.key) { existing = item; break }
    if (existing && existing.recipe_name !== choice.recipe_name) return undefined
    if (!existing) choices.push(choice)
  }
  return { recipes, choices }
}
function materialType(value: unknown): ProductionMaterialType | undefined { return value === 'item' || value === 'fluid' ? value : undefined }
function with_topology(solution: ProductionSolveSuccess): ProductionSolvedRoute {
  return { ...solution, topology: production_topology_context(solution) }
}

function enumerate(actor: ControlledActor, material: Material, calculation_id: string, stack: string[]): Enumeration {
  if (stack.length > MAX_DEPTH) return { failure: fail(calculation_id, 'LIMIT_EXCEEDED', `production graph exceeds depth ${MAX_DEPTH}`) }
  const materialKey = key(material)
  if (has(stack, materialKey)) return { failure: fail(calculation_id, 'RECIPE_CYCLE', `recipe cycle detected at ${materialKey}`, material) }
  const options = producers(actor, material)
  if (options.length > MAX_PRODUCERS) return { failure: fail(calculation_id, 'LIMIT_EXCEEDED', `producer count for ${materialKey} exceeds ${MAX_PRODUCERS}`) }
  if (options.length === 0) return { plans: [{ recipes: [], choices: [] }] }

  const nextStack = stack.slice(); nextStack.push(materialKey)
  const result: Plan[] = []
  for (const recipe of options) {
    let partials: Plan[] = [{ recipes: [recipe.name], choices: [{ key: materialKey, material, recipe_name: recipe.name, ambiguous: options.length > 1 }] }]
    for (const ingredient of recipe.ingredients ?? []) {
      const type = materialType(ingredient?.type)
      if (!type || typeof ingredient?.name !== 'string' || ingredient.name === '') return { failure: fail(calculation_id, 'INVALID_REQUEST', `recipe has unsupported ingredient identity: ${recipe.name}`) }
      const child = enumerate(actor, { type, name: ingredient.name }, calculation_id, nextStack)
      if (child.failure) return child
      const merged: Plan[] = []
      for (const partial of partials) for (const childPlan of child.plans ?? []) {
        const combined = merge(partial, childPlan)
        if (combined && !addUnique(merged, combined)) return { failure: fail(calculation_id, 'LIMIT_EXCEEDED', `production route exploration exceeds ${MAX_EXPLORED}; provide included_recipe_names to narrow the production scope`) }
      }
      partials = merged
    }
    for (const partial of partials) if (!addUnique(result, partial)) return { failure: fail(calculation_id, 'LIMIT_EXCEEDED', `production route exploration exceeds ${MAX_EXPLORED}; provide included_recipe_names to narrow the production scope`) }
  }
  return { plans: result }
}

function routeHas(route: Plan, recipe: string) { return has(route.recipes, recipe) }
function publicChoices(route: Plan) {
  const result: ProductionRouteChoice[] = []
  for (const choice of route.choices) if (choice.ambiguous) result.push({ material: choice.material, recipe_name: choice.recipe_name })
  return result
}

export function solve_live_production_candidates(actor: ControlledActor, request: LiveProductionSolveRequest): LiveProductionCandidateSolveResult {
  if (request?.included_recipe_names !== undefined) {
    const solved = solve_live_production(actor, request)
    return solved.ok ? with_topology(solved) : solved
  }
  const probe = solve_live_production(actor, { calculation_id: request.calculation_id, target: request.target })
  if (probe.ok || probe.error.code !== 'AMBIGUOUS_RECIPE') {
    if (!probe.ok) return probe
    const solved = solve_live_production(actor, request)
    return solved.ok ? with_topology(solved) : solved
  }

  const found = enumerate(actor, request.target, request.calculation_id, [])
  if (found.failure) return found.failure
  const routes = found.plans ?? []
  if (routes.length > MAX_CANDIDATES) return fail(request.calculation_id, 'LIMIT_EXCEEDED', `production route candidates exceed ${MAX_CANDIDATES}; provide included_recipe_names to narrow the production scope`)
  for (const selection of request.machine_selections ?? []) {
    let matched = false
    for (const route of routes) if (routeHas(route, selection.recipe_name)) { matched = true; break }
    if (!matched) return fail(request.calculation_id, 'INVALID_REQUEST', `machine selection does not belong to the active production scope: ${selection.recipe_name}`)
  }

  const candidates: ProductionRouteCandidate[] = []
  for (const route of routes) {
    const machine_selections = request.machine_selections?.filter(selection => routeHas(route, selection.recipe_name))
    const solved = solve_live_production(actor, { calculation_id: request.calculation_id, target: request.target, included_recipe_names: route.recipes, machine_selections })
    if (!solved.ok) return solved
    candidates.push({ candidate_id: `route-${candidates.length + 1}`, route_recipe_names: route.recipes, route_choices: publicChoices(route), solution: with_topology(solved) })
  }
  if (candidates.length === 0) return probe
  if (candidates.length === 1) return candidates[0].solution
  return { ok: true, calculation_id: request.calculation_id, target: request.target, candidate_count: candidates.length, candidates }
}
