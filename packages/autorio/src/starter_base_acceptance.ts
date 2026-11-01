import type { LuaEntity, LuaForce } from 'factorio:runtime'
import { entity_role_inventories } from './inventory_roles'
import { find_world_entities } from './npc_vision'

// Acceptance policy, not a recipe/rate assumption. Native observations must
// cover a complete five-minute interval with fixed native sampling and no manual servicing or gaps.
export const STARTER_OBSERVATION_TICKS = 18000
export const STARTER_SAMPLE_TICKS = 60
const MAX_ENTITIES = 2000
interface StockTarget { item_name: string, minimum: number }
export interface StarterBaseSpec {
  acceptance_key?: string
  science_item: string
  technology: string
  supply_items: string[]
  construction_stocks: StockTarget[]
}
export interface StarterSample {
  tick: number
  service: number
  science: number
  research: number
  labs: Record<number, number>
  stock: Record<string, number>
  produced: Record<string, number>
  capabilities: Record<string, boolean>
  inputs: Record<string, number>
}
export interface StarterBindings {
  members: number[]
  science: { producer: number, inserter: number, lab: number }
  supplies: Array<{ item_name: string, producer: number }>
  stocks: Array<{ item_name: string, producer: number, inserter: number, container: number }>
}
interface StarterWindow {
  bindings: StarterBindings
  entities: Record<number, LuaEntity>
  bucket?: StarterSample
  buckets: number
  replenished: Record<string, boolean>

  version: 1
  spec: StarterBaseSpec
  force_index: number
  registered_tick: number
  observation_id: string
  expired?: boolean
  closed?: boolean
  first?: StarterSample
  last?: StarterSample
  delivered: boolean
  capabilities: Record<string, boolean>
  satisfied: boolean
  reason: string
}
declare const storage: {
  sgluna_starter_windows?: Record<number, StarterWindow>
  sgluna_starter_service?: Record<number, number>
  sgluna_operation_admissions?: Array<{ state: string, slots: Array<{ operation?: string }> }>
}

// Called before the older hand-work exclusions: fuel and lab science ARE
// servicing here. The counter persists in the save and never grants authority.
export function note_starter_servicing(force_index: number) {
  storage.sgluna_starter_service ??= {}
  storage.sgluna_starter_service[force_index] = (storage.sgluna_starter_service[force_index] ?? 0) + 1
  const window = storage.sgluna_starter_windows?.[force_index]
  if (window) window.satisfied = false
}

function restart(window: StarterWindow, sample: StarterSample, reason: string) {
  window.first = sample; window.last = sample
  window.delivered = false; window.capabilities = {}; window.bucket = sample; window.buckets = 0; window.replenished = {}; window.satisfied = false; window.reason = reason
}

/** Native adapter supplies every fixed sampling tick. Exported only for deterministic tests. */
export function apply_starter_sample(window: StarterWindow, sample: StarterSample) {
  const first = window.first; const last = window.last
  if (!first || !last) return restart(window, sample, 'observing')
  if (sample.tick !== last.tick + STARTER_SAMPLE_TICKS || sample.service !== first.service
    || sample.science < last.science || sample.research < last.research
    || Object.keys(first.labs).some(id => sample.labs[Number(id)] === undefined)
    || Object.keys(first.inputs).length !== Object.keys(sample.inputs).length
    || Object.keys(first.inputs).some(key => sample.inputs[key] === undefined)) {
    return restart(window, sample, 'servicing_gap_or_identity_change')
  }
  // An increase at the exact same lab with no manual insertion proves delivery
  // by the native factory; research must also advance during this interval.
  for (const id of Object.keys(last.labs)) {
    if (sample.labs[Number(id)] > last.labs[Number(id)]) window.delivered = true
  }
  for (const key of Object.keys(last.inputs)) {
    if (sample.inputs[key] > last.inputs[key]) window.replenished[key] = true
  }
  for (const key of Object.keys(sample.capabilities)) {
    if (sample.capabilities[key]) window.capabilities[key] = true
  }
  window.last = sample
  const bucket = window.bucket
  if (bucket && sample.tick - bucket.tick >= 3600) {
    if (sample.science <= bucket.science || window.spec.supply_items.some(item => sample.produced[item] <= bucket.produced[item])
      || !['power', 'extraction', 'smelting', 'transport', 'assembly', 'lab'].every(key => window.capabilities[key])) {
      return restart(window, sample, 'sustained_output_or_capability_missing')
    }
    window.buckets++; window.bucket = sample; window.capabilities = {}
  }
  const supplies = window.spec.supply_items.every(item => sample.produced[item] > first.produced[item])
  const stocks = window.spec.construction_stocks.every(target => sample.stock[target.item_name] >= target.minimum
    && sample.stock[target.item_name] > first.stock[target.item_name]
    && sample.produced[target.item_name] > first.produced[target.item_name])
  window.satisfied = sample.tick - first.tick >= STARTER_OBSERVATION_TICKS
    && Object.keys(first.inputs).length > 0 && Object.keys(first.inputs).every(key => window.replenished[key])
    && window.buckets >= 5 && sample.science > first.science && sample.research === 1 && sample.research > first.research && window.delivered && supplies && stocks
  window.reason = window.satisfied ? 'native_window_verified' : 'observing_unmet_acceptance'
}

