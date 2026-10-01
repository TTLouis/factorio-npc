import type { LuaEntity } from 'factorio:runtime'

/**
 * Who last touched an entity, as the engine records it (`LuaEntity.last_user`:
 * the last PLAYER who built, configured or rotated it).
 *
 * The standalone NPC character is not a LuaPlayer and its placements pass no
 * `player` to create_entity, so an NPC-built entity reports no last_user until a
 * human changes it. A human last_user is therefore the signal for "a player
 * built or reconfigured this" (MW1 protected assets). Entities with no recorded
 * user (map generation, scripts, the NPC) report nothing.
 */
export interface EntityLastUser {
  name: string
  index: number
}

export function entity_last_user(entity: LuaEntity | undefined): EntityLastUser | undefined {
  if (!entity || !entity.valid) return undefined
  const user = entity.last_user
  if (!user || !user.valid) return undefined
  return { name: user.name, index: user.index }
}
