import type { LuaEntity, LuaEntityPrototype } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { PlacementPoint, PlacementWorldBox } from './placement_geometry'
import { has_electric_energy_source, pole_reach, protected_read } from './electric_facts'
import { resolve_entity_reference } from './entity_reference'
import { find_world_entities } from './npc_vision'
import { item_output_position } from './placement_candidates'
import { rotate_cardinal, vector_xy } from './placement_geometry'
import { planned_placement_footprint } from './placement_preflight'

// Typed connections between the placements of one validated construction plan, and the layout record that tracks them while
// the plan executes. Everything here reads engine and prototype facts (prototype `type`, the inserter vectors, the drill's
// output vector, the pole's supply area, the entity's own pickup/drop targets); nothing dispatches on an entity name, and a
// fact that cannot be read is reported as unproven, never fabricated.
//
//   validate   connections are normalized and proved geometrically BEFORE anything is built (prove_connection, from the
//              planned footprints and the live boxes of existing endpoints), and the placements get a dependency order.
//   execute    the placing runtime calls layout_node_precheck just before create_entity (the connections that already have
//              their other endpoints built must still hold against the ACTUAL entities) and record_layout_node_placed right
//              after it (binds the unit_number to the node, then verifies the connections with the entities' native fields).
//
// A layout never claims production: placement and connection are not throughput (`production` stays 'not_asserted').

export const MAX_LAYOUT_PLACEMENTS = 6
export const MAX_LAYOUT_CONNECTIONS = 8
const MAX_SLOT_LENGTH = 40
// Records kept in storage. Complete records go first; a running or paused one is only dropped when nothing complete is left,
// so the table stays bounded even if paused layouts are never resumed.
const MAX_LAYOUT_RECORDS = 32
const MAX_UNIT_NUMBER = 9007199254740991
const POINT_EPSILON = 0.001
const POSITION_EPSILON = 0.001

type Position = PlacementPoint
type WorldBox = PlacementWorldBox

export interface LayoutPlacement {
  entity_name: string
  x: number
  y: number
  direction?: number
  slot?: string
}

export type LayoutEndpointInput = { slot: string } | { unit_number: number }
export type LayoutConnectionInput =
  | { kind: 'inserter', inserter: { slot: string }, pickup: LayoutEndpointInput, drop: LayoutEndpointInput }
  | { kind: 'power', pole: { slot: string }, consumer: LayoutEndpointInput }
  | { kind: 'drill_output', drill: { slot: string }, receiver: LayoutEndpointInput }
  | { kind: 'fluid', from: LayoutEndpointInput, to: LayoutEndpointInput }

export interface LayoutEndpointRef {
  slot?: string
  unit_number?: number
}

// The stored form of a connection: every role of its kind resolved to a slot or an existing unit_number.
export interface LayoutConnection {
  index: number
  kind: string
  endpoints: Record<string, LayoutEndpointRef>
}

export interface LayoutNode {
  node_id: string
  index: number
  slot?: string
  entity_name: string
  position: Position
  direction: number
  execution_rank: number
  state: 'queued' | 'placed'
  unit_number?: number
  placed_tick?: number
}

export interface LayoutRecordConnection {
  index: number
  kind: string
  endpoints: Record<string, LayoutEndpointRef>
  state: 'pending' | 'verified' | 'mismatch'
  observed?: Record<string, unknown>
}

export interface LayoutRecord {
  layout_id: number
  plan_id: string
  actor_id: number
  surface_index: number
  force_index: number
  created_tick: number
  state: 'running' | 'complete' | 'paused'
  pause_reason?: string
  nodes: LayoutNode[]
  connections: LayoutRecordConnection[]
  production: 'not_asserted'
  duplicate_receipts: number
}

declare const storage: {
  sgluna_construction_layouts?: Record<number, LayoutRecord>
}

// Role names per connection kind, in the order they are read and reported.
const CONNECTION_ROLES: Record<string, string[]> = {
  inserter: ['inserter', 'pickup', 'drop'],
  power: ['pole', 'consumer'],
  drill_output: ['drill', 'receiver'],
  fluid: ['from', 'to'],
}

// The role of each kind that is a placed entity of a known prototype type: it must be a slot of that type.
const DRIVER_ROLES: Record<string, { role: string, type: string }> = {
  inserter: { role: 'inserter', type: 'inserter' },
  power: { role: 'pole', type: 'electric-pole' },
  drill_output: { role: 'drill', type: 'mining-drill' },
}

// Tie-break between placements with no dependency between them, by prototype type: supports before the logistics that
// feed them, wiring last. Anything else is 0.
const ORDER_CATEGORY: Record<string, number> = {
  'inserter': 1,
  'transport-belt': 1,
  'underground-belt': 1,
  'splitter': 1,
  'loader': 1,
  'loader-1x1': 1,
  'electric-pole': 2,
}

function valid_integer(value: unknown, min: number, max: number) {
  return typeof value === 'number' && value === math.floor(value) && value >= min && value <= max
}

export function valid_slot_name(value: unknown) {
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_SLOT_LENGTH) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    const lower = code >= 97 && code <= 122
    const digit = code >= 48 && code <= 57
    if (!lower && !digit && code !== 95 && code !== 45) return false
  }
  return true
}

