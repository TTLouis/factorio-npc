import type { LuaSurface } from 'factorio:runtime'
import type { ControlledActor } from './types'
import { ConnectedPlayerActor } from './connected_player_actor'
import { StandaloneCharacterActor } from './standalone_character_actor'

export type ActorMode = 'player' | 'npc'

export interface NpcRecoveryReceipt {
  reason: 'missing_persisted_actor'
  previous_actor_id: number
  replacement_actor_id: number
  force_index: number
  tick: number
  inventory_policy: 'no_transfer'
}

interface OwnedCraftingMarker {
  actor_id: number
  actor_kind: string
  force_index: number
  item_name: string
  requested_count: number
  started_tick: number
}

interface OwnedCraftingLoadReceipt {
  actor_id: number
  item_name: string
  requested_count: number
  cancelled_queue_count: number
}

type NpcRecoveryHandler = (event: { previous_actor_id: number }) => void
type ActorModeTransitionHandler = (event: { previous_mode: ActorMode, next_mode: ActorMode }) => void

declare const storage: {
  airi_actor_mode?: ActorMode
  standalone_character_unit_number?: number
  airi_last_npc_recovery?: NpcRecoveryReceipt
  airi_owned_crafting?: OwnedCraftingMarker
  // Surface the NPC body was last seen alive on; a replacement body respawns
  // there, at (0, 0), rather than always on Nauvis.
  airi_npc_surface_index?: number
}

const RESPAWN_POSITION = { x: 0, y: 0 }

function npc_home_surface(): LuaSurface | undefined {
  const index = storage.airi_npc_surface_index
  if (index !== undefined) {
    const surface = game.get_surface(index as LuaSurface['index'])
    if (surface !== undefined && surface.valid) return surface
  }
  return game.surfaces[1]
}

function remember_npc_surface(actor: StandaloneCharacterActor) {
  const index = actor.surface.index
  if (storage.airi_npc_surface_index !== index) storage.airi_npc_surface_index = index
}

let standalone_actor: StandaloneCharacterActor | undefined
let post_load_reconciliation_pending = false
let last_reconciled_actor_id: number | undefined
let last_reconciled_tick: number | undefined
let last_reconciled_owned_crafting: OwnedCraftingLoadReceipt | undefined
let npc_recovery_handler: NpcRecoveryHandler | undefined
let actor_mode_transition_handler: ActorModeTransitionHandler | undefined
let recovery_invalidated_actor_id: number | undefined

// Factorio does not persist ordinary Lua module locals across save/load. Autorio's
// logical task manager is therefore intentionally volatile for now, while the
// standalone character entity and its engine control states are persisted in the
// save. on_load cannot access `game` or mutate `storage`, so it only restores
// module-local caches here.
//
// This handler runs on every peer that loads the map, including a client joining
// a running server, so the flag it sets is NOT by itself permission to change
// game state. See `maybe_reconcile_loaded_npc`.
script.on_load(() => {
  standalone_actor = undefined
  post_load_reconciliation_pending = true
  last_reconciled_actor_id = undefined
  last_reconciled_tick = undefined
  last_reconciled_owned_crafting = undefined
  recovery_invalidated_actor_id = undefined
})

export function get_actor_mode(): ActorMode {
  return storage.airi_actor_mode ?? 'player'
}

export function set_actor_mode(mode: ActorMode): ActorMode {
  const previous_mode = get_actor_mode()
  if (previous_mode !== mode) {
    // The transition handler runs while the previous mode is still active so
    // cleanup can stop/cancel work on the actor that actually owned it. Only
    // after cleanup do we select the new actor mode.
    actor_mode_transition_handler?.({ previous_mode, next_mode: mode })
  }
  storage.airi_actor_mode = mode
  standalone_actor = undefined
  recovery_invalidated_actor_id = undefined
  return mode
}

export function register_npc_recovery_handler(handler: NpcRecoveryHandler | undefined) {
  npc_recovery_handler = handler
}

export function register_actor_mode_transition_handler(handler: ActorModeTransitionHandler | undefined) {
  actor_mode_transition_handler = handler
}

function get_player_actor(): ControlledActor | undefined {
  const player = game.connected_players[0]
  if (!player) {
    return undefined
  }
  return new ConnectedPlayerActor(player)
}

function reconcile_owned_crafting_after_load(actor: StandaloneCharacterActor) {
  const marker = storage.airi_owned_crafting
  if (!marker) {
    return undefined
  }

  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined
    || marker.actor_id !== identity.actor_id
    || marker.actor_kind !== identity.kind
    || marker.force_index !== actor.force.index) {
    return undefined
  }

  // The logical task that owned this native queue was module-local and is gone
  // after load. Admission was allowed only from an empty native queue, so every
  // remaining queue entry belongs to that persisted request. Cancel from the
  // tail to avoid leaving orphaned prerequisite/target crafts running.
  const queue = actor.get_crafting_queue()
  let cancelled_queue_count = 0
  for (let i = queue.length - 1; i >= 0; i--) {
    const item = queue[i]
    if (!item) {
      continue
    }
    actor.cancel_crafting({ index: item.index, count: item.count })
    cancelled_queue_count += item.count
  }

  storage.airi_owned_crafting = undefined
  const receipt: OwnedCraftingLoadReceipt = {
    actor_id: identity.actor_id,
    item_name: marker.item_name,
    requested_count: marker.requested_count,
    cancelled_queue_count,
  }
  log(`[AUTORIO] Reconciled persisted owned crafting for actor_id=${identity.actor_id}: ${marker.item_name}, cancelled_queue_count=${cancelled_queue_count}`)
  return receipt
}

