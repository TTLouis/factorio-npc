import type { MapPositionStruct } from 'factorio:prototype'
import type { LuaEntity, LuaForce, LuaInventory, LuaPlayer, LuaSurface } from 'factorio:runtime'

export type ActorMiningState = LuaPlayer['mining_state']
export type ActorWalkingState = LuaPlayer['walking_state']
export type ActorShootingState = LuaPlayer['shooting_state']

export interface ActorCraftingQueueItem {
  index: number
  recipe: string
  count: number
  prerequisite: boolean
}

/**
 * Arguments to spread into `LuaSurface.create_entity` so a placed entity is
 * attributed to this actor's identity rather than to whichever LuaPlayer
 * happened to be passed around.
 */
export interface ActorEntityBuildArgs {
  force: LuaForce
  player?: LuaPlayer
}

export interface ActorStatusSnapshot {
  kind: string
  valid: boolean
  name: string
  npc_id?: string
  position: MapPositionStruct
  has_character: boolean
  actor_id?: number
  selected_entity?: {
    name: string
    position: MapPositionStruct
  }
  mining_state?: ActorMiningState
  mining_progress?: number
}

/**
 * The physical actor SGLuna's control logic drives. `ConnectedPlayerActor`
 * wraps today's single connected LuaPlayer unchanged; a standalone actor
 * wraps an owned `character` entity with no LuaPlayer behind it at all.
 * Nothing in control.ts should depend directly on LuaPlayer once migration
 * is complete.
 */
export interface ControlledActor {
  readonly is_valid: boolean
  readonly character: LuaEntity | undefined
  readonly surface: LuaSurface
  readonly force: LuaForce
  readonly position: MapPositionStruct

  get_main_inventory: () => LuaInventory | undefined
  update_selected_entity: (position: MapPositionStruct) => void

  get_mining_state: () => ActorMiningState
  set_mining_state: (state: ActorMiningState) => void

  set_walking_state: (state: ActorWalkingState) => void
  set_shooting_state: (state: ActorShootingState) => void

  get_craftable_count: (recipe: string) => number
  begin_crafting: (params: { count: number, recipe: string }) => number
  cancel_crafting: (params: { index: number, count: number }) => void
  get_crafting_queue: () => ActorCraftingQueueItem[]
  get_crafting_queue_count: (recipe: string) => number

  /**
   * Whether a LuaPlayer-sourced event originated from this actor. Standalone
   * characters have no LuaPlayer and therefore always return false.
   */
  owns_player_index: (player_index: number) => boolean

  entity_build_args: () => ActorEntityBuildArgs

  status_snapshot: () => ActorStatusSnapshot
}