export function overlaps(a: WorldBox, b: WorldBox) {
  return a.left_top.x < b.right_bottom.x - POINT_EPSILON
    && a.right_bottom.x > b.left_top.x + POINT_EPSILON
    && a.left_top.y < b.right_bottom.y - POINT_EPSILON
    && a.right_bottom.y > b.left_top.y + POINT_EPSILON
}

function point_in_box(point: Position, box: WorldBox) {
  return point.x >= box.left_top.x - POINT_EPSILON && point.x <= box.right_bottom.x + POINT_EPSILON
    && point.y >= box.left_top.y - POINT_EPSILON && point.y <= box.right_bottom.y + POINT_EPSILON
}

function invalid_connection(index: number, message: string) {
  return { error: { code: 'INVALID_CONNECTION', message: `connection ${index}: ${message}`, index } }
}

function normalize_endpoint(value: any): LayoutEndpointRef | undefined {
  if (value === undefined || typeof value !== 'object') return undefined
  const has_slot = value.slot !== undefined
  const has_unit = value.unit_number !== undefined
  if (has_slot === has_unit) return undefined
  if (has_slot) return valid_slot_name(value.slot) ? { slot: value.slot } : undefined
  return valid_integer(value.unit_number, 1, MAX_UNIT_NUMBER) ? { unit_number: value.unit_number } : undefined
}

function slot_indices(placements: LayoutPlacement[]) {
  const result: Record<string, number> = {}
  for (let index = 0; index < placements.length; index++) {
    const slot = placements[index].slot
    if (slot !== undefined) result[slot] = index
  }
  return result
}

// Shape and role checks only (no world reads): every role is a known slot or a unit_number, and the role that fixes a
// connection's geometry is a slot of the matching prototype type. `placements` already carry unique, well-formed slots.
export function normalize_connections(raw: unknown, placements: LayoutPlacement[]) {
  const connections: LayoutConnection[] = []
  if (raw === undefined) return { connections }
  if (!Array.isArray(raw)) return { error: { code: 'INVALID_REQUEST', message: 'connections must be an array' } }
  const items = raw as unknown[]
  if (items.length > MAX_LAYOUT_CONNECTIONS) {
    return { error: { code: 'INVALID_REQUEST', message: `connections must contain at most ${MAX_LAYOUT_CONNECTIONS} entries` } }
  }
  if (items.length > 0 && placements.length > MAX_LAYOUT_PLACEMENTS) {
    return { error: { code: 'INVALID_REQUEST', message: `a plan with connections holds at most ${MAX_LAYOUT_PLACEMENTS} placements` } }
  }
  const slots = slot_indices(placements)
  for (let index = 0; index < items.length; index++) {
    const item = items[index] as any
    if (item === undefined || typeof item !== 'object' || typeof item.kind !== 'string') return invalid_connection(index, 'a connection needs a kind')
    const roles = CONNECTION_ROLES[item.kind]
    if (roles === undefined) return invalid_connection(index, `unknown connection kind ${item.kind}`)
    const endpoints: Record<string, LayoutEndpointRef> = {}
    for (const role of roles) {
      const endpoint = normalize_endpoint(item[role])
      if (endpoint === undefined) return invalid_connection(index, `${role} must be {slot} or {unit_number}`)
      if (endpoint.slot !== undefined && slots[endpoint.slot] === undefined) return invalid_connection(index, `${role} names unknown slot ${endpoint.slot}`)
      endpoints[role] = endpoint
    }
    const driver = DRIVER_ROLES[item.kind]
    if (driver !== undefined) {
      const slot = endpoints[driver.role].slot
      if (slot === undefined) return invalid_connection(index, `${driver.role} must be a slot of this plan`)
      const entity_name = placements[slots[slot]].entity_name
      if (prototypes.entity[entity_name]?.type !== driver.type) {
        return invalid_connection(index, `slot ${slot} is used as the ${driver.role} of a ${item.kind} connection but ${entity_name} is not a ${driver.type}`)
      }
    }
    connections.push({ index, kind: item.kind, endpoints })
  }
  return { connections }
}

function endpoint_slot_node(slots: Record<string, number>, endpoint: LayoutEndpointRef | undefined) {
  return endpoint !== undefined && endpoint.slot !== undefined ? slots[endpoint.slot] : undefined
}