function reconcile_loaded_npc(actor: StandaloneCharacterActor) {
  // Logical Autorio tasks are not resumed across a save/load boundary. Clear
  // the engine-owned physical inputs that *are* serialized with the character,
  // otherwise a freshly loaded NPC could keep walking/mining/shooting with no
  // task left to own or stop that action. Owned native crafting gets the same
  // treatment, but only when a persisted ownership marker proves Autorio owned
  // the queue before the save.
  last_reconciled_owned_crafting = reconcile_owned_crafting_after_load(actor)
  actor.set_walking_state({ walking: false, direction: defines.direction.north })
  actor.set_mining_state({ mining: false })
  actor.set_shooting_state({ state: defines.shooting.not_shooting, position: actor.position })
  rendering.clear()

  const identity = actor.status_snapshot()
  last_reconciled_actor_id = identity.actor_id
  last_reconciled_tick = game.tick
  post_load_reconciliation_pending = false
  log(`[AUTORIO] Reconciled loaded NPC controls for actor_id=${identity.actor_id ?? 'unknown'}`)
}

/**
 * Automatic post-load reconciliation, for single-player only.
 *
 * `script.on_load` runs on every peer that loads the map, but the server ran it
 * once at its own load and has already cleared the flag. Acting on that
 * module-local flag therefore changes synchronized game state on one peer only:
 * a joining client stops the NPC walking while the server keeps walking it, and
 * the next tick fails its CRC check. Multiplayer must reconcile from a
 * replicated trigger instead — see `reconcile_npc_after_load`.
 */
function maybe_reconcile_loaded_npc(actor: StandaloneCharacterActor) {
  if (!post_load_reconciliation_pending) {
    return
  }
  if (game.is_multiplayer()) {
    return
  }
  reconcile_loaded_npc(actor)
}

function invalidate_missing_npc(previous_actor_id: number) {
  if (recovery_invalidated_actor_id === previous_actor_id) {
    return
  }

  // The old entity is already invalid/missing, so task invalidation must not try
  // to resolve an actor in order to stop its controls. Doing so would recurse
  // back into replacement creation. The task manager registers a logical-only
  // invalidation handler for this boundary.
  recovery_invalidated_actor_id = previous_actor_id
  npc_recovery_handler?.({ previous_actor_id })
  if (storage.airi_owned_crafting?.actor_id === previous_actor_id) {
    // The dead/missing body took its native queue with it. Drop the marker so a
    // replacement body can never inherit or cancel work it did not own.
    storage.airi_owned_crafting = undefined
  }
  rendering.clear()
  log(`[AUTORIO] Invalidated work owned by missing NPC actor_id=${previous_actor_id}`)
}

function record_npc_recovery(previous_actor_id: number, actor: StandaloneCharacterActor) {
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) {
    return
  }

  storage.airi_last_npc_recovery = {
    reason: 'missing_persisted_actor',
    previous_actor_id,
    replacement_actor_id: identity.actor_id,
    force_index: actor.force.index,
    tick: game.tick,
    inventory_policy: 'no_transfer',
  }
  recovery_invalidated_actor_id = undefined
  log(`[AUTORIO] Recovered standalone NPC actor_id=${previous_actor_id} -> ${identity.actor_id} without inventory transfer`)
}

function get_npc_actor(): ControlledActor | undefined {
  if (standalone_actor?.is_valid) {
    remember_npc_surface(standalone_actor)
    maybe_reconcile_loaded_npc(standalone_actor)
    return standalone_actor
  }

  const surface = npc_home_surface()
  const force = game.forces.player
  if (!surface || !force) {
    return undefined
  }

  const persisted_actor_id = storage.standalone_character_unit_number
  standalone_actor = StandaloneCharacterActor.reacquire(surface)
  if (standalone_actor?.is_valid) {
    recovery_invalidated_actor_id = undefined
    remember_npc_surface(standalone_actor)
    maybe_reconcile_loaded_npc(standalone_actor)
    return standalone_actor
  }

  if (persisted_actor_id !== undefined) {
    invalidate_missing_npc(persisted_actor_id)
  }

  // Respawn at (0, 0) of the surface the body was last alive on.
  const spawn_position = RESPAWN_POSITION
  // With zero human players ever connecting, nothing else ever triggers chunk
  // generation around spawn: normally a joining client's position does that.
  // Creating the NPC really only needs the local spawn neighborhood. The old
  // radius=3 request synchronously generated up to a 7x7 chunk square here,
  // which could freeze the simulation during a cold standalone-NPC launch.
  // A radius=1 (3x3) window is enough for the 32-tile collision search below
  // and matches the awareness bubble that will continue generation afterwards.
  if (!surface.is_chunk_generated({ x: Math.floor(spawn_position.x / 32), y: Math.floor(spawn_position.y / 32) })) {
    surface.request_to_generate_chunks(spawn_position, 1)
    surface.force_generate_chunk_requests()
  }
  const position = surface.find_non_colliding_position('character', spawn_position, 32, 0.5) ?? spawn_position
  standalone_actor = StandaloneCharacterActor.create(surface, force, position)
  if (standalone_actor?.is_valid) {
    remember_npc_surface(standalone_actor)
    if (persisted_actor_id !== undefined) {
      record_npc_recovery(persisted_actor_id, standalone_actor)
    }
    maybe_reconcile_loaded_npc(standalone_actor)
  }
  return standalone_actor
}

