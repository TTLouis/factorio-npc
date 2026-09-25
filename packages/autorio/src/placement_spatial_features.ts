const MAX_CANDIDATE_FLUID_PORTS = 16

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
