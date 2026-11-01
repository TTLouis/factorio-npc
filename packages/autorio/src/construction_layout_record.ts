import type { PlacementPoint } from './placement_geometry'

// The stored form of a construction layout and the part of its lifecycle that needs no engine reads: the executions that built
// it and how a closed execution is settled. Kept free of runtime imports so the operation admission ledger can read and settle
// a layout without pulling the placement stack into its import graph.

// A fixed total number of executions per layout: the first one and every resume of its proven remainder. Persisted on the
// record at creation; nothing resets it.
export const LAYOUT_EXECUTIONS_MAX = 3

// Pause reasons a settlement writes itself. A reason set by an event (a failed node, a connection that does not hold when it
// is built) is never replaced by one of these.
export const REMAINDER_UNPLACED = 'remainder_unplaced'
export const COMPLETED_NODE_MISSING = 'completed_node_missing'
export const RETAINED_NODE_CHANGED = 'retained_node_changed'
export const CONNECTION_NO_LONGER_VERIFIED = 'connection_no_longer_verified'

const POSITION_EPSILON = 0.001

export interface LayoutEndpointRef {
  slot?: string
  unit_number?: number
}

export interface LayoutNode {
  node_id: string
  index: number
  slot?: string
  entity_name: string
  position: PlacementPoint
  direction: number
  execution_rank: number
  /**
   * queued: a task of the current execution will build it. placed: bound to the entity it built. not_placed: its execution
   * ended without building it (settled; a resume may queue it again). missing: it was placed and its entity is gone.
   */
  state: 'queued' | 'placed' | 'not_placed' | 'missing'
  unit_number?: number
  placed_tick?: number
  /** What the built entity reported when it was bound: a retained node is only kept while its entity still reports these. */
  placed_position?: PlacementPoint
  placed_direction?: number
}

export interface LayoutRecordConnection {
  index: number
  kind: string
  endpoints: Record<string, LayoutEndpointRef>
  state: 'pending' | 'verified' | 'mismatch'
  observed?: Record<string, unknown>
}

// One run of the layout's placement tasks, identified by the task batch they were queued into.
export interface LayoutExecution {
  /** 1 for the first execution, then one more for each resume. */
  number: number
  batch_id?: number
  batch_generation?: number
  batch_ref?: string
  queued_tick: number
  /** Node indices this execution queued, in execution order. */
  queued_nodes: number[]
  /** Set once the execution ended: which of its nodes were placed, which were not, and which were placed and are gone. */
  settled?: { tick: number, placed: number[], not_placed: number[], missing?: number[] }
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
  executions_used: number
  executions_max: number
  executions: LayoutExecution[]
  /** Set by a settlement that could read the game: a retained node or verified connection that no longer holds. */
  retained_problem?: string
}

export interface BatchIdentity {
  batch_id: number
  batch_generation: number
  batch_ref: string
}

// The part of an engine entity a retained node is compared with.
export interface RetainedEntityFacts {
  name: string
  position: PlacementPoint
  direction?: number
}

export function current_execution(record: LayoutRecord): LayoutExecution | undefined {
  const executions = record.executions
  return executions !== undefined && executions.length > 0 ? executions[executions.length - 1] : undefined
}

// Whether an execution's placement tasks may still be running: it is unsettled and the task batch they were queued into is
// the one open now. An execution that never learned its batch (every task closed while it was being queued) is not pending.
export function execution_pending(execution: LayoutExecution, active_batch: BatchIdentity | undefined) {
  if (execution.settled !== undefined) return false
  if (active_batch === undefined || execution.batch_ref === undefined) return false
  return execution.batch_ref === active_batch.batch_ref
    && execution.batch_id === active_batch.batch_id
    && execution.batch_generation === active_batch.batch_generation
}

// Whether a placed node's entity no longer is what was built: another prototype, moved, or turned. Compared with the facts the
// entity reported when it was bound (the planned ones for a record that predates them); a direction that cannot be read is
// not compared.
export function retained_node_changed(node: LayoutNode, entity: RetainedEntityFacts) {
  if (entity.name !== node.entity_name) return true
  const position = node.placed_position ?? node.position
  if (math.abs(entity.position.x - position.x) > POSITION_EPSILON || math.abs(entity.position.y - position.y) > POSITION_EPSILON) return true
  const direction = node.placed_direction ?? node.direction
  return entity.direction !== undefined && entity.direction !== direction
}

// Whether a reason is one a settlement wrote itself (and may therefore rewrite).
export function settlement_owned_reason(reason: string | undefined) {
  return reason === undefined || reason === REMAINDER_UNPLACED || reason.startsWith(COMPLETED_NODE_MISSING)
    || reason.startsWith(RETAINED_NODE_CHANGED) || reason.startsWith(CONNECTION_NO_LONGER_VERIFIED)
}

// Settles a finished execution from the record, and from the game when `resolve` can read the entity a node was bound to.
// Placing a node binds its unit_number in the same call as create_entity, so a node of this execution that is still queued was
// not built by it: it becomes not_placed. A bound node whose entity can no longer be read becomes missing. Idempotent: an
// execution is settled once.
export function settle_execution(record: LayoutRecord, execution: LayoutExecution, tick: number, resolve?: (node: LayoutNode) => RetainedEntityFacts | undefined) {
  if (execution.settled !== undefined) return execution.settled
  const placed: number[] = []
  const not_placed: number[] = []
  const missing: number[] = []
  for (const index of execution.queued_nodes) {
    const node = record.nodes[index]
    if (node === undefined) continue
    if (node.state === 'queued') node.state = 'not_placed'
    if (node.state === 'placed' && resolve !== undefined && resolve(node) === undefined) node.state = 'missing'
    if (node.state === 'not_placed') not_placed.push(index)
    else if (node.state === 'missing') missing.push(index)
    else placed.push(index)
  }
  execution.settled = missing.length > 0 ? { tick, placed, not_placed, missing } : { tick, placed, not_placed }
  return execution.settled
}

export function node_ids(record: LayoutRecord, indices: number[]) {
  const ids: string[] = []
  for (const index of indices) {
    const node = record.nodes[index]
    if (node !== undefined) ids.push(node.node_id)
  }
  return ids
}
