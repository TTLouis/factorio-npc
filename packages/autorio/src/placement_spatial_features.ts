import type { LuaEntity, LuaFluidBox } from 'factorio:runtime'

const MAX_CANDIDATE_FLUID_PORTS = 16
const MAX_LIVE_FLUID_STORAGES = 8
const MAX_LIVE_PIPE_CONNECTIONS = 8

export interface CandidateFluidPort {
  storage_index: number
  connection_index: number
  production_type?: string
  filter?: string
  flow_direction?: string
  connection_type?: string
  position: { x: number, y: number }
  direction?: number
}

function finite_position(value: any) {
  return value
    && typeof value.x === 'number'
    && typeof value.y === 'number'
    && value.x === value.x
    && value.y === value.y
    && value.x !== math.huge
    && value.x !== -math.huge
    && value.y !== math.huge
    && value.y !== -math.huge
}

function cardinal_index(direction: number) {
  if (direction === 4) return 1
  if (direction === 8) return 2
  if (direction === 12) return 3
  return 0
}

function effective_direction(base: number | undefined, entity_direction: number) {
  if (typeof base !== 'number') return undefined
  return (base + entity_direction) % 16
}

/**
 * Build compact absolute fluid-port features for an unplaced candidate from
 * the running LuaEntityPrototype. PipeConnectionDefinition.positions already
 * contains the four cardinal-relative positions supplied by the current game
 * prototype, so this works for modded fluid entities without entity-name
 * special cases.
 */
export function candidate_fluid_ports(
  prototype: any,
  position: { x: number, y: number },
  direction: number,
): CandidateFluidPort[] | undefined {
  // Typed as arrays so TypeScriptToLua emits # and 1-based indexing; on an
  // untyped value `.length` compiled to a nil field and every live call
  // failed with "attempt to compare number with nil" (2.0.77).
  const fluidboxes: any[] = prototype?.fluidbox_prototypes ?? []
  const ports: CandidateFluidPort[] = []
  const direction_index = cardinal_index(direction)

  for (let storage = 0; storage < fluidboxes.length; storage++) {
    const fluidbox = fluidboxes[storage]
    if (!fluidbox) continue
    const connections: any[] = fluidbox.pipe_connections ?? []
    for (let connection_index = 0; connection_index < connections.length; connection_index++) {
      if (ports.length >= MAX_CANDIDATE_FLUID_PORTS) return ports
      const connection = connections[connection_index]
      const positions: any[] | undefined = connection?.positions
      const relative = positions?.[direction_index] ?? positions?.[0]
      if (!finite_position(relative)) continue
      ports.push({
        storage_index: fluidbox.index ?? storage + 1,
        connection_index: connection_index + 1,
        production_type: fluidbox.production_type,
        filter: fluidbox.filter?.name,
        flow_direction: connection.flow_direction,
        connection_type: connection.connection_type,
        position: {
          x: position.x + relative.x,
          y: position.y + relative.y,
        },
        direction: effective_direction(connection.direction, direction),
      })
    }
  }

  return ports.length > 0 ? ports : undefined
}

export interface LiveFluidPort {
  storage_index: number
  // 1-based position in the live connection listing of that storage.
  connection_index: number
  // The entity own edge tile that carries the connection.
  position: { x: number, y: number }
  // The tile the connection opens onto: where a joining entity must have its own port.
  target_position: { x: number, y: number }
  filter?: string
  flow_direction?: string
  connection_type?: string
  connected: boolean
}

function position_xy(raw: any): { x: number, y: number } | undefined {
  if (!finite_position(raw)) return undefined
  return { x: raw.x, y: raw.y }
}

function storage_filter_name(fluidbox: LuaFluidBox, index: number): string | undefined {
  const value: any = fluidbox.get_prototype(index)
  if (!value) return undefined
  const values: any[] = value.production_type ? [value] : value
  for (const prototype of values) {
    const name = prototype?.filter?.name
    if (typeof name === 'string') return name
  }
  return undefined
}

