import type { LuaEntity, LuaPlayer } from 'factorio:runtime'

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

// Entities that never carry a build/configure record: ghosts and item-request proxies are bookkeeping, not player work,
// and reading last_user on them can throw. They report no last_user without touching the property.
const NO_LAST_USER_TYPES = ['entity-ghost', 'tile-ghost', 'item-request-proxy']

function read_last_user(entity: LuaEntity): LuaPlayer | undefined {
  // In the game the read is protected, so an entity kind that does not support last_user yields nothing instead of
  // aborting an operation. Outside the game (vitest) there is no pcall and the plain read is used.
  if (typeof pcall === 'function') {
    const [ok, value] = pcall(() => entity.last_user)
    if (!ok) return undefined
    return value as LuaPlayer | undefined
  }
  return entity.last_user
}

export function entity_last_user(entity: LuaEntity | undefined): EntityLastUser | undefined {
  if (!entity || !entity.valid) return undefined
  if (NO_LAST_USER_TYPES.includes(entity.type)) return undefined
  const user = read_last_user(entity)
  if (!user || !user.valid) return undefined
  return { name: user.name, index: user.index }
}
