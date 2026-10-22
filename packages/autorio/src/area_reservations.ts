import type { LuaCustomChartTag, LuaEntity, LuaForce, LuaInventory, LuaItemStack, LuaRenderObject, LuaSurface, PlayerIndex } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import { is_chunk_known_visible } from './map_knowledge'
import { protected_read } from './electric_facts'
import { find_world_entities } from './npc_vision'

export const RESERVED_TILE = 'sgluna-reserved-area'
export const RESERVATION_LIMITS = { side: 32, entities: 64, active: 4, age: 3600 }
type Point = { x: number, y: number }
type Box = { left_top: Point, right_bottom: Point }
type Mode = 'auto' | 'review'
type State = 'validated' | 'awaiting_review' | 'backing_up' | 'reserved' | 'restoring' | 'restored' | 'rejected' | 'conflict'
export interface AreaProposal { goal_id: string, plan_id: string, x: number, y: number, width: number, height: number }
interface TileSnapshot { name: string, position: Point, hidden?: string, double_hidden?: string }
interface HeldEntity { source: LuaEntity, snapshot: string, active: boolean, backup?: LuaEntity, restored?: LuaEntity, original_id?: number }
interface Reservation {
  id: number, revision: number, mode: Mode, state: State, proposal: AreaProposal, box: Box,
  actor_id: number, force_index: number, force: LuaForce, surface: LuaSurface, tick: number,
  tiles: TileSnapshot[], entities: HeldEntity[], blueprint?: LuaInventory,
  tag?: LuaCustomChartTag, outline?: LuaRenderObject, vault?: LuaSurface,
  reason?: string, design_id?: string, identity_map?: { before?: number, after?: number }[],
}
declare const storage: { sgluna_area_reservations?: Reservation[], sgluna_next_area_reservation?: number, sgluna_area_mode?: Mode }

const MACHINE_NAMES = ['stone-furnace', 'steel-furnace', 'electric-furnace', 'assembling-machine-1', 'assembling-machine-2', 'assembling-machine-3']
const CHEST_NAMES = ['wooden-chest', 'iron-chest', 'steel-chest']
const NATURAL_NAMES = ['tree-01', 'tree-02', 'tree-02-red', 'tree-03', 'tree-04', 'tree-05', 'tree-06', 'tree-06-brown', 'tree-07', 'tree-08', 'tree-08-brown', 'tree-08-red', 'tree-09', 'tree-09-brown', 'tree-09-red', 'dead-dry-hairy-tree', 'dead-grey-trunk', 'dead-tree-desert', 'dry-hairy-tree', 'dry-tree', 'huge-rock', 'big-rock', 'big-sand-rock', 'coal', 'iron-ore', 'copper-ore', 'stone', 'uranium-ore']
function records() { return storage.sgluna_area_reservations ?? (storage.sgluna_area_reservations = []) }
function held(id: number) { return records().find(row => row.id === id) }
function open(row: Reservation) { return row.state !== 'restored' && row.state !== 'rejected' }
function overlaps(a: Box, b: Box) { return a.left_top.x < b.right_bottom.x && a.right_bottom.x > b.left_top.x && a.left_top.y < b.right_bottom.y && a.right_bottom.y > b.left_top.y }
function contains(a: Box, b: Box) { return a.left_top.x <= b.left_top.x && a.left_top.y <= b.left_top.y && a.right_bottom.x >= b.right_bottom.x && a.right_bottom.y >= b.right_bottom.y }
function machine(entity: LuaEntity) { return MACHINE_NAMES.includes(entity.name) }
function trace(row: Reservation, reason: string) { log(`[AUTORIO] area_reservation ${helpers.table_to_json({ reservation_id: row.id, revision: row.revision, state: row.state, goal_id: row.proposal.goal_id, plan_id: row.proposal.plan_id, reason, tick: game.tick })}`) }
function fail(code: string) { return { ok: false as const, code } }
function mode(): Mode { return storage.sgluna_area_mode === 'review' ? 'review' : 'auto' }

export function reservation_intersection(surface: LuaSurface, box: Box) {
  return records().find(row => open(row) && row.state !== 'validated' && row.state !== 'awaiting_review' && row.surface === surface && overlaps(row.box, box))?.id
}

