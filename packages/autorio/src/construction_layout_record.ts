import type { PlacementPoint } from './placement_geometry'

// The stored form of a construction layout and the part of its lifecycle that needs no engine reads: the executions that built
// it and how a closed execution is settled. Kept free of runtime imports so the operation admission ledger can read and settle
// a layout without pulling the placement stack into its import graph.

// A fixed total number of executions per layout: the first one and every resume of its proven remainder. Persisted on the
// record at creation; nothing resets it.
export const LAYOUT_EXECUTIONS_MAX = 3

// The pause reason a settlement writes when nodes remain unplaced; a reason set by an event (a failed node, a connection that
// does not hold) is never replaced by it.
export const REMAINDER_UNPLACED = 'remainder_unplaced'
export const COMPLETED_NODE_MISSING = 'completed_node_missing'

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
  /** Set once the execution ended: which of its nodes were placed and which were not. */
  settled?: { tick: number, placed: number[], not_placed: number[] }
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
}

export interface BatchIdentity {
  batch_id: number
  batch_generation: number
  batch_ref: string
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

// Settles a finished execution from the record alone. Placing a node binds its unit_number in the same call as create_entity,
// so a node of this execution that is still queued was not built by it: it becomes not_placed. Idempotent: an execution is
// settled once.
export function settle_execution(record: LayoutRecord, execution: LayoutExecution, tick: number) {
  if (execution.settled !== undefined) return execution.settled
  const placed: number[] = []
  const not_placed: number[] = []
  for (const index of execution.queued_nodes) {
    const node = record.nodes[index]
    if (node === undefined) continue
    if (node.state === 'queued') node.state = 'not_placed'
    if (node.state === 'not_placed') not_placed.push(index)
    else placed.push(index)
  }
  execution.settled = { tick, placed, not_placed }
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
