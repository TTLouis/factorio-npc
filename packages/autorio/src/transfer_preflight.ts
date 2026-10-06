import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { TransferInventorySnapshot, TransferRefusalCause } from './basic_operations'
import { transfer_refusal_diagnostics } from './basic_operation_runtime'
import { entity_role_inventories } from './inventory_roles'

/**
 * Stateless item-availability facts for the exact transfer operations
 * (`supply_entity`, `move_items_exact`). The native move (basic_operation_runtime
 * state_moving_items) fails with `item_missing` when the NPC holds none of the
 * item and refuses/fails with `nothing_moved` when the destination takes none, so
 * those two cases are certain failures that can be reported before admission.
 * Anything smaller than the request but above zero still moves something, so it
 * is accepted with the counts and a `missing` amount.
 *
 * Codes (in the rejection's `code`, and per item in `transfer.items[].status`):
 * - supply_missing: moving into the entity, the NPC main inventory holds none of the item.
 * - extraction_empty: taking from the entity, none of its inventories holds the item.
 * - destination_full: the destination (entity input/fuel inventories, or the NPC
 *   main inventory when taking) accepts none of the item.
 * Item status `ok` and `partial` (some of the request available) are accepted.
 */
export type TransferPreflightCode = 'supply_missing' | 'extraction_empty' | 'destination_full'
export type TransferItemStatus = 'ok' | 'partial' | TransferPreflightCode

export interface TransferItemFacts {
  item_name: string
  requested: number
  /** Count at the source: the NPC main inventory (to_entity) or the entity's inventories (taking). */
  source_count: number
  /** How much the destination can take right now, from the engine's insert-capacity API. */
  destination_accepts: number
  /** What the native move would transfer now: min(requested, source_count, destination_accepts). */
  expected_moved: number
  /** requested - source_count, floored at zero: how much of the request the source cannot supply. */
  missing: number
  status: TransferItemStatus
  /** Present on destination_full when moving into an entity: why nothing fits. */
  refusal_cause?: TransferRefusalCause
  target_inventories?: TransferInventorySnapshot[]
}

export interface TransferPreflightFacts {
  ok: boolean
  code?: TransferPreflightCode
  transfer: {
    direction: 'to_entity' | 'from_entity'
    items: TransferItemFacts[]
  }
}

const MAX_TRANSFER_PREFLIGHT_ITEMS = 8

function positive_integer(value: unknown): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= 1 && value <= 100000
}

function item_facts_to_entity(actor: ControlledActor, target: LuaEntity, item_name: string, requested: number): TransferItemFacts {
  const actor_inventory = actor.get_main_inventory()
  const source_count = actor_inventory ? actor_inventory.get_item_count(item_name) : 0
  // The native move inserts only into input and fuel inventories that can take the item.
  let destination_accepts = 0
  for (const { inventory, role } of entity_role_inventories(target)) {
    if (role !== 'input' && role !== 'fuel') continue
    if (!inventory.can_insert({ name: item_name })) continue
    destination_accepts += inventory.get_insertable_count({ name: item_name })
  }
  const missing = math.max(0, requested - source_count)
  const expected_moved = math.min(requested, source_count, destination_accepts)
  let status: TransferItemStatus = 'ok'
  if (source_count <= 0) status = 'supply_missing'
  else if (destination_accepts <= 0) status = 'destination_full'
  else if (source_count < requested) status = 'partial'
  const facts: TransferItemFacts = {
    item_name,
    requested,
    source_count,
    destination_accepts,
    expected_moved,
    missing,
    status,
  }
  if (status === 'destination_full') {
    const diagnostics = transfer_refusal_diagnostics([target], item_name)
    facts.refusal_cause = diagnostics.refusal_cause
    facts.target_inventories = diagnostics.target_inventories
  }
  return facts
}

function item_facts_from_entity(actor: ControlledActor, target: LuaEntity, item_name: string, requested: number): TransferItemFacts {
  let source_count = 0
  const max_index = target.get_max_inventory_index()
  for (let i = 1; i <= max_index; i++) {
    const inventory = target.get_inventory(i)
    if (inventory) source_count += inventory.get_item_count(item_name)
  }
  const actor_inventory = actor.get_main_inventory()
  const destination_accepts = actor_inventory && actor_inventory.can_insert({ name: item_name })
    ? actor_inventory.get_insertable_count({ name: item_name })
    : 0
  const missing = math.max(0, requested - source_count)
  const expected_moved = math.min(requested, source_count, destination_accepts)
  let status: TransferItemStatus = 'ok'
  if (source_count <= 0) status = 'extraction_empty'
  else if (destination_accepts <= 0) status = 'destination_full'
  else if (source_count < requested) status = 'partial'
  return {
    item_name,
    requested,
    source_count,
    destination_accepts,
    expected_moved,
    missing,
    status,
  }
}

/**
 * Facts for `supply_entity` (args.items, always into the entity) or
 * `move_items_exact` (args.item_name, args.max_count, args.to_entity) against an
 * already-resolved exact target. Returns undefined for arguments the native
 * admission validates itself, so malformed input keeps its existing error.
 */
export function transfer_preflight_facts(
  actor: ControlledActor,
  target: LuaEntity,
  name: string,
  args: Record<string, any>,
): TransferPreflightFacts | undefined {
  const items: TransferItemFacts[] = []
  let to_entity = true
  if (name === 'supply_entity') {
    const requested_items: any[] | undefined = args.items
    if (!requested_items || !Array.isArray(requested_items) || requested_items.length < 1 || requested_items.length > MAX_TRANSFER_PREFLIGHT_ITEMS) return undefined
    for (let i = 0; i < requested_items.length; i++) {
      const item = requested_items[i]
      if (!item || typeof item.item_name !== 'string' || !positive_integer(item.count)) return undefined
      items.push(item_facts_to_entity(actor, target, item.item_name, item.count))
    }
  }
  else if (name === 'move_items_exact') {
    if (typeof args.item_name !== 'string' || !positive_integer(args.max_count) || typeof args.to_entity !== 'boolean') return undefined
    to_entity = args.to_entity
    items.push(to_entity
      ? item_facts_to_entity(actor, target, args.item_name, args.max_count)
      : item_facts_from_entity(actor, target, args.item_name, args.max_count))
  }
  else {
    return undefined
  }

  // The first item that would certainly move nothing decides the rejection code.
  let code: TransferPreflightCode | undefined
  for (const item of items) {
    if (item.status === 'supply_missing' || item.status === 'extraction_empty' || item.status === 'destination_full') {
      code = item.status
      break
    }
  }
  return {
    ok: code === undefined,
    code,
    transfer: { direction: to_entity ? 'to_entity' : 'from_entity', items },
  }
}
