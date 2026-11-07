import type { LuaEntity, PipeConnection } from 'factorio:runtime'

export type HydraulicState = 'open' | 'joined' | 'separate' | 'unknown'

// PipeConnection targets describe geometric adjacency in 2.1, including joins
// that the engine separated to prevent mixing. A segment ID is a current read,
// never a durable identity: adding/removing a pipe may renumber the segment.
export function fluid_storage_constraint(entity: LuaEntity, index: number) {
  try {
    if (!entity.valid || index < 1 || index > entity.fluids_count) return undefined
    const has_segment = entity.has_fluid_segment(index)
    const segment = has_segment ? entity.get_fluid_segment_id(index) : undefined
    if (has_segment && (typeof segment !== 'number' || segment !== segment || segment < 0 || segment >= math.huge)) return undefined
    const filter = (has_segment ? entity.get_fluid_segment_filter(index) : entity.get_fluid_filter(index))?.name
    const fluid = (has_segment ? entity.get_fluid_segment_fluid(index) : entity.get_fluid(index))?.name
    if (filter !== undefined && fluid !== undefined && filter !== fluid) return undefined
    return { segment, fluid: fluid ?? filter }
  }
  catch { return undefined }
}

// Call only after the existing visibility fence permits reading the target.
// Missing native telemetry is unknown, not an open/disconnected port.
export function fluid_connection_state(entity: LuaEntity, index: number, connection: PipeConnection): HydraulicState {
  const target = connection.target
  if (target === undefined) return 'open'
  const target_index = connection.target_fluidbox_index
  if (!target.valid || target_index === undefined || target.surface.index !== entity.surface.index) return 'unknown'
  const own = fluid_storage_constraint(entity, index)
  const other = fluid_storage_constraint(target, target_index)
  if (!own || !other) return 'unknown'
  if (own.fluid !== undefined && other.fluid !== undefined && own.fluid !== other.fluid) return 'separate'
  if (own.segment !== undefined && other.segment !== undefined) return own.segment === other.segment ? 'joined' : 'separate'
  // Some native machine ports (for example boiler output) are not segments.
  // Their reciprocal external edge can transfer the constrained fluid without
  // sharing a segment ID. Do not extrapolate through the machine's other ports.
  if (own.fluid === undefined && other.fluid === undefined) return 'unknown'
  try {
    const reverse = target.get_fluid_box_pipe_connections(target_index)
    if (!reverse || reverse.length > 64) return 'unknown'
    return reverse.some(port => port.target === entity && port.target_fluidbox_index === index) ? 'joined' : 'unknown'
  }
  catch { return 'unknown' }
}
