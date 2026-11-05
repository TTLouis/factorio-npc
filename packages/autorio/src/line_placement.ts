import type { BoundingBox, LuaEntity, LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { OperationAdmission } from './operation_admission'
import type { TaskBatchIdentity, TaskBatchReceipt } from './task_manager'
import { reservation_intersection } from './area_reservations'
import { resolve_recorded_entity } from './entity_reference'
import { find_world_entities } from './npc_vision'
import { placement_item_preflight, planned_placement_footprint } from './placement_preflight'

// Bounded straight-line placement for the external harness: one admitted operation places a run of transport belts or a
// line of small electric poles, one native placement task per tile, in order. Nothing here clears, replaces or teleports:
//   submit     every tile is checked first (the strict preflight below), then one placing task per tile is queued with
//              refuse_clearance and a line_node; a refusal returns before any task is queued, so it changed nothing.
//   execute    the placing runtime walks into build reach as for any placement, steps aside when the actor itself stands in
//              the tile (interaction_recovery), re-checks the external footprint rule just before create_entity
//              (line_node_precheck) and records the created entity on the line in the same tick (record_line_node_placed).
//   stop       the first refused tile is recorded (line_node_failed) and the task manager cancels the remaining tiles.
//   settle     the admission journal seals a cancelled line batch as exact partial work from this record and the batch receipt
//              (terminal_line_placement_settlement): the tiles placed, the tiles not placed and the first refusal.
// Only the external bridge calls this; the internal planner catalog does not expose it.

export const LINE_PLACEMENT_PROTOTYPES = ['transport-belt', 'small-electric-pole']
export const LINE_PLACEMENT_LIMITS = { count: 32, spacing: 8, history: 32, blockers: 8, coordinate: 1000000 }
// The external footprint rule, mirrored from the bridge's FOOTPRINT_RULE_LUA (tools/external-harness/native-bridge.mjs):
// any non-resource entity in the footprint blocks, including items on the ground and characters; 129 or more entities is
// too dense to inspect. A source parity test keeps the two definitions equal.
export const EXTERNAL_FOOTPRINT_SCAN_LIMIT = 129
const DIRECTIONS = [0, 4, 8, 12]

export interface LineNode { line_id: number, index: number }
export interface LineBlocker { name: string, type: string, position: { x: number, y: number }, unit_number?: number, item?: string }
export interface LinePlacedEntity {
  index: number
  unit_number: number
  name: string
  position: { x: number, y: number }
  direction: number
  tick: number
}
export type LineSealedEntity = Pick<LinePlacedEntity, 'index' | 'unit_number' | 'position' | 'direction'>
export interface LineRefusal { index: number, code: string, blockers?: LineBlocker[], tick: number }
export interface LineRecord extends Partial<TaskBatchIdentity> {
  line_id: number
  actor_id: number
  surface_index: number
  force_index: number
  entity_name: string
  direction: number
  line_direction: number
  spacing: number
  count: number
  origin: { x: number, y: number }
  tick: number
  placed: LinePlacedEntity[]
  refusal?: LineRefusal
}
export interface LineArgs {
  entity_name: string
  x: number
  y: number
  direction: number
  line_direction: number
  count: number
  spacing: number
}

declare const storage: { sgluna_line_placements?: LineRecord[], sgluna_line_placement_next_id?: number }

function records() {
  storage.sgluna_line_placements ??= []
  return storage.sgluna_line_placements
}
function integer_in(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && value === math.floor(value) && value >= low && value <= high
}
function coordinate(value: unknown): value is number {
  return typeof value === 'number' && value === value && math.abs(value) <= LINE_PLACEMENT_LIMITS.coordinate
}

export function line_step(line_direction: number) {
  if (line_direction === 0) return { x: 0, y: -1 }
  if (line_direction === 4) return { x: 1, y: 0 }
  if (line_direction === 8) return { x: 0, y: 1 }
  return { x: -1, y: 0 }
}
export function line_tile(args: { x: number, y: number, line_direction: number, spacing: number }, index: number) {
  const step = line_step(args.line_direction)
  return { x: args.x + step.x * args.spacing * index, y: args.y + step.y * args.spacing * index }
}

// The arguments the bridge renders, checked again here; undefined when valid.
export function invalid_line_args(args: Partial<LineArgs> | undefined) {
  if (!args || typeof args !== 'object') return 'args'
  if (typeof args.entity_name !== 'string' || !LINE_PLACEMENT_PROTOTYPES.includes(args.entity_name)) return 'entity_name'
  if (!coordinate(args.x)) return 'x'
  if (!coordinate(args.y)) return 'y'
  if (!DIRECTIONS.includes(args.direction as number)) return 'direction'
  if (!DIRECTIONS.includes(args.line_direction as number)) return 'line_direction'
  if (!integer_in(args.count, 1, LINE_PLACEMENT_LIMITS.count)) return 'count'
  if (!integer_in(args.spacing, 1, LINE_PLACEMENT_LIMITS.spacing)) return 'spacing'
  return undefined
}

function blocker_summary(entity: LuaEntity): LineBlocker {
  const stack = entity.type === 'item-entity' ? entity.stack : undefined
  return {
    name: entity.name, type: entity.type, position: { x: entity.position.x, y: entity.position.y },
    ...(entity.unit_number !== undefined ? { unit_number: entity.unit_number } : {}),
    ...(stack !== undefined && stack.valid_for_read ? { item: stack.name } : {}),
  }
}

// The external footprint rule (see EXTERNAL_FOOTPRINT_SCAN_LIMIT): a refusal code and up to eight named blockers. The line
// preflight passes the actor's own character, which the placing runtime steps out of before each tile (trial 4r: a line
// starting where the previous one ended was refused for the actor standing on its own tile 0).
export function external_footprint(surface: LuaSurface, box: BoundingBox, own_character?: LuaEntity) {
  const found = find_world_entities(surface, { area: box, limit: EXTERNAL_FOOTPRINT_SCAN_LIMIT })
  if (found.length >= EXTERNAL_FOOTPRINT_SCAN_LIMIT) return { code: 'placement_footprint_dense', blockers: [] as LineBlocker[] }
  const blockers: LineBlocker[] = []
  for (const entity of found) {
    if (entity.valid && entity.type !== 'resource' && entity !== own_character && blockers.length < LINE_PLACEMENT_LIMITS.blockers) blockers.push(blocker_summary(entity))
  }
  return blockers.length > 0 ? { code: 'placement_footprint_occupied', blockers } : { code: undefined, blockers }
}

/**
 * The strict read-only preflight: every tile of the line must be placeable now, and the actor must hold every item the
 * line consumes. Per tile: the native footprint centre is the requested one (exact grid), no NPC reservation, the manual
 * can_place_entity check, and the external footprint rule. The first failing tile is named; nothing is changed.
 */
export function line_placement_preflight(actor: ControlledActor | undefined, args: Partial<LineArgs> | undefined) {
  const field = invalid_line_args(args)
  if (field !== undefined) return { ok: false, code: 'invalid_line_args', field }
  const line = args as LineArgs
  const item = placement_item_preflight(actor, line.entity_name) as any
  if (item.ok !== true && item.code !== 'placement_item_missing') return item
  const requirement = item.placement_item
  if (!requirement || typeof requirement.count !== 'number' || typeof requirement.held_count !== 'number') return { ok: false, code: 'placement_item_unreadable' }
  const required = requirement.count * line.count
  const placement_item = { item_name: requirement.item_name, count: requirement.count, held_count: requirement.held_count, required_count: required }
  if (requirement.held_count < required) {
    return { ok: false, code: 'line_placement_items_insufficient', placement_item, shortfall: required - requirement.held_count }
  }
  const witness = item.preservation_nonfluid_output
  if (!witness || witness.fluid_port_count !== 0 || witness.entity_name !== line.entity_name) return { ok: false, code: 'nonfluid_footprint_unproven' }
  const surface = actor!.surface
  const tiles: { index: number, position: { x: number, y: number }, world_box: BoundingBox }[] = []
  for (let index = 0; index < line.count; index++) {
    const tile = line_tile(line, index)
    const footprint = planned_placement_footprint(line.entity_name, tile.x, tile.y, line.direction)
    if (!footprint) return { ok: false, code: 'invalid_line_args', field: 'x', tile_index: index }
    const planned_footprint = { position: footprint.position, world_box: footprint.world_box }
    if (footprint.position.x !== tile.x || footprint.position.y !== tile.y) {
      return { ok: false, code: 'exact_grid_required', tile_index: index, planned_footprint }
    }
    if (reservation_intersection(surface, footprint.world_box) !== undefined) return { ok: false, code: 'npc_area_reserved', tile_index: index, planned_footprint }
    if (!surface.can_place_entity({ name: line.entity_name, position: footprint.position, direction: line.direction,
      force: actor!.force, build_check_type: defines.build_check_type.manual })) {
      return { ok: false, code: 'placement_not_clear', tile_index: index, planned_footprint }
    }
    const checked = external_footprint(surface, footprint.world_box, actor!.character)
    if (checked.code !== undefined) return { ok: false, code: checked.code, tile_index: index, blockers: checked.blockers, planned_footprint }
    tiles.push({ index, position: footprint.position, world_box: footprint.world_box })
  }
  return { ok: true, operation: 'place_line', placement_item, preservation_nonfluid_output: witness, tiles }
}

export interface LineSubmitDeps {
  submit_placement: (entity_name: string, x: number, y: number, direction: number, options: { refuse_clearance: true, line_node: LineNode }) => boolean
  cancel_all_tasks: (reason: string) => unknown
  status: () => { queue_length: number, task_state: string, active_batch?: TaskBatchIdentity & { task_count: number } }
}

/**
 * Validate-then-queue: a refusal is returned as [false, code] before any task is queued (the admission journal's
 * pre-mutation proof), and success queues exactly `count` placing tasks in one fresh batch whose identity the line record
 * keeps. A queueing failure after the first task cancels what was queued and returns a refusal that is not pre-mutation.
 */
export function submit_line_placement(actor: ControlledActor | undefined, args: Partial<LineArgs>, deps: LineSubmitDeps): [boolean, string | number] {
  if (!actor || !actor.is_valid) return [false, 'no_actor']
  const before = deps.status()
  if (before.queue_length !== 0 || before.active_batch !== undefined || before.task_state !== 'idle') return [false, 'line_placement_requires_idle_queue']
  const preflight = line_placement_preflight(actor, args) as { ok: boolean, code?: string, tile_index?: number }
  if (preflight.ok !== true) return [false, `${preflight.code ?? 'line_placement_refused'}${preflight.tile_index !== undefined ? `@${preflight.tile_index}` : ''}`]
  const line = args as LineArgs
  const actor_id = actor.status_snapshot().actor_id
  if (actor_id === undefined) return [false, 'no_actor']
  const line_id = (storage.sgluna_line_placement_next_id ?? 0) + 1
  storage.sgluna_line_placement_next_id = line_id
  const record: LineRecord = {
    line_id, actor_id, surface_index: actor.surface.index, force_index: actor.force.index,
    entity_name: line.entity_name, direction: line.direction, line_direction: line.line_direction, spacing: line.spacing,
    count: line.count, origin: { x: line.x, y: line.y }, tick: game.tick, placed: [],
  }
  const list = records()
  list.push(record)
  while (list.length > LINE_PLACEMENT_LIMITS.history) list.shift()
  for (let index = 0; index < line.count; index++) {
    const tile = line_tile(line, index)
    if (!deps.submit_placement(line.entity_name, tile.x, tile.y, line.direction, { refuse_clearance: true, line_node: { line_id, index } })) {
      deps.cancel_all_tasks('line_placement_queue_failed')
      list.splice(list.indexOf(record), 1)
      return [false, `line_placement_queue_failed@${index}`]
    }
  }
  const batch = deps.status().active_batch
  if (!batch || batch.task_count !== line.count) {
    deps.cancel_all_tasks('line_placement_batch_unbound')
    list.splice(list.indexOf(record), 1)
    return [false, 'line_placement_batch_unbound']
  }
  record.batch_id = batch.batch_id
  record.batch_generation = batch.batch_generation
  record.batch_ref = batch.batch_ref
  return [true, line_id]
}

export function line_record(line_id: number | undefined) {
  if (line_id === undefined) return undefined
  return records().find(record => record.line_id === line_id)
}
export function line_record_for_batch(ref: TaskBatchIdentity) {
  const matches = records().filter(record => record.batch_ref === ref.batch_ref && record.batch_id === ref.batch_id
    && record.batch_generation === ref.batch_generation)
  return matches.length === 1 ? matches[0] : undefined
}

// Execution-time re-check just before create_entity, for a line node only: the node is the one recorded, and the external
// footprint rule still holds (the actor has already stepped out of the tile; anything else there refuses).
export function line_node_precheck(actor: ControlledActor, line_node: LineNode | undefined, entity_name: string, position: { x: number, y: number }, direction: number | undefined, world_box: BoundingBox) {
  if (line_node === undefined) return undefined
  const record = line_record(line_node.line_id)
  if (!record || record.actor_id !== actor.status_snapshot().actor_id || record.surface_index !== actor.surface.index
    || record.force_index !== actor.force.index || record.entity_name !== entity_name || (direction ?? 0) !== record.direction
    || !integer_in(line_node.index, 0, record.count - 1)) return { code: 'line_node_unproven' as const, blockers: [] as LineBlocker[] }
  const tile = line_tile({ x: record.origin.x, y: record.origin.y, line_direction: record.line_direction, spacing: record.spacing }, line_node.index)
  if (tile.x !== position.x || tile.y !== position.y) return { code: 'line_node_unproven' as const, blockers: [] as LineBlocker[] }
  const checked = external_footprint(actor.surface, world_box)
  if (checked.code !== undefined) return { code: checked.code as 'placement_footprint_occupied' | 'placement_footprint_dense', blockers: checked.blockers }
  return undefined
}

// Whether the actor's own character stands in a line node's footprint: the native check accepts a belt under a character,
// but the external rule does not, so the placing runtime steps aside first instead of refusing the tile.
export function line_node_actor_in_footprint(actor: ControlledActor, line_node: LineNode | undefined, entity_name: string, position: { x: number, y: number }, direction: number | undefined) {
  if (line_node === undefined || !actor.character) return false
  const footprint = planned_placement_footprint(entity_name, position.x, position.y, direction)
  if (!footprint) return false
  return find_world_entities(actor.surface, { area: footprint.world_box, type: 'character', limit: 16 })
    .some(entity => entity === actor.character)
}
// The axis a line runs along, so stepping aside prefers the perpendicular sides instead of a later tile of the same line.
export function line_node_axis(line_node: LineNode | undefined): 'x' | 'y' | undefined {
  const record = line_record(line_node?.line_id)
  if (!record) return undefined
  return record.line_direction === 4 || record.line_direction === 12 ? 'x' : 'y'
}

export function record_line_node_placed(line_node: LineNode | undefined, entity: LuaEntity) {
  if (line_node === undefined || entity.unit_number === undefined) return
  const record = line_record(line_node.line_id)
  if (!record || record.placed.some(row => row.index === line_node.index)) return
  record.placed.push({ index: line_node.index, unit_number: entity.unit_number, name: entity.name,
    position: { x: entity.position.x, y: entity.position.y }, direction: entity.direction, tick: game.tick })
}

// The first refused tile is kept; the task manager cancels the remaining tiles.
export function line_node_failed(line_node: LineNode | undefined, code: string, blockers?: LineBlocker[]) {
  if (line_node === undefined) return
  const record = line_record(line_node.line_id)
  if (!record || record.refusal !== undefined) return
  record.refusal = { index: line_node.index, code: code.slice(0, 80), tick: game.tick,
    ...(blockers !== undefined && blockers.length > 0 ? { blockers: blockers.slice(0, LINE_PLACEMENT_LIMITS.blockers) } : {}) }
}

export interface LinePlacementSettlement {
  line_id: number
  entity_name: string
  count: number
  placed: LineSealedEntity[]
  missing_indexes: number[]
  not_placed_indexes: number[]
  refusal?: LineRefusal
  receipt: {
    batch_ref: string
    batch_id: number
    batch_generation: number
    state: string
    reason?: string
    tick: number
    task_count: number
    tasks_started: number
    started_count: number
    task_types: string[]
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && value > 0 && value <= 9007199254740990 && value === math.floor(value)
}

/**
 * A single place_line admission whose batch the engine cancelled before every tile was placed (a tile refused at execution,
 * or the harness cancelled it), matched to the line record by the exact batch identity it was queued under. Tasks run in
 * order, so the placed tiles are exactly a prefix of the line no longer than the tasks started; each is re-read (a placed
 * entity that can no longer be read is missing). Undefined unless every link is exact: generation, actor and surface, one slot
 * with one batch reference, one cancelled receipt of placing tasks only (as many as the slot queued and the line holds), no
 * refusals. A first-tile refusal before any change never gets here: the journal proves it a refusal first.
 */
export function terminal_line_placement_settlement(record: OperationAdmission, status: { receipt_journal: TaskBatchReceipt[], batch_generation: number }): LinePlacementSettlement | undefined {
  if (!positive(record.generation) || record.generation !== status.batch_generation || !positive(record.actor_id)
    || record.operation_count !== 1 || record.slots.length !== 1) return undefined
  const slot = record.slots[0]
  if (!slot.ok || slot.index !== 1 || slot.operation !== 'place_line' || !positive(slot.queued_tasks) || slot.batch_refs.length !== 1) return undefined
  const ref = slot.batch_refs[0]
  if (!positive(ref.batch_id) || ref.batch_generation !== record.generation || ref.batch_ref !== `batch-g${ref.batch_generation}-${ref.batch_id}`) return undefined
  if (!Array.isArray(status.receipt_journal)) return undefined
  const matches = status.receipt_journal.filter(row => row.batch_ref === ref.batch_ref
    || row.batch_id === ref.batch_id && row.batch_generation === ref.batch_generation)
  if (matches.length !== 1) return undefined
  const receipt = matches[0]
  if (receipt.batch_ref !== ref.batch_ref || receipt.batch_id !== ref.batch_id || receipt.batch_generation !== ref.batch_generation
    || receipt.state !== 'cancelled' || receipt.task_count !== slot.queued_tasks
    || !Array.isArray(receipt.task_types) || receipt.task_types.length !== receipt.task_count || !receipt.task_types.every(type => type === 'placing')
    || !positive(receipt.tasks_started) || receipt.tasks_started > receipt.task_count
    || !positive(receipt.started_count) || receipt.started_count < receipt.tasks_started
    || typeof receipt.tick !== 'number' || receipt.tick < record.tick
    || receipt.outcome !== undefined || receipt.refused_count || (receipt.refusals?.length ?? 0) > 0) return undefined
  const line = line_record_for_batch(ref)
  if (!line || line.actor_id !== record.actor_id || line.count !== slot.queued_tasks
    || (record.surface_index !== undefined && line.surface_index !== record.surface_index)) return undefined
  const placed = [...line.placed].sort((a, b) => a.index - b.index)
  if (placed.length > receipt.tasks_started || !placed.every((row, position) => row.index === position)) return undefined
  const standing: LineSealedEntity[] = []
  const missing_indexes: number[] = []
  for (const row of placed) {
    const entity = resolve_recorded_entity(row.unit_number, line.surface_index, line.force_index)
    // The sealed row keeps only what identifies the entity, to keep the admission journal small.
    if (entity !== undefined && entity.name === row.name) standing.push({ index: row.index, unit_number: row.unit_number, position: { ...row.position }, direction: row.direction })
    else missing_indexes.push(row.index)
  }
  const not_placed_indexes: number[] = []
  for (let index = placed.length; index < line.count; index++) not_placed_indexes.push(index)
  return {
    line_id: line.line_id, entity_name: line.entity_name, count: line.count, placed: standing, missing_indexes, not_placed_indexes,
    ...(line.refusal !== undefined ? { refusal: line.refusal } : {}),
    receipt: {
      batch_ref: receipt.batch_ref, batch_id: receipt.batch_id, batch_generation: receipt.batch_generation, state: receipt.state,
      reason: typeof receipt.reason === 'string' ? receipt.reason.slice(0, 128) : undefined, tick: receipt.tick,
      task_count: receipt.task_count, tasks_started: receipt.tasks_started, started_count: receipt.started_count, task_types: receipt.task_types.slice(0, 64),
    },
  }
}

// Read-only, for the bridge receipt: the line record the exact batch identity queued.
export function line_placement_status(batch_ref: string | undefined) {
  if (typeof batch_ref !== 'string') return { ok: false, code: 'invalid_batch_ref' }
  const matches = records().filter(record => record.batch_ref === batch_ref)
  if (matches.length !== 1) return { ok: false, code: matches.length === 0 ? 'line_not_recorded' : 'line_ambiguous' }
  const line = matches[0]
  return { ok: true, line: { ...line, placed: line.placed.map(row => ({ ...row, position: { ...row.position } })) } }
}