// Explicit initial support with fail-closed native clone checks. Connections,
// mobile entities and unknown mod entities are refused before any cut.
function supported(entity: LuaEntity) {
  if (!NATURAL_NAMES.includes(entity.name) && !CHEST_NAMES.includes(entity.name) && !machine(entity)) return false
  if (!['tree', 'resource', 'simple-entity', 'container', 'furnace', 'assembling-machine'].includes(entity.type)) return false
  if (entity.get_control_behavior() !== undefined) return false
  const wires = entity.get_wire_connectors(false)
  if (wires !== undefined) for (const [, connector] of pairs(wires)) if (connector.connection_count > 0) return false
  if (machine(entity) && entity.is_connected_to_electric_network()) return false
  if (entity.fluidbox !== undefined) for (let i = 1; i <= entity.fluidbox.length; i++) {
    if (entity.fluidbox[i - 1] !== undefined || entity.fluidbox.get_pipe_connections(i).some(connection => connection.target !== undefined)) return false
  }
  return true
}

function stack_snapshot(stack: LuaItemStack) {
  if (!stack.valid_for_read) return ''
  if (stack.is_blueprint || stack.is_blueprint_book || stack.is_deconstruction_item || stack.is_upgrade_item) return stack.export_stack()
  // Native clone preserves these ordinary stacks. Containers/equipment, spoilage
  // and identity-bearing items need their own proven contract before escrow.
  if (!['item', 'ammo', 'module', 'capsule', 'tool', 'repair-tool', 'item-with-tags'].includes(stack.type)
    || (protected_read(() => stack.spoil_tick) ?? 0) > 0) throw new Error('reservation_item_not_roundtrippable')
  return helpers.table_to_json({ name: stack.name, count: stack.count, quality: stack.quality.name,
    health: stack.health, durability: protected_read(() => stack.durability), ammo: protected_read(() => stack.ammo),
    tags: stack.is_item_with_tags ? stack.tags : undefined,
    label: protected_read(() => stack.label), label_color: protected_read(() => stack.label_color),
    allow_manual_label_change: protected_read(() => stack.allow_manual_label_change) })
}

function entity_snapshot(entity: LuaEntity, active = entity.active) {
  const inventories: string[][] = []
  let slots = 0
  for (let index = 1; index <= entity.get_max_inventory_index(); index++) {
    const inventory = entity.get_inventory(index)
    const contents: string[] = []
    if (inventory !== undefined) {
      slots += inventory.length
      if (slots > 4096) throw new Error('reservation_inventory_too_large')
      for (let slot = 0; slot < inventory.length; slot++) {
        contents.push(stack_snapshot(inventory[slot]))
        if (inventory.supports_filters()) contents.push(helpers.table_to_json({ filter: inventory.get_filter(slot + 1) }))
      }
      if (inventory.supports_bar()) contents.push(String(inventory.get_bar()))
    }
    inventories.push(contents)
  }
  const fluids: unknown[] = []
  if (entity.fluidbox !== undefined) for (let i = 0; i < entity.fluidbox.length; i++) fluids.push(entity.fluidbox[i] ?? false)
  let recipe_name: string | undefined
  let recipe_quality: string | undefined
  if (machine(entity)) { const [recipe, quality] = entity.get_recipe(); recipe_name = recipe?.name; recipe_quality = quality?.name }
  return helpers.table_to_json({ name: entity.name, position: entity.position, direction: entity.direction,
    force: entity.force.index, quality: entity.quality.name, health: entity.health, active, inventories, fluids,
    energy: protected_read(() => entity.energy), temperature: protected_read(() => entity.temperature),
    flags: { minable: entity.minable, destructible: entity.destructible, operable: entity.operable, rotatable: entity.rotatable },
    last_user: entity.last_user?.index, orientation: protected_read(() => entity.orientation),
    graphics_variation: protected_read(() => entity.graphics_variation), color: protected_read(() => entity.color),
    amount: entity.type === 'resource' ? entity.amount : undefined,
    recipe: recipe_name, recipe_quality, progress: machine(entity) ? entity.crafting_progress : undefined,
    bonus: machine(entity) ? entity.bonus_progress : undefined,
    burner: entity.burner ? { fuel: entity.burner.currently_burning?.name.name, quality: entity.burner.currently_burning?.quality?.name,
      remaining: entity.burner.remaining_burning_fuel, heat: entity.burner.heat } : undefined,
  })
}

