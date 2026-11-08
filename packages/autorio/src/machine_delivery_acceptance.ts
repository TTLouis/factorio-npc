import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { OperationAdmission } from './operation_admission'
import type { TaskBatchIdentity } from './task_manager'
import { product_probability } from './production_rates'

// A finite batch, not sustained automation. No recipe, yield or layout is stored.
// Old stock is a global contamination budget: even if every old item is moved
// into the selected chest, only its excess can count as newly machine-produced.
const MAX_ENTITIES = 100000
const MAX_PLACEMENTS = 256
interface Placement { entity: LuaEntity, batch_id: number, batch_generation: number, tick: number, finished: number, recipe?: string, product_amount?: number }
interface Window {
  acceptance_key: string, item_name: string, minimum: number, producer_type: 'furnace',
  actor_id: number, force_index: number, surface_index: number, epoch: number, session: string,
  armed_tick: number, baseline_stock: number, baseline_produced: number, produced: number,
  placements: Record<number, Placement>, destination?: number, bound_tick?: number, binding?: string,
  invalid?: string, closed?: boolean,
}
declare const storage: { sgluna_machine_delivery?: Window, sgluna_operation_admissions?: OperationAdmission[] }
const positive = (value: unknown): value is number => typeof value === 'number' && value > 0 && value === math.floor(value) && value < 1000000000
const bounded = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit

function scope(actor: ControlledActor | undefined, window?: Window) {
  if (!actor?.is_valid || !actor.character?.valid || game.connected_players.length !== 0) return undefined
  if (!remote.interfaces.sgluna_deployment?.status) return undefined
  const identity = remote.call('sgluna_deployment', 'status') as any
  if (!positive(identity.actor_id) || !positive(identity.epoch) || !bounded(identity.session, 240)
    || identity.actor_id !== actor.status_snapshot().actor_id || identity.allowed !== true
    || remote.call('sgluna_deployment', 'authorize', identity.epoch) !== true) return undefined
  if (window && (window.actor_id !== identity.actor_id || window.epoch !== identity.epoch || window.session !== identity.session
    || window.force_index !== actor.force.index || window.surface_index !== actor.surface.index)) return undefined
  return identity
}

function production_total(item: string) {
  let total = 0
  for (const [, force] of game.forces) for (const [, surface] of game.surfaces) {
    total += force.get_item_production_statistics(surface).get_input_count(item) as number
  }
  return total
}

function inventory_count(entity: LuaEntity, item: string) {
  let count = 0
  // Counting aliased inventories twice is conservative: it can only increase
  // excluded old stock, never grant new production credit.
  for (let index = 1; index <= entity.get_max_inventory_index(); index++) {
    const inventory = entity.get_inventory(index)
    if (inventory?.valid) for (const stack of inventory.get_contents()) if (stack.name === item) count += stack.count
  }
  if (entity.type === 'item-entity' && entity.stack?.valid_for_read && entity.stack.name === item) count += entity.stack.count
  if (entity.type === 'inserter' && entity.held_stack?.valid_for_read && entity.held_stack.name === item) count += entity.held_stack.count
  if (['transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt'].includes(entity.type)) {
    for (let index = 1; index <= entity.get_max_transport_line_index(); index++) {
      const line = entity.get_transport_line(index)
      if (line?.valid) count += line.get_item_count(item)
    }
  }
  return count
}

function stock_census(item: string) {
  let count = 0; let scanned = 0
  for (const [, surface] of game.surfaces) {
    const entities = surface.find_entities_filtered({ limit: MAX_ENTITIES - scanned + 1 })
    scanned += entities.length
    if (scanned > MAX_ENTITIES) return undefined
    for (const entity of entities) if (entity.valid) count += inventory_count(entity, item)
  }
  return count
}

