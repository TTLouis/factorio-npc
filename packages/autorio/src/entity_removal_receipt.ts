import type { HydraulicMutationWitness } from './hydraulic_mutation'
import type { LuaEntity, LuaInventory } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { TaskBatchIdentity } from './task_manager'
import { protected_read } from './electric_facts'
import { product_probability } from './production_rates'
import { record_hand_mined_item } from './hand_work'

// Software limits; every item, yield, quality and capacity comes from native data.
export const REMOVAL_LIMITS = { inventories: 32, slots: 512, products: 32, fluids: 32, name: 200 }
export interface RemovalItem { name: string, quality: string, count: number }
export interface RemovalBinding extends TaskBatchIdentity {
  operation_key: string, attempt_id: string, signature: string, ordinal: number,
  actor_id: number, epoch: number, session: string,
}
export interface RemovalSnapshot {
  target: { unit_number: number, name: string, type: string, quality: string, position: { x: number, y: number }, surface_index: number, force_index: number }
  contents: RemovalItem[]
  products: RemovalItem[]
  inventories: Array<{ index: number, size: number, items: RemovalItem[] }>
  fluidboxes: number
  fluids_empty: true
}
export interface EntityRemovalReceipt {
  hydraulic_guard?: HydraulicMutationWitness
  schema_version: 1
  state: 'prepared' | 'verified' | 'refused' | 'partial' | 'uncertain'
  code: string
  world_id: string
  binding: RemovalBinding
  operation_id: number
  before_tick: number
  after_tick?: number
  before?: RemovalSnapshot
  after?: RemovalSnapshot
  actor_before?: RemovalItem[]
  actor_after?: RemovalItem[]
  recovered_items?: RemovalItem[]
  target_gone?: boolean
  native_call: 'not_attempted' | 'returned_true' | 'returned_false' | 'error'
}
const finite = (v: unknown): v is number => typeof v === 'number' && v === v && v !== math.huge && v !== -math.huge
const integer = (v: unknown): v is number => finite(v) && v >= 0 && math.floor(v) === v
const named = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= REMOVAL_LIMITS.name
function fail(code: string): never { throw new Error(code) }
function add(rows: RemovalItem[], item: RemovalItem) {
  const old = rows.find(row => row.name === item.name && row.quality === item.quality)
  if (old) old.count += item.count
  else rows.push({ ...item })
}
function total(rows: RemovalItem[], item: RemovalItem) { return rows.find(row => row.name === item.name && row.quality === item.quality)?.count ?? 0 }
function same(left: RemovalItem[], right: RemovalItem[]) { return left.length === right.length && left.every(row => total(right, row) === row.count) }

export function removal_inventory(inventory: LuaInventory): { items: RemovalItem[], empty: number } {
  if (!inventory.valid || !integer(inventory.length) || inventory.length > REMOVAL_LIMITS.slots) fail('removal_inventory_unbounded')
  const items: RemovalItem[] = []
  let empty = 0
  for (let slot = 0; slot < inventory.length; slot++) {
    const stack = inventory[slot]
    if (!stack.valid_for_read) { empty++; continue }
    if (!named(stack.name) || !named(stack.quality?.name) || !integer(stack.count) || stack.count < 1
      || !['item', 'module'].includes(stack.type) || stack.health !== 1
      || stack.prototype.spoil_result !== undefined) fail('removal_item_unsupported')
    add(items, { name: stack.name, quality: stack.quality.name, count: stack.count })
  }
  return { items, empty }
}