// Deterministic execution order. Without connections it is the plan order. With them, a node follows the nodes it depends on
// (an inserter its slot endpoints, a pole its consumer, a drill's receiver its drill); between independent nodes the
// prototype category decides, then the plan index. A cycle has no order.
export function plan_execution_order(placements: LayoutPlacement[], connections: LayoutConnection[]): { order: number[], cycle?: number[] } {
  const order: number[] = []
  if (connections.length === 0) {
    for (let index = 0; index < placements.length; index++) order.push(index)
    return { order }
  }
  const slots = slot_indices(placements)
  const prerequisites: number[][] = []
  for (let index = 0; index < placements.length; index++) prerequisites.push([])
  const depends = (node: number | undefined, on: number | undefined) => {
    if (node !== undefined && on !== undefined) prerequisites[node].push(on)
  }
  for (const connection of connections) {
    const endpoints = connection.endpoints
    if (connection.kind === 'inserter') {
      const inserter = endpoint_slot_node(slots, endpoints.inserter)
      depends(inserter, endpoint_slot_node(slots, endpoints.pickup))
      depends(inserter, endpoint_slot_node(slots, endpoints.drop))
    }
    else if (connection.kind === 'power') {
      depends(endpoint_slot_node(slots, endpoints.pole), endpoint_slot_node(slots, endpoints.consumer))
    }
    else if (connection.kind === 'drill_output') {
      depends(endpoint_slot_node(slots, endpoints.receiver), endpoint_slot_node(slots, endpoints.drill))
    }
  }
  const done: boolean[] = []
  for (let index = 0; index < placements.length; index++) done.push(false)
  while (order.length < placements.length) {
    let best = -1
    let best_category = 0
    for (let index = 0; index < placements.length; index++) {
      if (done[index]) continue
      let ready = true
      for (const prerequisite of prerequisites[index]) {
        if (!done[prerequisite]) ready = false
      }
      if (!ready) continue
      const category = ORDER_CATEGORY[prototypes.entity[placements[index].entity_name]?.type ?? ''] ?? 0
      if (best < 0 || category < best_category) {
        best = index
        best_category = category
      }
    }
    if (best < 0) {
      const cycle: number[] = []
      for (let index = 0; index < placements.length; index++) {
        if (!done[index]) cycle.push(index)
      }
      return { order, cycle }
    }
    done[best] = true
    order.push(best)
  }
  return { order }
}

// Where an endpoint stands (or will stand) and what it is. A planned view has no entity: its geometry is predicted from the
// prototype. A built view reads the entity's own fields.
export interface EndpointView {
  box?: WorldBox
  position: Position
  direction: number
  prototype: any
  entity?: LuaEntity
  unit_number?: number
}

export function planned_view(entity_name: string, footprint: { position: Position, direction: number, world_box: WorldBox }): EndpointView {
  return { box: footprint.world_box, position: footprint.position, direction: footprint.direction, prototype: prototypes.entity[entity_name] }
}

export function entity_view(entity: LuaEntity): EndpointView | undefined {
  if (!entity.valid) return undefined
  const raw: any = protected_read(() => (entity as any).bounding_box)
  const left_top = raw ? vector_xy(raw.left_top) : undefined
  const right_bottom = raw ? vector_xy(raw.right_bottom) : undefined
  const direction = protected_read(() => entity.direction as number)
  return {
    box: left_top && right_bottom ? { left_top, right_bottom } : undefined,
    position: { x: entity.position.x, y: entity.position.y },
    direction: typeof direction === 'number' ? direction : 0,
    prototype: protected_read(() => entity.prototype) ?? prototypes.entity[entity.name],
    entity,
    unit_number: entity.unit_number,
  }
}

export type ConnectionProof =
  | { status: 'proved', predicted: Record<string, unknown> }
  | { status: 'mismatch', reason: string, predicted: Record<string, unknown>, endpoint_role: string, endpoint_box?: WorldBox, code?: string }
  | { status: 'unproven', reason: string }
  | { status: 'skipped' }

function read_point(entity: LuaEntity, field: string) {
  return vector_xy(protected_read(() => (entity as any)[field]))
}

// The pickup and drop points of an inserter view: the entity's own once built, else predicted from the prototype vectors.
function inserter_points(view: EndpointView) {
  if (view.entity !== undefined) {
    const pickup = read_point(view.entity, 'pickup_position')
    const drop = read_point(view.entity, 'drop_position')
    return pickup !== undefined && drop !== undefined ? { pickup, drop } : undefined
  }
  const prototype = view.prototype
  const pickup = vector_xy(protected_read(() => prototype.inserter_pickup_position))
  const drop = vector_xy(protected_read(() => prototype.inserter_drop_position))
  if (pickup === undefined || drop === undefined) return undefined
  const pickup_offset = rotate_cardinal(pickup, view.direction)
  const drop_offset = rotate_cardinal(drop, view.direction)
  return {
    pickup: { x: view.position.x + pickup_offset.x, y: view.position.y + pickup_offset.y },
    drop: { x: view.position.x + drop_offset.x, y: view.position.y + drop_offset.y },
  }
}

// Inventory indexes scanned on a prototype. Every item-holding entity type uses indexes below this (the lab's input is 2, an
// assembler's or furnace's input/output 2 and 3, modules 4).
const MAX_PROTOTYPE_INVENTORY_INDEX = 10

// Whether a built entity has a native item interface an inserter or drill can act on: an inventory or a transport line. A wall
// or pole has neither, so standing on an inserter's or drill's point does not make it that inserter's or drill's endpoint.
// (`get_max_inventory_index()` is not per entity: 8 for a stone wall on 2.0.77, so each index is looked up.)
function entity_item_interface(entity: LuaEntity): boolean | undefined {
  const lines = protected_read(() => entity.get_max_transport_line_index())
  const inventories = protected_read(() => entity.get_max_inventory_index() as number)
  if (lines === undefined && inventories === undefined) return undefined
  if ((lines ?? 0) > 0) return true
  for (let index = 1; index <= (inventories ?? 0); index++) {
    if (protected_read(() => entity.get_inventory(index as defines.inventory)) !== undefined) return true
  }
  return false
}