function valid_spec(request: Record<string, unknown>): StarterBaseSpec | undefined {
  const science = request.science_item; const technology = request.technology
  const supplies = request.supply_items as string[] | undefined
  const stocks = request.construction_stocks as StockTarget[] | undefined
  if (typeof science !== 'string' || !prototypes.item[science] || typeof technology !== 'string'
    || !Array.isArray(supplies) || supplies.length < 1 || supplies.length > 8
    || supplies.some(item => typeof item !== 'string' || !prototypes.item[item])
    || !Array.isArray(stocks) || stocks.length < 1 || stocks.length > 8
    || stocks.some(target => !target || typeof target.item_name !== 'string' || !prototypes.item[target.item_name]
      || typeof target.minimum !== 'number' || target.minimum !== math.floor(target.minimum) || target.minimum < 1 || target.minimum > 1000000)) return undefined
  if (typeof request.acceptance_key !== 'string' || request.acceptance_key.length < 1 || request.acceptance_key.length > 160) return undefined
  return { acceptance_key: request.acceptance_key, science_item: science, technology, supply_items: supplies, construction_stocks: stocks }
}

function produced(entity: LuaEntity, item: string): number | undefined {
  if (!['furnace', 'assembling-machine'].includes(entity.type)) return undefined
  const [recipe, quality] = entity.get_recipe()
  const product = recipe?.products[0]
  if (!recipe || quality?.name !== 'normal' || recipe.products.length !== 1 || product?.type !== 'item'
    || product.name !== item || product.amount === undefined || (product.probability ?? 1) !== 1) return undefined
  return entity.products_finished * product.amount
}

function direct_delivery(window: StarterWindow, producer: number, inserter: number, consumer: number) {
  const source = window.entities[producer]; const arm = window.entities[inserter]; const target = window.entities[consumer]
  return source && arm?.type === 'inserter' && target && arm.pickup_target === source && arm.drop_target === target
}