function capture(surface: LuaSurface, box: Box) {
  const tiles: TileSnapshot[] = []
  for (let x = box.left_top.x; x < box.right_bottom.x; x++) for (let y = box.left_top.y; y < box.right_bottom.y; y++) {
    const tile = surface.get_tile(x, y)
    if (tile.name === RESERVED_TILE || tile.name === 'out-of-map') return { ...fail('invalid_reservation_tile'), tiles, entities: [] as HeldEntity[] }
    tiles.push({ name: tile.name, position: { x, y }, hidden: tile.hidden_tile, double_hidden: tile.double_hidden_tile })
  }
  const entities: HeldEntity[] = []
  const found = find_world_entities(surface, { area: box, limit: RESERVATION_LIMITS.entities + 1 })
  if (found.length > RESERVATION_LIMITS.entities) return { ...fail('too_many_entities'), tiles, entities }
  for (const entity of found) {
    if (!contains(box, entity.bounding_box)) return { ...fail('entity_crosses_boundary'), tiles, entities }
    try {
      if (!supported(entity)) return { ...fail('entity_not_roundtrippable'), tiles, entities }
      const snapshot = entity_snapshot(entity)
      if (helpers.table_to_json({ kind: 'entity', original_unit_number: entity.unit_number, native_snapshot: snapshot }).length > 8000) return { ...fail('entity_snapshot_too_large'), tiles, entities }
      entities.push({ source: entity, snapshot, active: entity.active, original_id: entity.unit_number })
    }
    catch { return { ...fail('entity_state_not_roundtrippable'), tiles, entities } }
  }
  return { ok: true as const, code: 'ok', tiles, entities }
}

function same_tiles(row: Reservation) {
  return row.tiles.every(tile => { const now = row.surface.get_tile(tile.position); return now.name === tile.name && now.hidden_tile === tile.hidden && now.double_hidden_tile === tile.double_hidden })
}
function same_source(row: Reservation) {
  try {
    const current = find_world_entities(row.surface, { area: row.box })
    return same_tiles(row) && current.length === row.entities.length
      && row.entities.every(entity => entity.source.valid && current.includes(entity.source) && entity_snapshot(entity.source) === entity.snapshot)
  }
  catch { return false }
}
function retire_stale_proposals() {
  for (const row of records()) if (row.state === 'validated' && (row.mode !== mode() || !row.surface.valid
    || game.tick - row.tick > RESERVATION_LIMITS.age || !same_source(row))) {
    row.state = 'rejected'; row.reason = 'stale_validation_retired_without_world_mutation'; trace(row, row.reason)
  }
}
function remove_markers(row: Reservation) {
  if (row.tag?.valid) row.tag.destroy()
  if (row.outline?.valid) row.outline.destroy()
  if (row.blueprint?.valid) row.blueprint.destroy()
}
function summary(row: Reservation) {
  return { id: row.id, revision: row.revision, mode: row.mode, state: row.state, goal_id: row.proposal.goal_id, plan_id: row.proposal.plan_id,
    surface_index: row.surface.index, force_index: row.force_index, area: row.box, reason: row.reason, design_id: row.design_id,
    designer_ready: row.state === 'reserved', identity_map: row.identity_map,
    original_entity_count: row.entities.length, original_tile_count: row.tiles.length }
}
export function reservation_status(id?: number) {
  return { ok: true as const, mode: mode(), reservations: records().filter(row => id === undefined || row.id === id).map(summary) }
}

