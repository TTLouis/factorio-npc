import type { LuaPlayer, OnBuiltEntityEvent, OnRobotBuiltEntityEvent, OnPlayerBuiltTileEvent, OnRobotBuiltTileEvent } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { designer_input, designer_returned, player_area_action, reservation_intersection, reservation_build_conflict, reservation_preflight, reservation_status, reserve_area, restore_area, RESERVED_TILE, validate_area_reservation, type AreaProposal } from './area_reservations'

const WINDOW = 'sgluna_area_reservations'
let runtime_idle = () => false
export function show_area_reservations(player: LuaPlayer) {
  const old = player.gui.screen[WINDOW]
  if (old?.valid) old.destroy()
  const frame = player.gui.screen.add({ type: 'frame', name: WINDOW, caption: 'NPC reserved spaces', direction: 'vertical' })
  frame.auto_center = true
  const modes = frame.add({ type: 'flow' })
  modes.add({ type: 'label', caption: `Reservation mode: ${reservation_status().mode}` })
  for (const action of ['auto', 'review']) modes.add({ type: 'button', caption: action === 'auto' ? 'Full auto' : 'Review first', tags: { reservation_action: action } })
  for (const row of reservation_status().reservations) {
    if (row.force_index !== undefined && row.force_index !== player.force.index) continue
    const line = frame.add({ type: 'flow' })
    line.add({ type: 'label', caption: `#${row.id}: ${row.state}${row.reason ? ` (${row.reason})` : ''}` })
    if (row.state === 'awaiting_review') for (const action of ['blueprint', 'approve', 'reject']) line.add({ type: 'button', caption: action,
      tags: { reservation_action: action, reservation_id: row.id, reservation_revision: row.revision } })
    if (['reserved', 'conflict', 'backing_up', 'restoring'].includes(row.state)) line.add({ type: 'button', caption: 'Reverse reservation',
      tags: { reservation_action: 'reverse', reservation_id: row.id, reservation_revision: row.revision } })
  }
  frame.add({ type: 'button', caption: 'Close', tags: { reservation_action: 'close' } })
}

export function area_reservation_click(event: any, actor?: ControlledActor) {
  const element = event.element
  const action = element?.valid ? element.tags?.reservation_action : undefined
  if (typeof action !== 'string' || element.player_index !== event.player_index) return false
  const player = game.get_player(event.player_index)
  if (!player?.valid) return true
  if (action === 'close') { player.gui.screen[WINDOW]?.destroy(); return true }
  if (['approve', 'reverse'].includes(action) && !runtime_idle()) { player.print('NPC space: waiting for the current NPC action to finish.'); return true }
  const result = player_area_action(player.index, action, element.tags.reservation_id, element.tags.reservation_revision, actor)
  if (!result.ok) player.print(`NPC space: ${result.code}`)
  show_area_reservations(player)
  return true
}

export function register_area_reservations(get_actor: () => ControlledActor | undefined, idle: () => boolean) {
  runtime_idle = idle
  remote.add_interface('autorio_reservations', {
    validate: (request: AreaProposal) => idle() ? validate_area_reservation(get_actor(), request) : { ok: false, code: 'actor_busy' },
    preflight: (id: number, revision: number) => idle() ? reservation_preflight(get_actor(), id, revision) : { ok: false, code: 'actor_busy' },
    reserve: (id: number, revision: number) => idle() ? reserve_area(get_actor(), id, revision) : { ok: false, code: 'actor_busy' },
    status: (id?: number) => reservation_status(id),
    // Trusted native UI/console integration, intentionally absent from every
    // model tool/operation catalog. RCON and other mods already own the world.
    player_control: (player_index: number, action: string, id?: number, revision?: number) =>
      ['approve', 'reverse'].includes(action) && !idle() ? { ok: false, code: 'actor_busy' } : player_area_action(player_index, action, id, revision, get_actor()),
    designer_input: (id: number, revision: number, offset?: number) => designer_input(id, revision, offset),
    // Explicit host/operator cancellation, never an inference tool. A reversal
    // can release a pending review but cannot approve it or release designer input.
    reverse: (id: number, revision: number) => idle() ? restore_area(id, revision, 'operator_reversed_reservation') : { ok: false, code: 'actor_busy' },
    designer_returned: (id: number, revision: number, design_id: string) => idle() ? designer_returned(id, revision, design_id) : { ok: false, code: 'actor_busy' },
  })
  // Review and reversal originate from a real player's native UI event. There
  // is deliberately no model-facing approve/mode-setting remote operation.
  if (typeof commands !== 'undefined') commands.add_command('npc-spaces', 'Review or reverse NPC reserved spaces.', event => {
    const player = event.player_index === undefined ? undefined : game.get_player(event.player_index)
    if (player?.valid) show_area_reservations(player)
  })
  const entity_built = (event: OnBuiltEntityEvent | OnRobotBuiltEntityEvent) => {
    const entity = event.entity
    if (!entity?.valid) return
    const id = reservation_intersection(entity.surface, entity.bounding_box)
    if (id === undefined) return
    // Ghosts have no physical inventory to lose. Normal builds are refused by
    // tile collision and NPC preflight. Preserve any exceptional real intrusion
    // as a restore conflict rather than reconstructing a lossy item refund.
    if (entity.type === 'entity-ghost' || entity.type === 'tile-ghost') entity.destroy({ raise_destroy: false })
    else reservation_build_conflict(id)
  }
  for (const event of [defines.events.on_built_entity, defines.events.on_robot_built_entity]) if (typeof event === 'number') script.on_event(event, entity_built)
  const tiles_built = (event: OnPlayerBuiltTileEvent | OnRobotBuiltTileEvent) => {
    let refunded = 0
    const surface = game.get_surface(event.surface_index)
    if (!surface) return
    for (const tile of event.tiles ?? []) {
      const p = tile.position
      if (!reservation_intersection(surface, { left_top: p, right_bottom: { x: p.x + 1, y: p.y + 1 } })) continue
      surface.set_tiles([{ name: RESERVED_TILE, position: p }], false, false, false); refunded++
    }
    if (refunded > 0 && event.item) {
      const player_index = (event as OnPlayerBuiltTileEvent).player_index
      const robot = (event as OnRobotBuiltTileEvent).robot
      const player = player_index === undefined ? undefined : game.get_player(player_index)
      const stack = { name: event.item.name, quality: event.quality?.name, count: refunded }
      const count = event.inventory?.valid ? event.inventory.insert(stack) : player ? player.insert(stack)
        : robot?.valid ? robot.get_inventory(defines.inventory.robot_cargo)?.insert(stack) ?? 0 : 0
      if (count < refunded) surface.spill_item_stack({ position: event.tiles[0].position, stack: { ...stack, count: refunded - count }, enable_looted: true })
    }
  }
  for (const event of [defines.events.on_player_built_tile, defines.events.on_robot_built_tile]) if (typeof event === 'number') script.on_event(event, tiles_built)
}