export function arm_machine_delivery(actor: ControlledActor | undefined, request: any) {
  const identity = scope(actor)
  if (!identity || !actor) return { ok: false, error: 'machine_delivery_scope_unavailable' }
  if (!bounded(request?.acceptance_key, 200) || !bounded(request?.item_name, 100) || !positive(request.minimum)
    || request.producer_type !== 'furnace' || !prototypes.item[request.item_name]) return { ok: false, error: 'invalid_machine_delivery_spec' }
  const prior = storage.sgluna_machine_delivery
  if (prior) {
    if (prior.acceptance_key === request.acceptance_key && prior.item_name === request.item_name && prior.minimum === request.minimum
      && prior.producer_type === request.producer_type && scope(actor, prior)) return evaluate_machine_delivery(actor, request)
    return { ok: false, error: 'machine_delivery_already_armed' }
  }
  // A bounded complete census or no contract. Never silently treat missing
  // inventory/transport coverage as zero. Exceptions refuse arming.
  const [ok, stock] = pcall(() => stock_census(request.item_name))
  if (!ok || stock === undefined) return { ok: false, error: 'machine_delivery_census_incomplete' }
  storage.sgluna_machine_delivery = { acceptance_key: request.acceptance_key, item_name: request.item_name, minimum: request.minimum,
    producer_type: 'furnace', actor_id: identity.actor_id, epoch: identity.epoch, session: identity.session,
    force_index: actor.force.index, surface_index: actor.surface.index, armed_tick: game.tick,
    baseline_stock: stock as number, baseline_produced: production_total(request.item_name), produced: 0, placements: {} }
  log(`[AUTORIO] machine_delivery.armed key=${request.acceptance_key} tick=${game.tick} baseline_stock=${stock}`)
  return evaluate_machine_delivery(actor, request)
}

export function note_machine_delivery_placement(actor: ControlledActor, entity: LuaEntity, batch: TaskBatchIdentity | undefined) {
  const window = storage.sgluna_machine_delivery
  if (!window || window.closed || window.invalid || !scope(actor, window) || !entity.unit_number || !batch) return
  const admitted = storage.sgluna_operation_admissions?.some(row => row.state === 'admitted' && row.actor_id === window.actor_id
    && row.epoch === window.epoch && row.slots?.some(slot => slot.batch_refs?.some(ref => ref.batch_id === batch.batch_id
      && ref.batch_generation === batch.batch_generation)))
  if (!admitted) return
  if (Object.keys(window.placements).length >= MAX_PLACEMENTS) { window.invalid = 'placement_evidence_limit'; return }
  window.placements[entity.unit_number] = { entity, batch_id: batch.batch_id, batch_generation: batch.batch_generation, tick: game.tick,
    finished: entity.type === 'furnace' ? entity.products_finished : 0 }
}

export function bind_machine_delivery(actor: ControlledActor | undefined, request: any, binding = 'explicit_model_selection') {
  const window = storage.sgluna_machine_delivery
  if (!window || window.closed || request?.acceptance_key !== window.acceptance_key || !scope(actor, window)) return { ok: false, error: 'machine_delivery_scope_mismatch' }
  if (!positive(request.unit_number)) return { ok: false, error: 'invalid_machine_delivery_destination' }
  if (window.destination !== undefined && window.destination !== request.unit_number) return { ok: false, error: 'machine_delivery_destination_immutable' }
  const placed = window.placements[request.unit_number]
  const entity = placed?.entity
  if (!entity?.valid || entity.type !== 'container' || entity.unit_number !== request.unit_number
    || entity.surface.index !== window.surface_index || entity.force.index !== window.force_index) return { ok: false, error: 'machine_delivery_requires_new_actor_chest' }
  window.destination = request.unit_number
  window.bound_tick ??= game.tick
  window.binding ??= binding
  log(`[AUTORIO] machine_delivery.destination_bound key=${window.acceptance_key} unit=${request.unit_number} binding=${window.binding}`)
  return { ok: true, acceptance_key: window.acceptance_key, unit_number: window.destination, binding: window.binding, bound_tick: window.bound_tick }
}

// Public model route: only the chest identity is selectable. The host-armed
// native window owns the goal key, target and baseline; this cannot create or
// replace a window. bind_machine_delivery retains its actor/epoch/world fences.
export function bind_current_machine_delivery(actor: ControlledActor | undefined, request: any) {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(field => field !== 'unit_number') || !positive(request.unit_number)) return { ok: false, error: 'invalid_machine_delivery_binding' }
  const window = storage.sgluna_machine_delivery
  if (!window) return { ok: false, error: 'machine_delivery_spec_not_armed' }
  return bind_machine_delivery(actor, { acceptance_key: window.acceptance_key, unit_number: request.unit_number })
}

export function note_machine_delivery_exact_deposit(actor: ControlledActor, item: string, unit: number | undefined, moved: number) {
  const window = storage.sgluna_machine_delivery
  if (window && item === window.item_name && unit !== undefined && moved > 0 && window.destination === undefined) {
    bind_machine_delivery(actor, { acceptance_key: window.acceptance_key, unit_number: unit }, 'completed_exact_deposit')
  }
}

// Target-item hand work can introduce untracked/non-machine stock. It voids
// this strict finite proof; feeding other items and fuel does not.
export function note_machine_delivery_nonmachine_gain(item: string) {
  const window = storage.sgluna_machine_delivery
  if (window && !window.closed && (item === window.item_name || item === '*')) window.invalid ??= 'nonmachine_target_gain'
}