export function validate_area_reservation(actor: ControlledActor | undefined, request: AreaProposal) {
  retire_stale_proposals()
  if (!actor?.is_valid || actor.status_snapshot().actor_id === undefined) return fail('no_actor')
  if (!request || ![request.x, request.y, request.width, request.height].every(value => typeof value === 'number' && value === math.floor(value))
    || math.abs(request.x) > 1000000 || math.abs(request.y) > 1000000 || request.width < 2 || request.height < 2
    || request.width > RESERVATION_LIMITS.side || request.height > RESERVATION_LIMITS.side
    || ![request.goal_id, request.plan_id].every(value => typeof value === 'string' && value.length > 0 && value.length <= 200)) return fail('invalid_area_proposal')
  if (actor.surface.name.startsWith('sgluna-reservation-')) return fail('backup_surface_forbidden')
  if (records().filter(open).length >= RESERVATION_LIMITS.active) return fail('reservation_limit')
  const box = { left_top: { x: request.x, y: request.y }, right_bottom: { x: request.x + request.width, y: request.y + request.height } }
  if (records().some(row => open(row) && row.surface === actor.surface && overlaps(row.box, box))) return fail('area_already_reserved')
  for (let x = box.left_top.x; x < box.right_bottom.x; x += 1) for (let y = box.left_top.y; y < box.right_bottom.y; y += 1) {
    if ((x - actor.position.x) ** 2 + (y - actor.position.y) ** 2 > 64 ** 2
      || !is_chunk_known_visible(actor.force, actor.surface, { x: math.floor(x / 32), y: math.floor(y / 32) })) return fail('area_not_locally_visible')
  }
  const captured = capture(actor.surface, box)
  if (!captured.ok) return fail(captured.code)
  const id = (storage.sgluna_next_area_reservation ?? 0) + 1
  storage.sgluna_next_area_reservation = id
  const row: Reservation = { id, revision: 1, mode: mode(), state: 'validated', proposal: { ...request }, box,
    actor_id: actor.status_snapshot().actor_id!, force_index: actor.force.index, force: actor.force, surface: actor.surface, tick: game.tick,
    tiles: captured.tiles, entities: captured.entities }
  // Completed records never hold live backups. Keep history bounded.
  const retained = records().filter(open).concat(records().filter(row => !open(row)).slice(-28))
  retained.push(row); storage.sgluna_area_reservations = retained
  trace(row, 'validated_no_world_mutation')
  return { ok: true as const, reservation: summary(row), reservation_id: id, revision: row.revision }
}

function mark_review(row: Reservation) {
  const inventory = game.create_inventory(1)
  row.blueprint = inventory
  inventory[0].set_stack({ name: 'blueprint', count: 1 })
  const tiles = row.tiles.filter(tile => tile.position.x === row.box.left_top.x || tile.position.y === row.box.left_top.y
    || tile.position.x === row.box.right_bottom.x - 1 || tile.position.y === row.box.right_bottom.y - 1)
    // Non-placeable reservation tiles cannot be encoded by Factorio blueprints.
    // A vanilla stone-path perimeter is only a review artifact; the purple
    // native outline and map pin mark the unchanged live site.
    .map(tile => ({ name: 'stone-path', position: { x: tile.position.x - row.box.left_top.x, y: tile.position.y - row.box.left_top.y } }))
  inventory[0].set_blueprint_tiles(tiles)
  inventory[0].label = `NPC reserved site #${row.id} — review`
  row.outline = rendering.draw_rectangle({ color: { r: 0.65, g: 0.15, b: 1, a: 1 }, width: 4, filled: false, left_top: row.box.left_top,
    right_bottom: row.box.right_bottom, surface: row.surface, forces: [row.force], draw_on_ground: true })
  row.state = 'awaiting_review'
  trace(row, 'blueprint_outline_only_waiting_for_player')
}

function cut(row: Reservation) {
  if (!same_source(row)) return fail('reservation_snapshot_changed')
  row.state = 'backing_up'
  const settings = { ...row.surface.map_gen_settings, autoplace_controls: {}, default_enable_all_autoplace_controls: false,
    autoplace_settings: { tile: { treat_missing_as_default: false }, entity: { treat_missing_as_default: false }, decorative: { treat_missing_as_default: false } } }
  row.vault = game.create_surface(`sgluna-reservation-${row.id}`, settings)
  row.vault.freeze_daytime = true
  row.vault.set_tiles(row.tiles.map(tile => ({ name: tile.name, position: tile.position })), false, false, false)
  for (const entity of row.entities) {
    entity.backup = entity.source.clone({ position: entity.source.position, surface: row.vault, create_build_effect_smoke: false })
    const copied = entity.backup ? entity_snapshot(entity.backup) : undefined
    if (!entity.backup || copied !== entity.snapshot) {
      log(`[AUTORIO] reservation_clone_mismatch ${helpers.table_to_json({ reservation_id: row.id, name: entity.source.name, before: entity.snapshot.slice(0, 12000), after: copied?.slice(0, 12000) })}`)
      row.state = 'conflict'; row.reason = 'backup_verification_failed'; trace(row, row.reason); return fail(row.reason)
    }
    if (machine(entity.backup)) entity.backup.active = false
  }
  // A native clone hook must not silently change the world being cut.
  if (row.entities.some(entity => !entity.backup?.valid || entity_snapshot(entity.backup, entity.active) !== entity.snapshot
    || (machine(entity.backup) && entity.backup.active))) {
    row.state = 'conflict'; row.reason = 'backup_changed_during_copy'; return fail(row.reason)
  }
  if (!same_source(row)) { row.state = 'conflict'; row.reason = 'source_changed_during_backup'; return fail(row.reason) }
  for (const entity of row.entities) if (!entity.source.destroy({ raise_destroy: false })) {
    row.state = 'conflict'; row.reason = 'source_cut_incomplete'; trace(row, row.reason); return fail(row.reason)
  }
  row.surface.set_tiles(row.tiles.map(tile => ({ name: RESERVED_TILE, position: tile.position })), false, false, false)
  row.state = 'reserved'
  trace(row, 'native_backup_verified_area_reserved_designer_ready')
  return { ok: true as const, reservation: summary(row) }
}

