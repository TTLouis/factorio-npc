import type {
  ProductionMaterialType,
  ProductionSolveSuccess,
} from './production_planning'

export type ProductionTopologyCandidateKind
  = | 'belt-fed'
    | 'direct-insertion'
    | 'shared-intermediate'
    | 'pipe-fed'
    | 'self-contained'

export type ProductionTopologyValidation
  = | 'belt_capacity'
    | 'inserter_throughput'
    | 'adjacency'
    | 'fluid_throughput'
    | 'external_item_transport'

export interface ProductionTopologyMaterialRef {
  type: ProductionMaterialType
  name: string
}

export interface ProductionInternalTransfer {
  material: ProductionTopologyMaterialRef
  from_recipe: string
  to_recipes: string[]
  rate_per_second: number
}

export interface ProductionTopologyMachineGroup {
  recipe_name: string
  machine_name: string
  machine_count: number
}

export interface ProductionTopologyLayoutReadiness {
  ready: boolean
  missing_machine_selections: string[]
  machine_groups: ProductionTopologyMachineGroup[]
  semantics: string
}

export interface ProductionTopologyCandidate {
  candidate_id: string
  kind: ProductionTopologyCandidateKind
  internal_item_strategy: 'belt' | 'direct_insertion' | 'shared_distribution' | 'none'
  external_item_strategy: 'belt' | 'unresolved' | 'none'
  fluid_strategy: 'pipe' | 'none'
  shared_materials?: ProductionTopologyMaterialRef[]
  requires_validation: ProductionTopologyValidation[]
}

export interface ProductionTopologyContext {
  internal_transfers: ProductionInternalTransfer[]
  external_requirements: {
    item_input_count: number
    fluid_input_count: number
  }
  layout_readiness: ProductionTopologyLayoutReadiness
  candidate_ordering: 'canonical_not_ranked'
  candidates: ProductionTopologyCandidate[]
  semantics: {
    selection: string
    validation: string
  }
}

function same_material(
  left: { type: ProductionMaterialType, name: string },
  right: { type: ProductionMaterialType, name: string },
) {
  return left.type === right.type && left.name === right.name
}

function string_in(values: string[], wanted: string) {
  for (const value of values) if (value === wanted) return true
  return false
}

function push_unique(values: string[], value: string) {
  if (!string_in(values, value)) values.push(value)
}

function sort_strings(values: string[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      if (values[j] < values[i]) {
        const previous = values[i]
        values[i] = values[j]
        values[j] = previous
      }
    }
  }
}

function sort_transfers(values: ProductionInternalTransfer[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const left = `${values[i].material.type}:${values[i].material.name}:${values[i].from_recipe}`
      const right = `${values[j].material.type}:${values[j].material.name}:${values[j].from_recipe}`
      if (right < left) {
        const previous = values[i]
        values[i] = values[j]
        values[j] = previous
      }
    }
  }
}

function sort_machine_groups(values: ProductionTopologyMachineGroup[]) {
  for (let i = 0; i < values.length; i++) {
    for (let j = i + 1; j < values.length; j++) {
      const left = `${values[i].recipe_name}:${values[i].machine_name}`
      const right = `${values[j].recipe_name}:${values[j].machine_name}`
      if (right < left) {
        const previous = values[i]
        values[i] = values[j]
        values[j] = previous
      }
    }
  }
}

function layout_readiness(solution: ProductionSolveSuccess): ProductionTopologyLayoutReadiness {
  const missing_machine_selections: string[] = []
  const machine_groups: ProductionTopologyMachineGroup[] = []
  for (const recipe of solution.recipe_rates) {
    if (!recipe.machine) {
      missing_machine_selections.push(recipe.recipe_name)
      continue
    }
    machine_groups.push({
      recipe_name: recipe.recipe_name,
      machine_name: recipe.machine.name,
      machine_count: recipe.machine.machine_count,
    })
  }
  sort_strings(missing_machine_selections)
  sort_machine_groups(machine_groups)
  const ready = solution.fully_sized === true && missing_machine_selections.length === 0
  return {
    ready,
    missing_machine_selections,
    machine_groups: ready ? machine_groups : [],
    semantics: ready
      ? 'all recipe machine prototypes and counts are explicitly sized; spatial planning may use these machine groups but must still validate footprints, topology constraints, transport and live placement'
      : 'spatial planning is not ready; choose explicit machine_selections for every listed recipe and re-run solveProduction before generating a production layout',
  }
}

function add_validation(values: ProductionTopologyValidation[], value: ProductionTopologyValidation) {
  for (const existing of values) if (existing === value) return
  values.push(value)
}

function belt_validations(has_fluid_transport: boolean) {
  const values: ProductionTopologyValidation[] = ['belt_capacity', 'inserter_throughput']
  if (has_fluid_transport) values.push('fluid_throughput')
  return values
}