export function tick_machine_delivery(actor: ControlledActor | undefined) {
  const window = storage.sgluna_machine_delivery
  if (!window || window.closed || window.invalid) return
  if (!scope(actor, window)) { window.invalid = 'actor_epoch_or_world_changed'; return }
  const [ok] = pcall(() => {
    for (const placed of Object.values(window.placements)) {
      const entity = placed.entity
      if (!entity.valid || entity.type !== window.producer_type) continue
      if (entity.surface.index !== window.surface_index || entity.force.index !== window.force_index) { window.invalid = 'producer_world_changed'; return }
      const finished = entity.products_finished
      const [recipe] = entity.get_recipe()
      const delta = finished - placed.finished
      if (delta < 0 || (delta > 0 && (placed.recipe === undefined || placed.product_amount === undefined
        || (recipe !== undefined && recipe.name !== placed.recipe)))) {
        window.invalid = 'producer_counter_or_recipe_changed'; return
      }
      if (delta > 0) window.produced += delta * placed.product_amount!
      // A furnace clears get_recipe() after its final craft. Retain the prior
      // live recipe/yield witness while empty; do not attribute a completed
      // craft to a different recipe first observed after that completion.
      if (recipe !== undefined) {
        let amount = 0
        for (const product of recipe.products) if (product.type === 'item' && product.name === window.item_name) {
          if (typeof product.amount !== 'number' || product_probability(product) !== 1 || (product.extra_count_fraction ?? 0) !== 0) {
            window.invalid = 'uncertain_native_product_yield'; return
          }
          amount += product.amount
        }
        placed.product_amount = amount
        placed.recipe = recipe.name
      }
      placed.finished = finished
    }
  })
  if (!ok) window.invalid = 'producer_evidence_unavailable'
}

export function evaluate_machine_delivery(actor: ControlledActor | undefined, request: any) {
  const window = storage.sgluna_machine_delivery
  if (!window || request?.acceptance_key !== window.acceptance_key || request.item_name !== window.item_name || request.minimum !== window.minimum) {
    return { ok: false, satisfied: false, error: 'machine_delivery_spec_not_armed' }
  }
  tick_machine_delivery(actor)
  const base = { ok: true, kind: 'machine_output_delivered', acceptance_key: window.acceptance_key, item_name: window.item_name,
    minimum: window.minimum, tick: game.tick, armed_tick: window.armed_tick, actor_id: window.actor_id, epoch: window.epoch,
    surface_index: window.surface_index, force_index: window.force_index, baseline_stock: window.baseline_stock,
    newly_machine_produced: window.produced, destination_unit_number: window.destination, binding: window.binding, bound_tick: window.bound_tick }
  if (window.invalid || window.closed) return { ...base, satisfied: false, reason: window.invalid ?? 'closed' }
  const [ok, result] = pcall(() => {
    const statistics = production_total(window.item_name) - window.baseline_produced
    // Other native production/mining cannot be silently attributed to these
    // new furnaces. Productivity/probabilistic outputs need a separate proof.
    if (statistics !== window.produced) return { ...base, satisfied: false, reason: 'production_origin_unproven', native_production_delta: statistics }
    const destination = window.destination === undefined ? undefined : window.placements[window.destination]?.entity
    if (!destination?.valid || destination.unit_number !== window.destination || destination.type !== 'container'
      || destination.force.index !== window.force_index || destination.surface.index !== window.surface_index) return { ...base, satisfied: false, reason: 'exact_destination_unbound_or_gone' }
    const inventory = destination.get_inventory(defines.inventory.chest)
    if (!inventory?.valid) return { ...base, satisfied: false, reason: 'destination_inventory_unavailable' }
    let current = 0
    for (const stack of inventory.get_contents()) if (stack.name === window.item_name) current += stack.count
    const new_delivered_lower_bound = math.max(0, current - window.baseline_stock)
    return { ...base, satisfied: new_delivered_lower_bound >= window.minimum && window.produced >= new_delivered_lower_bound,
      current, new_delivered_lower_bound, native_production_delta: statistics,
      reason: new_delivered_lower_bound >= window.minimum && window.produced >= new_delivered_lower_bound ? 'native_machine_output_in_exact_chest' : 'awaiting_new_delivery',
      placement: { tick: window.placements[window.destination!].tick, batch_id: window.placements[window.destination!].batch_id,
        batch_generation: window.placements[window.destination!].batch_generation } }
  })
  return ok ? result : { ...base, ok: false, satisfied: false, error: 'machine_delivery_evidence_unavailable' }
}