export function reservation_preflight(actor: ControlledActor | undefined, id: number, revision: number) {
  retire_stale_proposals()
  const row = held(id)
  if (!actor?.is_valid || !row || row.revision !== revision || row.state !== 'validated' || row.mode !== mode()) return fail('stale_reservation')
  if (actor.surface !== row.surface || actor.force.index !== row.force_index || actor.status_snapshot().actor_id !== row.actor_id
    || game.tick - row.tick > RESERVATION_LIMITS.age || !same_source(row)) return fail('reservation_snapshot_changed')
  return { ok: true as const, reservation: summary(row) }
}

export function reserve_area(actor: ControlledActor | undefined, id: number, revision: number) {
  const checked = reservation_preflight(actor, id, revision)
  if (!checked.ok) return checked
  const row = held(id)!
  try {
    row.tag = actor!.force.add_chart_tag(row.surface, { position: { x: row.proposal.x + row.proposal.width / 2, y: row.proposal.y + row.proposal.height / 2 },
      text: `NPC reserved site #${row.id}${row.mode === 'review' ? ' — awaiting review' : ''}`, icon: { type: 'virtual', name: 'signal-info' } })
    if (row.mode === 'review') { mark_review(row); return { ok: true as const, reservation: summary(row) } }
  }
  catch {
    row.state = 'rejected'; row.reason = 'reservation_marker_creation_failed'; remove_markers(row); trace(row, row.reason); return fail(row.reason)
  }
  return safe_cut(row)
}

function safe_cut(row: Reservation) {
  try {
    const result = cut(row)
    if (result.ok) return result
    row.reason = result.code
  }
  catch { row.reason = 'native_reservation_error' }
  // Restore a partial cut immediately when possible; otherwise keep the journal
  // and vault intact, visibly conflicted, for a later non-destructive reverse.
  try { if (!restore_area(row.id, row.revision, 'failed_reservation_rolled_back').ok) row.state = 'conflict' }
  catch { row.state = 'conflict' }
  trace(row, row.reason ?? 'reservation_failed')
  return fail(row.reason ?? 'reservation_failed')
}

export function restore_area(id: number, revision: number, reason: string) {
  const row = held(id)
  if (!row || row.revision !== revision) return fail('stale_reservation')
  if (row.state === 'restored' || row.state === 'rejected') return { ok: true as const, reservation: summary(row) }
  if (row.state === 'awaiting_review' || row.state === 'validated') {
    row.state = 'rejected'; row.reason = reason; remove_markers(row); trace(row, reason); return { ok: true as const, reservation: summary(row) }
  }
  // Never clear a player's or another mod's intervening entity to make a restore fit.
  const owned = row.entities.flatMap(entity => [entity.source, entity.restored].filter((candidate): candidate is LuaEntity => candidate !== undefined && candidate.valid))
  if (find_world_entities(row.surface, { area: row.box }).some(entity => !owned.includes(entity))) {
    row.state = 'conflict'; row.reason = 'restore_area_occupied_backup_retained'; trace(row, row.reason); return fail(row.reason)
  }
  row.state = 'restoring'
  row.surface.set_tiles(row.tiles.map(tile => ({ name: tile.name, position: tile.position })), false, false, false)
  for (const tile of row.tiles) { row.surface.set_hidden_tile(tile.position, tile.hidden); row.surface.set_double_hidden_tile(tile.position, tile.double_hidden) }
  row.identity_map = []
  for (const entity of row.entities) {
    if (entity.source.valid) entity.restored = entity.source
    else if (!entity.restored?.valid) {
      if (!entity.backup?.valid) { row.state = 'conflict'; row.reason = 'backup_missing'; return fail(row.reason) }
      entity.restored = entity.backup.clone({ position: entity.backup.position, surface: row.surface, create_build_effect_smoke: false })
    }
    if (entity.restored && machine(entity.restored)) entity.restored.active = entity.active
    if (!entity.restored || entity_snapshot(entity.restored) !== entity.snapshot) {
      row.state = 'conflict'; row.reason = 'restore_verification_failed_backup_retained'; trace(row, row.reason); return fail(row.reason)
    }
    row.identity_map.push({ before: entity.original_id, after: entity.restored.unit_number })
  }
  const final_entities = find_world_entities(row.surface, { area: row.box })
  if (!same_tiles(row) || final_entities.length !== row.entities.length
    || row.entities.some(entity => !entity.restored?.valid || !final_entities.includes(entity.restored) || entity_snapshot(entity.restored) !== entity.snapshot)) {
    row.state = 'conflict'; row.reason = 'restore_final_boundary_mismatch_backup_retained'; trace(row, row.reason); return fail(row.reason)
  }
  row.state = 'restored'; row.reason = reason; remove_markers(row)
  if (row.vault?.valid) game.delete_surface(row.vault)
  trace(row, reason)
  return { ok: true as const, reservation: summary(row) }
}