export function removal_snapshot(entity: LuaEntity): RemovalSnapshot {
  if (!entity.valid || !integer(entity.unit_number) || entity.unit_number < 1 || !named(entity.name)
    || !named(entity.quality?.name) || !finite(entity.position.x) || !finite(entity.position.y)) fail('removal_target_unreadable')
  if (!entity.minable || !entity.prototype.mineable_properties.minable) fail('removal_not_minable')
  // A synchronous mine can destroy fluid and in-flight materials. Never count
  // their loss as successful item custody or silently stop an operating machine.
  if (entity.status === defines.entity_status.working) fail('removal_target_working')
  if (['assembling-machine', 'furnace', 'rocket-silo'].includes(entity.type) && entity.crafting_progress > 0) fail('removal_process_in_flight')
  if (['transport-belt', 'underground-belt', 'splitter', 'loader', 'loader-1x1', 'linked-belt', 'inserter', 'car', 'spider-vehicle', 'locomotive', 'cargo-wagon', 'fluid-wagon', 'artillery-wagon'].includes(entity.type)) fail('removal_contents_domain_unsupported')
  const fluidboxes = entity.fluids_count
  if (!integer(fluidboxes) || fluidboxes > REMOVAL_LIMITS.fluids) fail('removal_fluidboxes_unbounded')
  for (let index = 1; index <= fluidboxes; index++) if (entity.get_fluid(index) !== undefined) fail('removal_fluid_present')
  const max = entity.get_max_inventory_index()
  if (!integer(max) || max > REMOVAL_LIMITS.inventories) fail('removal_inventories_unbounded')
  const contents: RemovalItem[] = []
  const inventories: RemovalSnapshot['inventories'] = []
  let slots = 0
  for (let index = 1; index <= max; index++) {
    const inventory = entity.get_inventory(index)
    if (inventory === undefined) continue
    slots += inventory.length
    if (slots > REMOVAL_LIMITS.slots || inventory.index !== index) fail('removal_inventory_identity_unbounded')
    const observed = removal_inventory(inventory)
    for (const item of observed.items) add(contents, item)
    inventories.push({ index, size: inventory.length, items: observed.items })
  }
  const products: RemovalItem[] = []
  const raw = entity.prototype.mineable_properties.products
  if (!raw || raw.length === 0 || raw.length > REMOVAL_LIMITS.products) fail('removal_products_unbounded')
  for (const product of raw) {
    if (product.type !== 'item' || !named(product.name) || !integer(product.amount) || product.amount < 1
      || product.independent_probability === undefined || product.shared_probability === undefined
      || product_probability(product) !== 1 || (product.extra_count_fraction ?? 0) !== 0 || product.amount_min !== undefined || product.amount_max !== undefined) fail('removal_products_unsupported')
    const prototype = prototypes.item[product.name]
    if (!prototype || !['item', 'module'].includes(prototype.type) || prototype.spoil_result !== undefined) fail('removal_products_unsupported')
    add(products, { name: product.name, count: product.amount, quality: entity.quality.name })
  }
  return { target: { unit_number: entity.unit_number, name: entity.name, type: entity.type, quality: entity.quality.name,
    position: { x: entity.position.x, y: entity.position.y }, surface_index: entity.surface.index, force_index: entity.force.index },
  contents, products, inventories, fluidboxes, fluids_empty: true }
}

export function removal_fits(inventory: LuaInventory, snapshot: RemovalSnapshot) {
  const observed = removal_inventory(inventory)
  // Filters/bars require a matching allocation proof; unfiltered space alone is
  // supported here. Individual can_insert successes cannot prove combined fit.
  if (inventory.supports_filters()) for (let slot = 1; slot <= inventory.length; slot++) {
    if (inventory.get_filter(slot) !== undefined) return false
  }
  if (inventory.supports_bar() && inventory.get_bar() <= inventory.length) return false
  const combined: RemovalItem[] = []
  for (const item of [...snapshot.contents, ...snapshot.products]) add(combined, item)
  let stacks = 0
  for (const item of combined) {
    const size = prototypes.item[item.name]?.stack_size
    const room = inventory.get_insertable_count({ name: item.name, quality: item.quality as any })
    if (!integer(size) || size < 1 || !integer(room) || room < item.count) return false
    const partial = math.max(0, room - observed.empty * size)
    stacks += math.ceil(math.max(0, item.count - partial) / size)
  }
  return stacks <= observed.empty
}

export function inspect_removal(entity: LuaEntity, inventory: LuaInventory) {
  let code = 'removal_snapshot_unreadable'
  try {
    const snapshot = removal_snapshot(entity)
    const actor = removal_inventory(inventory).items
    if (!removal_fits(inventory, snapshot)) return { ok: false as const, code: 'removal_inventory_full' }
    return { ok: true as const, snapshot, actor }
  }
  catch (error) { if (error instanceof Error) code = error.message }
  return { ok: false as const, code }
}

export function execute_removal(actor: ControlledActor, entity: LuaEntity, inventory: LuaInventory, receipt: EntityRemovalReceipt): EntityRemovalReceipt {
  // Caller persists this same receipt on the existing admission record before
  // entering this synchronous native call. A failure is not rolled back/retried.
  const result = protected_read(() => ({ mined: entity.mine({ inventory, force: false }) }))
  receipt.native_call = !result ? 'error' : result.mined ? 'returned_true' : 'returned_false'
  receipt.after_tick = game.tick
  receipt.target_gone = !entity.valid
  receipt.actor_after = protected_read(() => removal_inventory(inventory).items)
  if (entity.valid) receipt.after = protected_read(() => removal_snapshot(entity))
  const before = receipt.actor_before
  const after = receipt.actor_after
  if (!before || !after || !receipt.before || entity.valid && !receipt.after) {
    receipt.state = 'uncertain'; receipt.code = 'removal_custody_unreadable'; return receipt
  }
  const expected: RemovalItem[] = before.map(item => ({ ...item }))
  for (const item of [...receipt.before.contents, ...receipt.before.products]) add(expected, item)
  receipt.recovered_items = []
  for (const item of after) {
    const gain = item.count - total(before, item)
    if (gain > 0) { receipt.recovered_items.push({ ...item, count: gain }); record_hand_mined_item(actor.force.index, item.name) }
  }
  if (result?.mined === true && receipt.target_gone && same(expected, after)) {
    receipt.state = 'verified'; receipt.code = 'removal_custody_verified'
  }
  else {
    receipt.state = receipt.target_gone || !same(before, after) || !same(receipt.before.contents, receipt.after?.contents ?? []) ? 'partial' : 'uncertain'
    receipt.code = 'removal_native_effects_unverified'
  }
  return receipt
}