function internal_transfers(solution: ProductionSolveSuccess) {
  const transfers: ProductionInternalTransfer[] = []

  for (const consumer of solution.recipe_rates) {
    for (const ingredient of consumer.ingredient_rates) {
      let producer_recipe: string | undefined
      for (const producer of solution.recipe_rates) {
        if (same_material(producer.product, ingredient)) {
          producer_recipe = producer.recipe_name
          break
        }
      }
      if (producer_recipe === undefined || producer_recipe === consumer.recipe_name) continue

      let existing: ProductionInternalTransfer | undefined
      for (const transfer of transfers) {
        if (transfer.from_recipe === producer_recipe && same_material(transfer.material, ingredient)) {
          existing = transfer
          break
        }
      }
      if (!existing) {
        existing = {
          material: { type: ingredient.type, name: ingredient.name },
          from_recipe: producer_recipe,
          to_recipes: [],
          rate_per_second: 0,
        }
        transfers.push(existing)
      }
      push_unique(existing.to_recipes, consumer.recipe_name)
      existing.rate_per_second += ingredient.rate_per_second
    }
  }

  for (const transfer of transfers) sort_strings(transfer.to_recipes)
  sort_transfers(transfers)
  return transfers
}

export function production_topology_context(solution: ProductionSolveSuccess): ProductionTopologyContext {
  const transfers = internal_transfers(solution)
  const internal_item: ProductionInternalTransfer[] = []
  const shared_item: ProductionInternalTransfer[] = []
  let has_internal_fluid = false
  for (const transfer of transfers) {
    if (transfer.material.type === 'item') {
      internal_item.push(transfer)
      if (transfer.to_recipes.length > 1) shared_item.push(transfer)
    }
    else {
      has_internal_fluid = true
    }
  }

  let external_item_count = 0
  let external_fluid_count = 0
  for (const input of solution.external_inputs) {
    if (input.type === 'item') external_item_count++
    else external_fluid_count++
  }

  const has_item_transport = internal_item.length > 0 || external_item_count > 0
  const has_fluid_transport = has_internal_fluid || external_fluid_count > 0
  const candidates: ProductionTopologyCandidate[] = []

  if (has_item_transport) {
    candidates.push({
      candidate_id: 'topology-belt-fed',
      kind: 'belt-fed',
      internal_item_strategy: internal_item.length > 0 ? 'belt' : 'none',
      external_item_strategy: external_item_count > 0 ? 'belt' : 'none',
      fluid_strategy: has_fluid_transport ? 'pipe' : 'none',
      requires_validation: belt_validations(has_fluid_transport),
    })
  }

  let direct_eligible = internal_item.length > 0
  for (const transfer of internal_item) {
    if (transfer.to_recipes.length !== 1) direct_eligible = false
  }
  if (direct_eligible) {
    const validations: ProductionTopologyValidation[] = ['inserter_throughput', 'adjacency']
    if (external_item_count > 0) add_validation(validations, 'external_item_transport')
    if (has_fluid_transport) add_validation(validations, 'fluid_throughput')
    candidates.push({
      candidate_id: 'topology-direct-insertion',
      kind: 'direct-insertion',
      internal_item_strategy: 'direct_insertion',
      external_item_strategy: external_item_count > 0 ? 'unresolved' : 'none',
      fluid_strategy: has_fluid_transport ? 'pipe' : 'none',
      requires_validation: validations,
    })
  }

  if (shared_item.length > 0) {
    const shared_materials: ProductionTopologyMaterialRef[] = []
    for (const transfer of shared_item) shared_materials.push({ type: transfer.material.type, name: transfer.material.name })
    const validations = belt_validations(has_fluid_transport)
    if (external_item_count > 0) add_validation(validations, 'external_item_transport')
    candidates.push({
      candidate_id: 'topology-shared-intermediate',
      kind: 'shared-intermediate',
      internal_item_strategy: 'shared_distribution',
      external_item_strategy: external_item_count > 0 ? 'unresolved' : 'none',
      fluid_strategy: has_fluid_transport ? 'pipe' : 'none',
      shared_materials,
      requires_validation: validations,
    })
  }

  if (!has_item_transport && has_fluid_transport) {
    candidates.push({
      candidate_id: 'topology-pipe-fed',
      kind: 'pipe-fed',
      internal_item_strategy: 'none',
      external_item_strategy: 'none',
      fluid_strategy: 'pipe',
      requires_validation: ['fluid_throughput'],
    })
  }

  if (!has_item_transport && !has_fluid_transport) {
    candidates.push({
      candidate_id: 'topology-self-contained',
      kind: 'self-contained',
      internal_item_strategy: 'none',
      external_item_strategy: 'none',
      fluid_strategy: 'none',
      requires_validation: [],
    })
  }

  return {
    internal_transfers: transfers,
    external_requirements: {
      item_input_count: external_item_count,
      fluid_input_count: external_fluid_count,
    },
    layout_readiness: layout_readiness(solution),
    candidate_ordering: 'canonical_not_ranked',
    candidates,
    semantics: {
      selection: 'bounded recipe-graph archetypes only; canonical ordering is not a ranking and does not preselect or exhaust possible factory designs',
      validation: 'a topology candidate is only a design option; every requires_validation entry remains unresolved until a deterministic validator or live observation proves it',
    },
  }
}