function observe(window: StarterWindow, force: LuaForce): StarterSample | undefined {
  if (game.connected_players.length !== 0 || (storage.sgluna_operation_admissions ?? []).some(row =>
    ['admitting', 'admitted', 'uncertain'].includes(row.state) && (row.slots.length === 0 || row.slots.some(slot => !['wait_ticks', 'wait_condition'].includes(slot.operation ?? 'unknown'))))) return undefined
  const tech = force.technologies[window.spec.technology]
  if (!tech) return undefined
  for (const id of window.bindings.members) {
    const entity = window.entities[id]
    if (!entity?.valid || entity.unit_number !== id || entity.force.index !== force.index) return undefined
  }
  const science = window.bindings.science
  if (!direct_delivery(window, science.producer, science.inserter, science.lab)
    || window.entities[science.lab].type !== 'lab') return undefined
  const science_count = produced(window.entities[science.producer], window.spec.science_item)
  if (science_count === undefined) return undefined
  const sample: StarterSample = { tick: game.tick, service: storage.sgluna_starter_service?.[force.index] ?? 0,
    science: science_count, research: tech.researched ? 1 : force.current_research?.name === tech.name ? force.research_progress : 0,
    labs: {}, stock: {}, produced: {}, capabilities: {}, inputs: {} }
  sample.labs[science.lab] = window.entities[science.lab].get_inventory(defines.inventory.lab_input)?.get_item_count(window.spec.science_item) ?? 0
  for (const row of window.bindings.supplies) {
    const count = produced(window.entities[row.producer], row.item_name)
    if (count === undefined) return undefined
    sample.produced[row.item_name] = count
  }
  for (const row of window.bindings.stocks) {
    if (!direct_delivery(window, row.producer, row.inserter, row.container)) return undefined
    const inventory = window.entities[row.container].get_inventory(defines.inventory.chest)
    const count = produced(window.entities[row.producer], row.item_name)
    if (!inventory || count === undefined) return undefined
    sample.stock[row.item_name] = inventory.get_item_count(row.item_name)
    sample.produced[row.item_name] = count
  }
  for (const id of window.bindings.members) {
    const entity = window.entities[id]
    capability(sample, entity)
    const inventories = entity_role_inventories(entity)
    if (['furnace', 'assembling-machine'].includes(entity.type)) {
      const [recipe] = entity.get_recipe()
      if (!recipe) return undefined
      for (const ingredient of recipe.ingredients) {
        if (ingredient.type !== 'item') continue
        sample.inputs[`${id}:${recipe.name}:${ingredient.name}`] = inventories.filter(row => row.role === 'input')
          .reduce((sum, row) => sum + row.inventory.get_item_count(ingredient.name), 0)
      }
    }
    if (entity.burner) {
      sample.inputs[`${id}:fuel`] = inventories.filter(row => row.role === 'fuel')
        .reduce((sum, row) => sum + row.inventory.get_contents().reduce((count, item) => count + item.count, 0), 0)
    }
  }
  return sample
}

function bind(force: LuaForce, raw: unknown, spec: StarterBaseSpec): { bindings: StarterBindings, entities: Record<number, LuaEntity> } | undefined {
  const bindings = raw as StarterBindings | undefined
  const unit = (value: unknown) => typeof value === 'number' && value > 0 && value === math.floor(value)
  if (!bindings || !Array.isArray(bindings.members) || bindings.members.length < 1 || bindings.members.length > 64
    || bindings.members.some(id => !unit(id)) || !bindings.science
    || !Array.isArray(bindings.supplies) || bindings.supplies.length !== spec.supply_items.length
    || !Array.isArray(bindings.stocks) || bindings.stocks.length !== spec.construction_stocks.length) return undefined
  const refs = [bindings.science.producer, bindings.science.inserter, bindings.science.lab]
  for (const item of spec.supply_items) {
    const rows = bindings.supplies.filter(row => row.item_name === item)
    if (rows.length !== 1) return undefined
    refs.push(rows[0].producer)
  }
  for (const item of spec.construction_stocks) {
    const rows = bindings.stocks.filter(row => row.item_name === item.item_name)
    if (rows.length !== 1) return undefined
    refs.push(rows[0].producer, rows[0].inserter, rows[0].container)
  }
  if (refs.some(id => !unit(id) || !bindings.members.includes(id))) return undefined
  const entities: Record<number, LuaEntity> = {}; const inserters: LuaEntity[] = []; let scanned = 0
  for (const [, surface] of game.surfaces) {
    for (const entity of find_world_entities(surface, { force })) {
      scanned++
      if (scanned > MAX_ENTITIES) return undefined
      if (entity.valid && entity.type === 'inserter') inserters.push(entity)
      if (entity.valid && entity.unit_number !== undefined && bindings.members.includes(entity.unit_number)) entities[entity.unit_number] = entity
    }
  }
  if (bindings.members.some(id => !entities[id])) return undefined
  const surface = entities[bindings.members[0]].surface.index
  if (bindings.members.some(id => entities[id].surface.index !== surface)) return undefined
  // An unselected inserter could deliver old/unrelated stock; refuse it rather
  // than attributing its output to the selected producer.
  const deliveries = [{ inserter: bindings.science.inserter, consumer: bindings.science.lab },
    ...bindings.stocks.map(row => ({ inserter: row.inserter, consumer: row.container }))]
  if (deliveries.some(row => inserters.some(arm => arm.drop_target === entities[row.consumer] && arm.unit_number !== row.inserter))) return undefined
  return { bindings, entities }
}