// The designer is a separate future consumer. Its immutable handoff is only
// available after auto validation/cut or a real player's review approval.
export function designer_input(id: number, revision: number, offset = 0) {
  const row = held(id)
  if (!row || row.revision !== revision || row.state !== 'reserved') return fail('reservation_not_designer_ready')
  const all: unknown[] = row.tiles.map(tile => ({ kind: 'tile', ...tile }))
  for (const entity of row.entities) all.push({ kind: 'entity', original_unit_number: entity.original_id, native_snapshot: entity.snapshot })
  if (typeof offset !== 'number' || offset !== math.floor(offset) || offset < 0 || offset > all.length) return fail('invalid_snapshot_offset')
  const entries: unknown[] = []
  for (let index = offset; index < math.min(all.length, offset + 16); index++) {
    const candidate = entries.concat([all[index]])
    if (helpers.table_to_json(candidate).length > 8500) break
    entries.push(all[index])
  }
  return { ok: true as const, reservation: summary(row), offset, next_offset: offset + entries.length < all.length ? offset + entries.length : undefined,
    total_entries: all.length, entries }
}
export function designer_returned(id: number, revision: number, design_id: string) {
  const row = held(id)
  if (!row || row.state !== 'reserved' || row.revision !== revision || typeof design_id !== 'string' || !design_id.trim() || design_id.length > 200) return fail('stale_designer_result')
  const restored = restore_area(id, revision, 'designer_returned_originals_restored')
  if (restored.ok) row.design_id = design_id
  return restored
}

export function player_area_action(player_index: number, action: string, id?: number, revision?: number, actor?: ControlledActor) {
  if (typeof player_index !== 'number' || player_index !== math.floor(player_index) || player_index < 1 || player_index > 65536) return fail('player_required')
  const player = game.get_player(player_index as PlayerIndex)
  if (!player?.valid || player.controller_type === defines.controllers.spectator) return fail('player_required')
  if (action === 'auto' || action === 'review') {
    if (game.is_multiplayer() && !player.admin) return fail('admin_required')
    storage.sgluna_area_mode = action; return { ok: true as const, mode: mode() }
  }
  const row = id === undefined ? undefined : held(id)
  if (!row || player.force.index !== row.force_index || row.revision !== revision) return fail('stale_reservation')
  if (action === 'approve') {
    if (!actor?.is_valid || actor.surface !== row.surface || actor.status_snapshot().actor_id !== row.actor_id
      || row.state !== 'awaiting_review' || !same_source(row)) return fail('review_snapshot_changed')
    return safe_cut(row)
  }
  if (action === 'reverse' || action === 'reject') return restore_area(row.id, row.revision, 'player_reversed_reservation')
  if (action === 'blueprint' && row.blueprint?.valid) { player.add_to_clipboard(row.blueprint[0]); return { ok: true as const } }
  return fail('invalid_reservation_action')
}

export function reservation_blueprint(id: number) { return held(id)?.blueprint }
export function reservation_build_conflict(id: number) {
  const row = held(id)
  if (row && open(row)) { row.state = 'conflict'; row.reason = 'unexpected_native_build_preserved'; trace(row, row.reason) }
}
