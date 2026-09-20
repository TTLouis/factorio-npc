const INTERNAL_OBSERVATION_ENTITY_NAMES: Record<string, boolean> = {
  'airi-npc-awareness-radar': true,
}

export function is_internal_observation_entity_name(name: string | undefined) {
  return name !== undefined && INTERNAL_OBSERVATION_ENTITY_NAMES[name] === true
}

export function is_internal_observation_entity(entity: { name?: string } | undefined) {
  return entity !== undefined && is_internal_observation_entity_name(entity.name)
}