function capability(sample: StarterSample, entity: LuaEntity) {
  if (entity.status !== defines.entity_status.working) return
  if (['generator', 'solar-panel', 'burner-generator'].includes(entity.type)) sample.capabilities.power = true
  if (entity.type === 'mining-drill') sample.capabilities.extraction = true
  if (entity.type === 'furnace') sample.capabilities.smelting = true
  if (['inserter', 'transport-belt', 'underground-belt', 'splitter'].includes(entity.type)) sample.capabilities.transport = true
  if (entity.type === 'assembling-machine') sample.capabilities.assembly = true
  if (entity.type === 'lab') sample.capabilities.lab = true
}

export function tick_starter_acceptance() {
  if (game.tick % STARTER_SAMPLE_TICKS !== 0) return
  for (const [index, window] of pairs(storage.sgluna_starter_windows ?? {})) {
    if (window.closed || window.expired) continue
    if (game.tick - window.registered_tick > STARTER_OBSERVATION_TICKS * 2) { window.expired = true; window.reason = 'observation_expired'; continue }
    const force = game.forces[index as number]
    const sample = force && observe(window, force)
    if (sample) apply_starter_sample(window, sample)
    else { window.first = undefined; window.last = undefined; window.satisfied = false; window.reason = 'native_evidence_unavailable' }
  }
}

export function evaluate_starter_acceptance(force: LuaForce, request: Record<string, unknown>) {
  // The harness acknowledges only after durable canonical completion. A mere
  // successful observation must keep sampling until the next supervisor poll.
  if (request.stop_observation === true) {
    const held = storage.sgluna_starter_windows?.[force.index]
    if (!held || held.spec.acceptance_key !== request.acceptance_key || held.observation_id !== request.observation_id) return { ok: false, error: 'starter_observation_owner_changed' }
    held.closed = true
    return { ok: true, stopped: true, acceptance_key: held.spec.acceptance_key }
  }
  const spec = valid_spec(request)
  if (!spec || !force.technologies[spec.technology]) return { ok: false, error: 'invalid_automated_starter_base' }
  storage.sgluna_starter_windows ??= {}
  let window = storage.sgluna_starter_windows[force.index]
  // A changed specification cannot inherit a prior measurement. Runtime goal
  // definition immutability separately prevents lowering accepted targets.
  if (!window || request.restart_measurement === true || helpers.table_to_json(window.spec) !== helpers.table_to_json(spec)
    || helpers.table_to_json(window.bindings) !== helpers.table_to_json((request.bindings ?? {}) as object)) {
    if (typeof request.observation_id !== 'string' || request.observation_id.length < 1 || request.observation_id.length > 160) return { ok: false, error: 'starter_observation_identity_required' }
    const bound = bind(force, request.bindings, spec)
    if (!bound) return { ok: false, error: 'starter_exact_bindings_required' }
    window = { ...bound, observation_id: request.observation_id, version: 1, spec, force_index: force.index, registered_tick: game.tick, buckets: 0, replenished: {}, delivered: false, capabilities: {}, satisfied: false, reason: 'observing' }
    if (!observe(window, force)) return { ok: false, error: 'starter_native_binding_unsupported' }
    storage.sgluna_starter_windows[force.index] = window
  }
  const fresh = window.satisfied ? observe(window, force) : undefined
  const recent = window.last && game.tick - window.last.tick <= STARTER_SAMPLE_TICKS * 2
  const consistent = fresh && fresh.research === 1 && window.first
    && helpers.table_to_json(Object.keys(fresh.inputs).sort()) === helpers.table_to_json(Object.keys(window.first.inputs).sort())
  const stocks_held = recent && consistent && fresh && spec.construction_stocks.every(row => fresh.stock[row.item_name] >= row.minimum)
  return { ok: true, kind: 'automated_starter_base', satisfied: window.closed !== true && window.expired !== true && stocks_held === true && window.satisfied && window.last?.service === (storage.sgluna_starter_service?.[force.index] ?? 0),
    tick: game.tick, observation_id: window.observation_id, observation_start_tick: window.first?.tick, observation_ticks: STARTER_OBSERVATION_TICKS,
    reason: window.reason, lab_delivery_verified: window.delivered, capabilities: window.capabilities,
    baseline: window.first, current_evidence: window.last, targets: spec }
}
