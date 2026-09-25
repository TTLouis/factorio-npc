import type { ControlledActor } from './actors/types'
import type { ProductionMaterialType } from './production_planning'

export interface ProductionScopeTarget {
  type: ProductionMaterialType
  name: string
}

export interface ProductionScopeRequest {
  calculation_id: string
  target: ProductionScopeTarget
  max_depth?: number
  max_materials?: number
}

interface ObservedFlowWindow {
  window: '1m' | '10m'
  production_per_second: number
  consumption_per_second: number
  net_per_second: number
}

interface ProductionScopeMaterial {
  type: ProductionMaterialType
  name: string
  role: 'target' | 'upstream'
  depth: number
  observed: ObservedFlowWindow[]
}

export type ProductionScopeResult =
  | {
      ok: true
      calculation_id: string
      target: ProductionScopeTarget
      force: { index: number, name?: string }
      surface: { index: number, name?: string }
      materials: ProductionScopeMaterial[]
      coverage: {
        max_depth: number
        max_materials: number
        complete: boolean
        truncation_reasons: string[]
      }
      semantics: {
        production: string
        consumption: string
        net: string
        decision: string
      }
      evidence_ids: string[]
    }
  | {
      ok: false
      calculation_id?: string
      error: {
        code: 'INVALID_REQUEST' | 'LIMIT_EXCEEDED'
        message: string
      }
    }

const DEFAULT_MAX_DEPTH = 3
const MAX_DEPTH = 6
const DEFAULT_MAX_MATERIALS = 16
const MAX_MATERIALS = 32
const MAX_PRODUCERS_PER_MATERIAL = 8
const MAX_NAME_LENGTH = 200

function valid_name(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_NAME_LENGTH
}