export function get_controlled_actor(): ControlledActor | undefined {
  if (get_actor_mode() === 'npc') {
    return get_npc_actor()
  }
  return get_player_actor()
}

/**
 * Read-only actor lookup for rendering and diagnostics.
 *
 * GUI code runs on every multiplayer peer, so it must never create a body, run
 * post-load reconciliation or write `storage`. `get_controlled_actor` does all
 * three, and a joining client calling it stops the NPC's walking state locally
 * while the server keeps walking, which desyncs the game.
 */
export function peek_controlled_actor(): ControlledActor | undefined {
  if (get_actor_mode() !== 'npc') {
    return get_player_actor()
  }
  if (standalone_actor?.is_valid) {
    return standalone_actor
  }
  const surface = npc_home_surface()
  return surface !== undefined ? StandaloneCharacterActor.peek(surface) : undefined
}

export interface NpcLoadReconciliationResult {
  reconciled: boolean
  reason: 'reconciled' | 'actor_mode_is_player' | 'no_persisted_npc_body'
  actor_id?: number
  tick: number
}

/**
 * Replicated post-load reconciliation.
 *
 * The supervisor issues this over RCON once the server has loaded the save.
 * Factorio replicates an RCON command to every connected peer as a single input
 * action, so each peer runs this at the same tick against the same `storage` and
 * reaches the same result — unlike the `on_load` flag, which is set per peer.
 *
 * Only ever stops controls, so repeating it is safe.
 */
export function reconcile_npc_after_load(): NpcLoadReconciliationResult {
  if (get_actor_mode() !== 'npc') {
    post_load_reconciliation_pending = false
    return { reconciled: false, reason: 'actor_mode_is_player', tick: game.tick }
  }

  const surface = npc_home_surface()
  const actor = standalone_actor?.is_valid
    ? standalone_actor
    : surface !== undefined
      ? StandaloneCharacterActor.reacquire(surface)
      : undefined
  if (!actor?.is_valid) {
    // Nothing persisted means no stale engine control state to stop. Creating a
    // body here would make an explicit repair command spawn an NPC.
    post_load_reconciliation_pending = false
    return { reconciled: false, reason: 'no_persisted_npc_body', tick: game.tick }
  }

  standalone_actor = actor
  reconcile_loaded_npc(actor)
  return {
    reconciled: true,
    reason: 'reconciled',
    actor_id: actor.status_snapshot().actor_id,
    tick: game.tick,
  }
}

export function get_load_reconciliation_status() {
  return {
    policy: 'discard_autorio_tasks_and_stop_npc_controls_on_load',
    owned_crafting_policy: 'cancel_persisted_autorio_owned_native_queue_on_load',
    // Single-player resolves this lazily; multiplayer only ever reconciles from
    // the replicated `reconcile_after_load` call.
    trigger: 'lazy_in_single_player_replicated_remote_call_in_multiplayer',
    pending: post_load_reconciliation_pending,
    last_actor_id: last_reconciled_actor_id,
    last_tick: last_reconciled_tick,
    owned_crafting: last_reconciled_owned_crafting,
  }
}

export function get_npc_recovery_status() {
  return {
    policy: 'discard_autorio_tasks_and_create_empty_replacement',
    pending_from_actor_id: recovery_invalidated_actor_id,
    last_result: storage.airi_last_npc_recovery,
  }
}

export function create_actor_remote_interface() {
  remote.add_interface('autorio_actor', {
    get_mode: () => get_actor_mode(),
    set_mode: (mode: string) => {
      if (mode !== 'player' && mode !== 'npc') {
        return [false, `Invalid actor mode: ${mode}`]
      }

      set_actor_mode(mode)
      const actor = get_controlled_actor()
      return [true, actor?.status_snapshot()]
    },
    // Replicated repair entry point: safe to call on a live multiplayer server
    // because every peer executes the same RCON input action at the same tick.
    reconcile_after_load: () => reconcile_npc_after_load(),
    status: () => {
      const actor = get_controlled_actor()
      return {
        mode: get_actor_mode(),
        actor: actor?.status_snapshot(),
        connected_players: game.connected_players.length,
        load_reconciliation: get_load_reconciliation_status(),
        death_recovery: get_npc_recovery_status(),
      }
    },
  })
}