// The same fact for a node that is only planned, from its prototype: a belt speed, or a non-empty inventory at some index.
function prototype_item_interface(prototype: LuaEntityPrototype | undefined): boolean | undefined {
  if (!prototype) return undefined
  if (protected_read(() => prototype.belt_speed) !== undefined) return true
  for (let index = 1; index <= MAX_PROTOTYPE_INVENTORY_INDEX; index++) {
    const size = protected_read(() => prototype.get_inventory_size(index as defines.inventory))
    if (size !== undefined && size > 0) return true
  }
  return false
}

// The direction of automated item access an endpoint must allow: an inserter takes from its pickup endpoint and gives to its
// drop endpoint, a drill gives to its receiver. The native prototype flags that forbid each direction to inserters and loaders.
type ItemAccess = 'take' | 'give'
const FORBIDDING_FLAG: Record<ItemAccess, string> = { take: 'no-automated-item-removal', give: 'no-automated-item-insertion' }

// Whether the prototype's flags forbid this direction of automated access; undefined when the flags cannot be read.
function forbids_access(prototype: LuaEntityPrototype | undefined, access: ItemAccess): boolean | undefined {
  if (!prototype) return undefined
  let flags: Record<string, boolean | undefined> | undefined
  try {
    flags = prototype.flags as unknown as Record<string, boolean | undefined> | undefined
  }
  catch {
    return undefined
  }
  return flags?.[FORBIDDING_FLAG[access]] === true
}

// Whether an inserter or drill may act on this endpoint in this direction: it has an item interface and its prototype does
// not forbid that direction of automated access. Undefined when either fact cannot be read.
function item_access(interface_present: boolean | undefined, prototype: LuaEntityPrototype | undefined, access: ItemAccess): 'allowed' | 'no_interface' | 'forbidden' | undefined {
  if (interface_present === undefined) return undefined
  if (!interface_present) return 'no_interface'
  const forbidden = forbids_access(prototype, access)
  if (forbidden === undefined) return undefined
  return forbidden ? 'forbidden' : 'allowed'
}

function entity_item_access(entity: LuaEntity, access: ItemAccess) {
  return item_access(entity_item_interface(entity), protected_read(() => entity.prototype), access)
}

function view_item_access(view: EndpointView, access: ItemAccess) {
  return view.entity !== undefined ? entity_item_access(view.entity, access) : item_access(prototype_item_interface(view.prototype), view.prototype, access)
}