/**
 * The open and connected normal fluid ports of a placed entity, read from its
 * live fluidbox. Underground and linked connections do not open onto an adjacent
 * tile and are left out.
 */
export function live_fluid_ports(entity: LuaEntity): LiveFluidPort[] {
  const fluidbox = entity.fluidbox
  const storages = math.min(fluidbox.length, MAX_LIVE_FLUID_STORAGES)
  const ports: LiveFluidPort[] = []
  for (let index = 1; index <= storages; index++) {
    const connections: any[] = fluidbox.get_pipe_connections(index) ?? []
    const count = math.min(connections.length, MAX_LIVE_PIPE_CONNECTIONS)
    for (let connection_index = 0; connection_index < count; connection_index++) {
      const connection = connections[connection_index]
      if (connection.connection_type !== undefined && connection.connection_type !== 'normal') continue
      const position = position_xy(connection.position)
      const target_position = position_xy(connection.target_position)
      if (position === undefined || target_position === undefined) continue
      ports.push({
        storage_index: index,
        connection_index: connection_index + 1,
        position,
        target_position,
        filter: storage_filter_name(fluidbox, index),
        flow_direction: connection.flow_direction,
        connection_type: connection.connection_type,
        connected: connection.target !== undefined,
      })
    }
  }
  return ports
}

// Preservation cannot borrow a clipped or filtered placement-helper listing as
// proof that a port is absent. Keep the existing placement helper permissive;
// expose completeness separately for the strict pre-admission certificate.
export function complete_live_fluid_ports(entity: LuaEntity) {
  if (entity.fluidbox.length > MAX_LIVE_FLUID_STORAGES) return { complete: false, ports: [] as LiveFluidPort[] }
  let expected = 0
  for (let index = 1; index <= entity.fluidbox.length; index++) {
    const connections: any[] = entity.fluidbox.get_pipe_connections(index) ?? []
    if (connections.length > MAX_LIVE_PIPE_CONNECTIONS) return { complete: false, ports: [] as LiveFluidPort[] }
    for (const connection of connections) {
      if (connection.connection_type !== 'normal' || !finite_position(connection.position) || !finite_position(connection.target_position)) {
        return { complete: false, ports: [] as LiveFluidPort[] }
      }
      expected += 1
    }
  }
  const ports = live_fluid_ports(entity)
  return { complete: ports.length === expected, ports }
}

const PORT_TILE_TOLERANCE = 0.001

function same_tile(left: { x: number, y: number }, right: { x: number, y: number }) {
  return math.abs(left.x - right.x) <= PORT_TILE_TOLERANCE && math.abs(left.y - right.y) <= PORT_TILE_TOLERANCE
}

function direction_vector(direction: number | undefined): { x: number, y: number } | undefined {
  if (direction === 0) return { x: 0, y: -1 }
  if (direction === 4) return { x: 1, y: 0 }
  if (direction === 8) return { x: 0, y: 1 }
  if (direction === 12) return { x: -1, y: 0 }
  return undefined
}

/**
 * True when a candidate port would join a live port: the candidate port sits on
 * the tile the live port opens onto, faces back at the live entity own tile, and
 * the two fluidboxes are compatible (a different pinned fluid, or two ports that
 * are both input or both output, never connect). Derived only from the live
 * fluidbox and the prototype fluidbox connections.
 */
export function fluid_ports_join(live: LiveFluidPort, candidate: CandidateFluidPort): boolean {
  const facing = direction_vector(candidate.direction)
  if (facing === undefined) return false
  if (!same_tile(candidate.position, live.target_position)) return false
  if (!same_tile({ x: candidate.position.x + facing.x, y: candidate.position.y + facing.y }, live.position)) return false
  if (live.filter !== undefined && candidate.filter !== undefined && live.filter !== candidate.filter) return false
  if (live.flow_direction === 'input' && candidate.flow_direction === 'input') return false
  if (live.flow_direction === 'output' && candidate.flow_direction === 'output') return false
  return true
}