function valid_bounded_integer(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

function fail(calculation_id: string | undefined, message: string, code: 'INVALID_REQUEST' | 'LIMIT_EXCEEDED' = 'INVALID_REQUEST'): ProductionScopeResult {
  return { ok: false, calculation_id, error: { code, message } }
}

function material_type(value: unknown): ProductionMaterialType | undefined {
  if (value === 'item' || value === 'fluid') return value
  return undefined
}

function recipe_available(recipe: any) {
  return recipe !== undefined && recipe.enabled === true && recipe.hidden !== true
}

function material_matches(product: any, material: ProductionScopeTarget) {
  return product?.type === material.type && product?.name === material.name
}

function sort_recipes(values: any[]) {
  values.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

function enabled_producers(actor: ControlledActor, material: ProductionScopeTarget) {
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

function flow_statistics(actor: ControlledActor, type: ProductionMaterialType) {
  return type === 'item'
    ? actor.force.get_item_production_statistics(actor.surface)
    : actor.force.get_fluid_production_statistics(actor.surface)
}

function observed_window(actor: ControlledActor, material: ProductionScopeTarget, window: '1m' | '10m'): ObservedFlowWindow {
  const stats = flow_statistics(actor, material.type)
  const precision = window === '1m' ? defines.flow_precision_index.one_minute : defines.flow_precision_index.ten_minutes
  const production_per_minute = stats.get_flow_count({ name: material.name, category: 'input', precision_index: precision })
  const consumption_per_minute = stats.get_flow_count({ name: material.name, category: 'output', precision_index: precision })
  const production_per_second = production_per_minute / 60
  const consumption_per_second = consumption_per_minute / 60
  return {
    window,
    production_per_second,
    consumption_per_second,
    net_per_second: production_per_second - consumption_per_second,
  }
}

function sort_materials(values: Array<{ type: ProductionMaterialType, name: string, depth: number }>) {
  values.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth
    if (a.type !== b.type) return a.type < b.type ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
}

export function production_scope_context(actor: ControlledActor, request: ProductionScopeRequest): ProductionScopeResult {
  if (!actor || !actor.is_valid) return fail(request?.calculation_id, 'controlled actor is unavailable')
  if (!request || !valid_name(request.calculation_id)) return fail(undefined, 'calculation_id must be a non-empty bounded string')
  if (!request.target || (request.target.type !== 'item' && request.target.type !== 'fluid') || !valid_name(request.target.name)) {
    return fail(request.calculation_id, 'target must have item/fluid type and bounded name')
  }

  const max_depth = request.max_depth ?? DEFAULT_MAX_DEPTH
  const max_materials = request.max_materials ?? DEFAULT_MAX_MATERIALS
  if (!valid_bounded_integer(max_depth, 0, MAX_DEPTH)) return fail(request.calculation_id, `max_depth must be an integer from 0 to ${MAX_DEPTH}`)
  if (!valid_bounded_integer(max_materials, 1, MAX_MATERIALS)) return fail(request.calculation_id, `max_materials must be an integer from 1 to ${MAX_MATERIALS}`)

  const discovered: Array<{ type: ProductionMaterialType, name: string, depth: number }> = []
  const seen: Record<string, true> = {}
  const queue: Array<{ material: ProductionScopeTarget, depth: number }> = [{ material: request.target, depth: 0 }]
  const truncation_reasons: string[] = []

  function add_truncation(reason: string) {
    for (const existing of truncation_reasons) if (existing === reason) return
    truncation_reasons.push(reason)
  }

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    const material = next.material
    const depth = next.depth
    const key = `${material.type}:${material.name}`
    if (seen[key]) continue
    if (discovered.length >= max_materials) {
      add_truncation(`material limit ${max_materials} reached`)
      break
    }
    seen[key] = true
    discovered.push({ type: material.type, name: material.name, depth })

    const producers = enabled_producers(actor, material)
    if (producers.length > MAX_PRODUCERS_PER_MATERIAL) {
      add_truncation(`producer limit ${MAX_PRODUCERS_PER_MATERIAL} exceeded for ${key}`)
      continue
    }
    if (depth >= max_depth) {
      let has_upstream = false
      for (const recipe of producers) {
        // Typed so TypeScriptToLua emits `#`; `.length` on an untyped Lua table is nil.
        const ingredients: unknown[] = recipe.ingredients ?? []
        if (ingredients.length > 0) has_upstream = true
      }
      if (has_upstream) add_truncation(`depth limit ${max_depth} reached`)
      continue
    }
    for (const recipe of producers) {
      for (const ingredient of recipe.ingredients ?? []) {
        const type = material_type(ingredient?.type)
        if (!type || !valid_name(ingredient?.name)) continue
        queue.push({ material: { type, name: ingredient.name }, depth: depth + 1 })
      }
    }
  }

  sort_materials(discovered)

  const materials: ProductionScopeMaterial[] = []
  const evidence_ids: string[] = []
  for (const material of discovered) {
    const evidence_id = `engine:production-statistics:${actor.force.index}:${actor.surface.index}:${material.type}:${material.name}`
    materials.push({
      type: material.type,
      name: material.name,
      role: material.depth === 0 ? 'target' : 'upstream',
      depth: material.depth,
      observed: [
        observed_window(actor, material, '1m'),
        observed_window(actor, material, '10m'),
      ],
    })
    evidence_ids.push(evidence_id)
  }

  return {
    ok: true,
    calculation_id: request.calculation_id,
    target: request.target,
    force: { index: actor.force.index, name: (actor.force as any).name },
    surface: { index: actor.surface.index, name: actor.surface.name },
    materials,
    coverage: {
      max_depth,
      max_materials,
      complete: truncation_reasons.length === 0,
      truncation_reasons,
    },
    semantics: {
      production: 'observed production flow on the current force and surface; rates are per second and are not theoretical capacity',
      consumption: 'observed consumption flow on the current force and surface; rates are per second',
      net: 'production minus consumption within each statistics window; this is not guaranteed spare sustainable capacity',
      decision: 'facts only; the model must choose the intended production scope before calling solveProduction',
    },
    evidence_ids,
  }
}