// The roles of an item connection, each with the direction it must allow, checked once the geometry holds.
function item_endpoints_proof(roles: Array<[string, EndpointView, ItemAccess]>, predicted: Record<string, unknown>): ConnectionProof | undefined {
  for (const [role, view, access] of roles) {
    const allowed = view_item_access(view, access)
    if (allowed === undefined) return { status: 'unproven', reason: `the ${role} endpoint's inventories, transport lines or automation flags cannot be read` }
    if (allowed === 'no_interface') {
      return { status: 'mismatch', code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', reason: `the ${role} endpoint has no inventory or transport line to take items from or give them to`, predicted, endpoint_role: role, endpoint_box: view.box }
    }
    if (allowed === 'forbidden') {
      return { status: 'mismatch', code: 'CONNECTION_ENDPOINT_INCOMPATIBLE', reason: `the ${role} endpoint's prototype forbids automated item ${access === 'take' ? 'removal' : 'insertion'} (${FORBIDDING_FLAG[access]})`, predicted, endpoint_role: role, endpoint_box: view.box }
    }
  }
  return undefined
}

function consumes_electricity(view: EndpointView) {
  if (view.entity !== undefined) return has_electric_energy_source(view.entity)
  const prototype = view.prototype
  return protected_read(() => prototype.electric_energy_source_prototype) !== undefined
}

// Whether a connection's geometry holds, from the views of its roles: pre-placement (planned views, existing entities) at
// validation, and mixed (the node about to be built planned, the others built) at execution. A role that is not built yet
// has no view, so the connection is skipped until its other end exists.
export function prove_connection(connection: LayoutConnection, views: Record<string, EndpointView | undefined>): ConnectionProof {
  const kind = connection.kind
  if (kind === 'fluid') {
    return { status: 'unproven', reason: 'fluid ports and the pipe or fluidbox joins between them cannot be predicted from native prototype facts before both ends stand' }
  }
  if (kind === 'inserter') {
    const inserter = views.inserter
    const pickup = views.pickup
    const drop = views.drop
    if (!inserter || !pickup || !drop) return { status: 'skipped' }
    const points = inserter_points(inserter)
    if (points === undefined) return { status: 'unproven', reason: 'the inserter pickup and drop vectors cannot be read' }
    if (!pickup.box || !drop.box) return { status: 'unproven', reason: 'an endpoint collision box cannot be read' }
    const predicted = { pickup_point: points.pickup, drop_point: points.drop, pickup_box: pickup.box, drop_box: drop.box }
    if (!point_in_box(points.pickup, pickup.box)) return { status: 'mismatch', reason: 'the inserter pickup point is outside the pickup endpoint', predicted, endpoint_role: 'pickup', endpoint_box: pickup.box }
    if (!point_in_box(points.drop, drop.box)) return { status: 'mismatch', reason: 'the inserter drop point is outside the drop endpoint', predicted, endpoint_role: 'drop', endpoint_box: drop.box }
    return item_endpoints_proof([['pickup', pickup, 'take'], ['drop', drop, 'give']], predicted) ?? { status: 'proved', predicted }
  }
  if (kind === 'power') {
    const pole = views.pole
    const consumer = views.consumer
    if (!pole || !consumer) return { status: 'skipped' }
    const reach = pole_reach(pole.prototype)
    if (reach === undefined) return { status: 'unproven', reason: 'the pole supply area cannot be read' }
    if (!consumer.box) return { status: 'unproven', reason: 'the consumer collision box cannot be read' }
    const half = reach.supply_area_distance
    const supply_area = {
      left_top: { x: pole.position.x - half, y: pole.position.y - half },
      right_bottom: { x: pole.position.x + half, y: pole.position.y + half },
    }
    const predicted = { supply_area, consumer_box: consumer.box }
    if (!consumes_electricity(consumer)) return { status: 'mismatch', reason: 'the consumer has no electric energy source', predicted, endpoint_role: 'consumer', endpoint_box: consumer.box }
    if (!overlaps(supply_area, consumer.box)) return { status: 'mismatch', reason: 'the pole supply area does not reach the consumer', predicted, endpoint_role: 'consumer', endpoint_box: consumer.box }
    return { status: 'proved', predicted }
  }
  if (kind === 'drill_output') {
    const drill = views.drill
    const receiver = views.receiver
    if (!drill || !receiver) return { status: 'skipped' }
    const output = drill.entity !== undefined
      ? read_point(drill.entity, 'drop_position')
      : item_output_position(drill.prototype, drill.position, drill.direction)
    if (output === undefined) return { status: 'unproven', reason: 'the drill output position cannot be read' }
    if (!receiver.box) return { status: 'unproven', reason: 'the receiver collision box cannot be read' }
    const predicted = { output_point: output, receiver_box: receiver.box }
    if (!point_in_box(output, receiver.box)) return { status: 'mismatch', reason: 'the drill output point is outside the receiver', predicted, endpoint_role: 'receiver', endpoint_box: receiver.box }
    return item_endpoints_proof([['receiver', receiver, 'give']], predicted) ?? { status: 'proved', predicted }
  }
  return { status: 'unproven', reason: `unknown connection kind ${kind}` }
}

function roles_of(connection: LayoutConnection) {
  return CONNECTION_ROLES[connection.kind] ?? []
}

function slots_of(connection: LayoutConnection) {
  const slots: string[] = []
  for (const role of roles_of(connection)) {
    const slot = connection.endpoints[role]?.slot
    if (slot !== undefined) slots.push(slot)
  }
  return slots
}

function resolve_existing_view(actor: ControlledActor, unit_number: number) {
  const entity = resolve_entity_reference(actor, unit_number, 'actor_body')
  if (!entity || !entity.valid) return undefined
  if (entity.surface.index !== actor.surface.index || entity.force.index !== actor.force.index) return undefined
  return entity_view(entity)
}

// The virtual (pre-placement) proof of every connection of a plan whose placements are spatially valid. `footprints` are the
// planned footprints in plan order. A resolvable endpoint that does not satisfy its connection is a spatial failure; one whose
// geometry cannot be predicted is returned as unproven (an eligibility matter, with the staging it needs).
export function prove_plan_connections(actor: ControlledActor, placements: LayoutPlacement[], footprints: Array<{ position: Position, direction: number, world_box: WorldBox }>, connections: LayoutConnection[]) {
  const slots = slot_indices(placements)
  const proofs: Array<Record<string, unknown>> = []
  const unproven: Array<Record<string, unknown>> = []
  for (const connection of connections) {
    const views: Record<string, EndpointView | undefined> = {}
    for (const role of roles_of(connection)) {
      const endpoint = connection.endpoints[role]
      if (endpoint.slot !== undefined) {
        const node = slots[endpoint.slot]
        views[role] = planned_view(placements[node].entity_name, footprints[node])
        continue
      }
      const view = resolve_existing_view(actor, endpoint.unit_number!)
      if (view === undefined) {
        return { error: { code: 'CONNECTION_ENDPOINT_UNAVAILABLE', message: `connection ${connection.index}: ${role} ${endpoint.unit_number} is not an existing entity of this surface and force`, index: connection.index, kind: connection.kind, role, unit_number: endpoint.unit_number } }
      }
      views[role] = view
    }
    const proof = prove_connection(connection, views)
    if (proof.status === 'mismatch') {
      return { error: {
        code: proof.code ?? 'CONNECTION_GEOMETRY_MISMATCH',
        message: `connection ${connection.index} (${connection.kind}): ${proof.reason}`,
        index: connection.index,
        kind: connection.kind,
        endpoint_role: proof.endpoint_role,
        predicted: proof.predicted,
        endpoint_box: proof.endpoint_box,
      } }
    }
    if (proof.status === 'unproven') {
      const staged = slots_of(connection)
      unproven.push({
        code: 'CONNECTION_UNPROVEN',
        message: `connection ${connection.index} (${connection.kind}) cannot be proved before its entities stand: ${proof.reason}`,
        index: connection.index,
        kind: connection.kind,
        reason: proof.reason,
        staged_requirement: staged.length > 0
          ? `place ${staged.join(', ')} in its own validated plan, then validate this connection against its observed ports`
          : 'validate this connection against the observed ports of the existing entities',
      })
      proofs.push({ index: connection.index, kind: connection.kind, endpoints: connection.endpoints, virtual_proof: { status: 'unproven', reason: proof.reason } })
      continue
    }
    proofs.push({
      index: connection.index,
      kind: connection.kind,
      endpoints: connection.endpoints,
      virtual_proof: { status: 'proved', ...(proof.status === 'proved' ? proof.predicted : {}) },
    })
  }
  return { proofs, unproven }
}

// ---------------------------------------------------------------------------------------------------------------------
// Layout record and node receipts
// ---------------------------------------------------------------------------------------------------------------------

function layouts() {
  storage.sgluna_construction_layouts ??= {}
  return storage.sgluna_construction_layouts
}

function prune_layouts(records: Record<number, LayoutRecord>) {
  while (true) {
    let count = 0
    let oldest_complete: LayoutRecord | undefined
    let oldest: LayoutRecord | undefined
    for (const key in records) {
      const record = records[key as unknown as number]
      count++
      if (oldest === undefined || record.layout_id < oldest.layout_id) oldest = record
      if (record.state === 'complete' && (oldest_complete === undefined || record.layout_id < oldest_complete.layout_id)) oldest_complete = record
    }
    if (count <= MAX_LAYOUT_RECORDS) return
    delete records[(oldest_complete ?? oldest)!.layout_id]
  }
}

export function create_layout_record(args: {
  layout_id: number
  plan_id: string
  actor_id: number
  surface_index: number
  force_index: number
  placements: LayoutPlacement[]
  footprints: Array<{ position: Position, direction: number }>
  execution_order: number[]
  connections: LayoutConnection[]
}) {
  const ranks: number[] = []
  for (let index = 0; index < args.placements.length; index++) ranks.push(0)
  for (let rank = 0; rank < args.execution_order.length; rank++) ranks[args.execution_order[rank]] = rank
  const nodes: LayoutNode[] = []
  for (let index = 0; index < args.placements.length; index++) {
    const placement = args.placements[index]
    nodes.push({
      node_id: `layout-${args.layout_id}:n${index}`,
      index,
      slot: placement.slot,
      entity_name: placement.entity_name,
      position: { x: args.footprints[index].position.x, y: args.footprints[index].position.y },
      direction: args.footprints[index].direction,
      execution_rank: ranks[index],
      state: 'queued',
    })
  }
  const connections: LayoutRecordConnection[] = []
  for (const connection of args.connections) {
    connections.push({ index: connection.index, kind: connection.kind, endpoints: connection.endpoints, state: 'pending' })
  }
  const record: LayoutRecord = {
    layout_id: args.layout_id,
    plan_id: args.plan_id,
    actor_id: args.actor_id,
    surface_index: args.surface_index,
    force_index: args.force_index,
    created_tick: game.tick,
    state: 'running',
    nodes,
    connections,
    production: 'not_asserted',
    duplicate_receipts: 0,
  }
  const records = layouts()
  records[args.layout_id] = record
  prune_layouts(records)
  return record
}

// Executor admission failed after the record was created: nothing was built, so the record is withdrawn.
export function discard_layout_record(layout_id: number) {
  const records = storage.sgluna_construction_layouts
  if (records) delete records[layout_id]
}

// Read-only: the stored record of a layout, or an error.
export function construction_layout_status(layout_id: unknown) {
  if (!valid_integer(layout_id, 1, MAX_UNIT_NUMBER)) return { ok: false, error: { code: 'INVALID_REQUEST', message: 'layout_id must be a positive integer' } }
  const record = storage.sgluna_construction_layouts?.[layout_id as number]
  if (!record) return { ok: false, error: { code: 'LAYOUT_UNAVAILABLE', message: `no construction layout ${layout_id} is recorded` } }
  return { ok: true, layout: record }
}

function pause(record: LayoutRecord, reason: string) {
  if (record.state === 'paused') return
  record.state = 'paused'
  record.pause_reason = reason
}

function record_node(record: LayoutRecord, index: number) {
  return valid_integer(index, 0, record.nodes.length - 1) ? record.nodes[index] : undefined
}

function node_of(record: LayoutRecord, endpoint: LayoutEndpointRef) {
  if (endpoint.slot === undefined) return undefined
  for (const node of record.nodes) {
    if (node.slot === endpoint.slot) return node
  }
  return undefined
}

function involves(record: LayoutRecord, connection: LayoutRecordConnection, node: LayoutNode) {
  for (const role of roles_of(connection)) {
    if (node_of(record, connection.endpoints[role])?.index === node.index) return true
  }
  return false
}

function live_node_entity(actor: ControlledActor, node: LayoutNode) {
  if (node.unit_number === undefined) return undefined
  const entity = resolve_entity_reference(actor, node.unit_number, 'actor_body')
  return entity && entity.valid ? entity : undefined
}

// Why the placement about to be created must not proceed, or undefined. Runs immediately before create_entity: every
// connection of this node whose other endpoints are already built (or existing) must still hold against the ACTUAL entities,
// with this node predicted at the position it will be built. It refuses (pre-mutation) when the layout is paused, the record
// or node is missing or no longer matches the task, or a connection fails or cannot be proved. A failed connection pauses the
// layout so no later node proceeds either.
export function layout_node_precheck(actor: ControlledActor, layout_node: { layout_id: number, index: number } | undefined, entity_name: string, position: Position, direction: number | undefined) {
  if (layout_node === undefined) return undefined
  const record = storage.sgluna_construction_layouts?.[layout_node.layout_id]
  if (!record) return `construction layout ${layout_node.layout_id} is not recorded`
  if (record.state === 'paused') return `construction layout ${record.layout_id} is paused: ${record.pause_reason ?? 'unspecified'}`
  // The node is built where the actor stands now: a layout recorded on another actor, surface or force never continues here.
  if (actor.status_snapshot().actor_id !== record.actor_id || actor.surface.index !== record.surface_index || actor.force.index !== record.force_index) {
    const reason = `construction layout ${record.layout_id} belongs to actor ${record.actor_id} on surface ${record.surface_index} and force ${record.force_index}`
    pause(record, reason)
    return reason
  }
  const node = record_node(record, layout_node.index)
  if (!node) return `construction layout ${record.layout_id} has no node ${layout_node.index}`
  const facing = direction ?? 0
  if (node.state !== 'queued' || node.entity_name !== entity_name || node.direction !== facing
    || math.abs(node.position.x - position.x) > POSITION_EPSILON || math.abs(node.position.y - position.y) > POSITION_EPSILON) {
    return `layout node ${node.node_id} no longer matches the queued placement`
  }
  const footprint = planned_placement_footprint(entity_name, position.x, position.y, facing)
  if (!footprint) return `layout node ${node.node_id} has no footprint to check its connections against`
  for (const connection of record.connections) {
    if (connection.state !== 'pending' || !involves(record, connection, node)) continue
    const views: Record<string, EndpointView | undefined> = {}
    for (const role of roles_of(connection)) {
      const endpoint = connection.endpoints[role]
      if (endpoint.slot !== undefined) {
        const other = node_of(record, endpoint)!
        if (other.index === node.index) {
          views[role] = planned_view(entity_name, footprint)
        }
        else if (other.state === 'placed') {
          const entity = live_node_entity(actor, other)
          if (!entity) return `layout node ${other.node_id} is no longer available to check connection ${connection.index}`
          views[role] = entity_view(entity)
        }
        continue
      }
      const view = resolve_existing_view(actor, endpoint.unit_number!)
      if (view === undefined) return `connection ${connection.index}: ${role} ${endpoint.unit_number} is no longer an existing entity of this surface and force`
      views[role] = view
    }
    const proof = prove_connection(connection, views)
    if (proof.status === 'mismatch') {
      connection.state = 'mismatch'
      connection.observed = proof.predicted
      const reason = `connection ${connection.index} (${connection.kind}): ${proof.reason}`
      pause(record, reason)
      return reason
    }
    if (proof.status === 'unproven') {
      const reason = `connection ${connection.index} (${connection.kind}) cannot be proved: ${proof.reason}`
      pause(record, reason)
      return reason
    }
  }
  return undefined
}

function target_unit(entity: LuaEntity, field: string) {
  return protected_read(() => (entity as any)[field]?.unit_number as number | undefined)
}

// The entity an inserter or drill acts on: its native target field once the engine has set it, else the one entity standing
// on its native pickup/drop point that allows this direction of automated access: an item interface (an inventory or a
// transport line) whose prototype flags do not forbid it (itself and characters excluded). On 2.0.77 a burner inserter's
// pickup_target and drop_target are still nil on the tick it is built, while its pickup_position/drop_position are native at
// once. Any other occupant (a wall, a pole, a cargo landing pad as a drop) is never taken for the target: it is reported as
// `ignored`, and a point holding only such occupants verifies nothing.
function acting_unit(entity: LuaEntity, target_field: string, point_field: string, access: ItemAccess): { unit_number?: number, source: string, point?: Position, ignored?: number[] } {
  const target = target_unit(entity, target_field)
  if (target !== undefined) return { unit_number: target, source: 'target_field' }
  const point = read_point(entity, point_field)
  if (point === undefined) return { source: 'point_unreadable' }
  const found = protected_read(() => find_world_entities(entity.surface, { position: point })) ?? []
  const units: number[] = []
  const ignored: number[] = []
  for (const other of found) {
    if (!other.valid || other.unit_number === undefined || other.unit_number === entity.unit_number || other.type === 'character') continue
    if (entity_item_access(other, access) === 'allowed') units.push(other.unit_number)
    else ignored.push(other.unit_number)
  }
  const seen = ignored.length > 0 ? { point, ignored } : { point }
  if (units.length === 1) return { unit_number: units[0], source: 'item_endpoint_at_point', ...seen }
  return { source: units.length === 0 ? 'no_item_endpoint_at_point' : 'several_item_endpoints_at_point', ...seen }
}

// The native check of one connection whose roles are all built: the entities' own target and network fields (an inserter's or
// drill's point when its target field is not set yet). Records what was observed; a connection holds only when the
// observation equals the expected endpoint.
function verify_native(connection: LayoutRecordConnection, entities: Record<string, LuaEntity>) {
  if (connection.kind === 'inserter') {
    const inserter = entities.inserter
    const pickup = acting_unit(inserter, 'pickup_target', 'pickup_position', 'take')
    const drop = acting_unit(inserter, 'drop_target', 'drop_position', 'give')
    const observed = {
      pickup_unit_number: pickup.unit_number,
      pickup_source: pickup.source,
      pickup_ignored: pickup.ignored,
      drop_unit_number: drop.unit_number,
      drop_source: drop.source,
      drop_ignored: drop.ignored,
    }
    const holds = observed.pickup_unit_number !== undefined && observed.pickup_unit_number === entities.pickup.unit_number
      && observed.drop_unit_number !== undefined && observed.drop_unit_number === entities.drop.unit_number
    return { holds, observed }
  }
  if (connection.kind === 'power') {
    const pole_network = protected_read(() => entities.pole.electric_network_id as number | undefined)
    const consumer_network = protected_read(() => entities.consumer.electric_network_id as number | undefined)
    const observed = { pole_electric_network_id: pole_network, consumer_electric_network_id: consumer_network }
    return { holds: typeof pole_network === 'number' && pole_network === consumer_network, observed }
  }
  if (connection.kind === 'drill_output') {
    const drop = acting_unit(entities.drill, 'drop_target', 'drop_position', 'give')
    const observed = { drop_unit_number: drop.unit_number, drop_source: drop.source, drop_ignored: drop.ignored }
    return { holds: observed.drop_unit_number !== undefined && observed.drop_unit_number === entities.receiver.unit_number, observed }
  }
  return { holds: false, observed: {} }
}

function settle_layout(record: LayoutRecord) {
  if (record.state === 'paused') return
  let placed = 0
  for (const node of record.nodes) {
    if (node.state === 'placed') placed++
  }
  if (placed < record.nodes.length) return
  for (const connection of record.connections) {
    if (connection.state !== 'verified') {
      pause(record, `connection ${connection.index} (${connection.kind}) was not verified after every node was placed`)
      return
    }
  }
  record.state = 'complete'
}

// Called right after a successful create_entity, before the task completes. Binds the placed unit_number to its node once (a
// second receipt for the node is ignored and counted, never rebinds), then verifies every connection of the node whose roles
// are all built, with the entities' native fields. A mismatch pauses the layout; the next node's precheck then refuses.
export function record_layout_node_placed(actor: ControlledActor, layout_node: { layout_id: number, index: number } | undefined, entity: LuaEntity) {
  if (layout_node === undefined) return
  const record = storage.sgluna_construction_layouts?.[layout_node.layout_id]
  if (!record) return
  const node = record_node(record, layout_node.index)
  if (!node) return
  if (node.state === 'placed') {
    record.duplicate_receipts += 1
    return
  }
  node.state = 'placed'
  node.unit_number = entity.unit_number
  node.placed_tick = game.tick

  for (const connection of record.connections) {
    if (connection.state !== 'pending' || !involves(record, connection, node)) continue
    const entities: Record<string, LuaEntity> = {}
    let missing: string | undefined
    let waiting = false
    for (const role of roles_of(connection)) {
      const endpoint = connection.endpoints[role]
      if (endpoint.slot !== undefined) {
        const other = node_of(record, endpoint)!
        if (other.index === node.index) entities[role] = entity
        else if (other.state !== 'placed') waiting = true
        else {
          const live = live_node_entity(actor, other)
          if (live) entities[role] = live
          else missing = `${role} ${other.node_id} is no longer available`
        }
        continue
      }
      const view = resolve_existing_view(actor, endpoint.unit_number!)
      if (view?.entity) entities[role] = view.entity
      else missing = `${role} ${endpoint.unit_number} is no longer an existing entity of this surface and force`
    }
    if (missing !== undefined) {
      connection.state = 'mismatch'
      connection.observed = { unavailable: missing }
      pause(record, `connection ${connection.index} (${connection.kind}): ${missing}`)
      continue
    }
    if (waiting) continue
    const verified = verify_native(connection, entities)
    connection.observed = verified.observed
    connection.state = verified.holds ? 'verified' : 'mismatch'
    if (!verified.holds) pause(record, `connection ${connection.index} (${connection.kind}) does not hold on the placed entities`)
  }
  settle_layout(record)
}

// A queued node of a layout failed or was refused: the layout cannot continue by itself. Keeps the first reason.
export function layout_node_failed(layout_node: { layout_id: number, index: number } | undefined, code: string) {
  if (layout_node === undefined) return
  const record = storage.sgluna_construction_layouts?.[layout_node.layout_id]
  if (record) pause(record, `node ${layout_node.index} failed: ${code}`)
}
