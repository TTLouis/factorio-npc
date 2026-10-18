import type { LuaEntity } from 'factorio:runtime'
import type { ControlledActor } from './actors/types'
import type { PlayerParametersPreparePumpSite } from './types'
import { get_recent_fluid_source_observation, invalidate_actor_fluid_source_observations } from './fluid_source_observation'
import { placement_grid_check } from './placement_geometry'
import { record_hand_mined_item } from './hand_work'
import { find_world_entities } from './npc_vision'
import { invalidate_actor_pump_candidates } from './placement_candidates'

const TTL = 3600
const MAX_TILES = 8
const MAX_PLANS = 16
type Point = { x: number, y: number }
interface TileSnapshot { position: Point, name: string, hidden?: string, double_hidden?: string }
interface Preparation {
  id: string
  tick: number
  actor_id: number
  actor_kind: string
  surface_index: number
  force_index: number
  position: Point
  direction: number
  snapshot: TileSnapshot[]
  removals: TileSnapshot[]
}
declare const storage: { sgluna_pump_preparations?: Preparation[], sgluna_next_pump_preparation?: number }

/** Opaque proposals never survive a startup or prototype-configuration boundary. */
export function invalidate_pump_preparation_proposals() {
  storage.sgluna_pump_preparations = []
}

function rotate(p: Point, direction: number): Point {
  if (direction === 4) return { x: -p.y, y: p.x }
  if (direction === 8) return { x: -p.x, y: -p.y }
  if (direction === 12) return { x: p.y, y: -p.x }
  return p
}
function same_position(a: Point, b: Point) { return a.x === b.x && a.y === b.y }
function snapshot(actor: ControlledActor, position: Point): TileSnapshot {
  const tile = actor.surface.get_tile(position)
  return { position, name: tile.name, hidden: tile.hidden_tile, double_hidden: tile.double_hidden_tile }
}
function unchanged(actor: ControlledActor, expected: TileSnapshot) {
  const now = snapshot(actor, expected.position)
  return now.name === expected.name && now.hidden === expected.hidden && now.double_hidden === expected.double_hidden
}
function water_beneath(tile: TileSnapshot) {
  // This release proves native landfill reclamation, not foundation demolition
  // or removal of paved player terrain. Add other layers only with native proof.
  return tile.name === 'landfill' && tile.hidden !== undefined && prototypes.tile[tile.hidden]?.fluid?.name === 'water'
}
function coordinates(value: unknown): value is number {
  return typeof value === 'number' && value === value && math.abs(value) <= 1000000
}
function protected_entities(actor: ControlledActor, p: Point, owned: LuaEntity[] = []) {
  const entities = find_world_entities(actor.surface, { area: [{ x: p.x + 0.001, y: p.y + 0.001 }, { x: p.x + 0.999, y: p.y + 0.999 }], limit: 17 })
  return entities.some(entity => !owned.some(proxy => proxy.valid && proxy === entity))
}
function actor_safe(actor: ControlledActor, tiles: TileSnapshot[]) {
  const box = actor.character?.bounding_box
  if (!box) return false
  // Never expose water beneath any part of the actor's collision footprint.
  return !tiles.some(tile => box.left_top.x < tile.position.x + 1 && box.right_bottom.x > tile.position.x
    && box.left_top.y < tile.position.y + 1 && box.right_bottom.y > tile.position.y)
}
function stock_fits(actor: ControlledActor, removals: TileSnapshot[]) {
  const inventory = actor.get_main_inventory()
  if (!inventory) return false
  const required: Record<string, number> = {}
  for (const tile of removals) {
    for (const name of [tile.name, tile.hidden]) {
      if (!name || prototypes.tile[name]?.fluid?.name === 'water') break
      const products = prototypes.tile[name]?.mineable_properties.products ?? []
      if (products.length !== 1 || products[0].type !== 'item' || products[0].probability !== undefined && products[0].probability !== 1) return false
      const product = products[0]
      const amount = product.amount ?? product.amount_max
      if (!amount || amount !== (product.amount_min ?? amount)) return false
      required[product.name] = (required[product.name] ?? 0) + amount
    }
  }
  let needed_empty = 0
  for (const [name, count] of pairs(required)) {
    if (!inventory.can_insert({ name, count })) return false
    // Reserving whole empty stacks is conservative but accounts for unlike items
    // competing for the same inventory slots. No forced mining or ground spill.
    needed_empty += math.ceil(count / prototypes.item[name].stack_size)
  }
  return inventory.count_empty_stacks() >= needed_empty
}

/** Read-only native geometry proposal. This is never a pump placement candidate. */
export function get_pump_site_preparation(actor: ControlledActor | undefined, request: { x: number, y: number, direction?: number }) {
  if (!actor?.is_valid || !actor.character) return { ok: false, code: 'no_actor' }
  const identity = actor.status_snapshot()
  if (identity.actor_id === undefined) return { ok: false, code: 'no_actor' }
  if (!request || !coordinates(request.x) || !coordinates(request.y)) return { ok: false, code: 'invalid_position' }
  const direction = request.direction ?? 0
  if (![0, 4, 8, 12].includes(direction)) return { ok: false, code: 'invalid_direction' }
  const position = { x: request.x, y: request.y }
  const prototype = prototypes.entity['offshore-pump']
  if (!prototype || !placement_grid_check(prototype, position, direction).valid) return { ok: false, code: 'invalid_pump_grid' }
  if ((position.x - actor.position.x) ** 2 + (position.y - actor.position.y) ** 2 > 24 ** 2) return { ok: false, code: 'pump_site_too_far' }
  const water = get_recent_fluid_source_observation(actor, 'water')
  if (!water) return { ok: false, code: 'water_search_required' }
  const snapshots: TileSnapshot[] = []
  const removals: TileSnapshot[] = []
  const rules = prototype.tile_buildability_rules as any[] | undefined
  if (!rules || rules.length === 0 || rules.length > 8) return { ok: false, code: 'unsupported_pump_tile_rules' }
  for (const rule of rules) {
    const first = rotate(rule.area.left_top, direction)
    const second = rotate(rule.area.right_bottom, direction)
    const lo = { x: position.x + math.min(first.x, second.x), y: position.y + math.min(first.y, second.y) }
    const hi = { x: position.x + math.max(first.x, second.x), y: position.y + math.max(first.y, second.y) }
    if (hi.x - lo.x > 4 || hi.y - lo.y > 4) return { ok: false, code: 'unsupported_pump_tile_rules' }
    const need_water = rule.required_tiles?.layers?.water_tile === true
    const need_ground = rule.required_tiles?.layers?.ground_tile === true
    if (!need_water && !need_ground) return { ok: false, code: 'unsupported_pump_tile_rules' }
    for (let x = math.floor(lo.x); x < math.ceil(hi.x); x++) for (let y = math.floor(lo.y); y < math.ceil(hi.y); y++) {
      const p = { x, y }
      if (!actor.surface.is_chunk_generated({ x: math.floor(x / 32), y: math.floor(y / 32) })) return { ok: false, code: 'pump_site_unexplored' }
      const tile = actor.surface.get_tile(p)
      const entry = snapshot(actor, p)
      if (!snapshots.some(row => same_position(row.position, p))) snapshots.push(entry)
      if (snapshots.length > 16) return { ok: false, code: 'unsupported_pump_tile_rules' }
      if (need_ground && !tile.collides_with('ground_tile')) return { ok: false, code: 'pump_body_requires_ground' }
      if (!need_water || tile.prototype.fluid?.name === 'water') continue
      if (entry.name !== 'landfill' || entry.hidden && prototypes.tile[entry.hidden]?.mineable_properties.minable) return { ok: false, code: 'pump_site_cover_not_supported' }
      if (!tile.prototype.mineable_properties.minable || !water_beneath(entry)) return { ok: false, code: 'pump_site_has_no_covered_water' }
      if (!removals.some(row => same_position(row.position, p))) removals.push(entry)
    }
  }
  if (removals.length === 0 || removals.length > MAX_TILES) return { ok: false, code: 'pump_site_needs_no_bounded_removal' }
  if (!removals.some(tile => water.covered_fluid_hints.some(hint => same_position(hint.position, tile.position)))) return { ok: false, code: 'covered_water_not_observed' }
  if (!actor_safe(actor, removals)) return { ok: false, code: 'pump_site_actor_on_cover' }
  if (snapshots.some(tile => protected_entities(actor, tile.position))) return { ok: false, code: 'pump_site_protected_entity' }
  if (removals.some(tile => actor.surface.get_tile(tile.position).to_be_deconstructed())) return { ok: false, code: 'pump_site_existing_deconstruction' }
  const next = storage.sgluna_next_pump_preparation ?? 1
  storage.sgluna_next_pump_preparation = next + 1
  const plan: Preparation = { id: `pump-preparation-${next}`, tick: game.tick, actor_id: identity.actor_id, actor_kind: identity.kind,
    surface_index: actor.surface.index, force_index: actor.force.index, position, direction, snapshot: snapshots, removals }
  const plans = storage.sgluna_pump_preparations ?? []
  plans.push(plan)
  while (plans.length > MAX_PLANS) plans.shift()
  storage.sgluna_pump_preparations = plans
  return { ok: true, preparation_id: plan.id, generated_tick: plan.tick, expires_tick: plan.tick + TTL,
    actor_id: plan.actor_id, surface_index: plan.surface_index, force_index: plan.force_index, position, direction,
    source: 'native_pump_tile_rules_and_observed_hidden_water', removal_tiles: removals, execution_strategy: 'actor',
    placement_authority: false, next_required: 'prepare_pump_site then fresh getFluidSourceTiles and getPlacementCandidates; place_candidate only' }
}

export function pump_site_preflight(actor: ControlledActor | undefined, preparation_id: string) {
  if (!actor?.is_valid || !actor.character) return { ok: false as const, code: 'no_actor' }
  if (typeof preparation_id !== 'string' || preparation_id.length < 1 || preparation_id.length > 100) return { ok: false as const, code: 'pump_preparation_unavailable' }
  const plan = (storage.sgluna_pump_preparations ?? []).find(value => value.id === preparation_id)
  if (!plan) return { ok: false as const, code: 'pump_preparation_unavailable' }
  const identity = actor.status_snapshot()
  if (plan.actor_id !== identity.actor_id || plan.actor_kind !== identity.kind || plan.force_index !== actor.force.index || plan.surface_index !== actor.surface.index) return { ok: false as const, code: 'pump_preparation_actor_changed' }
  if (game.tick < plan.tick || game.tick - plan.tick > TTL) return { ok: false as const, code: 'pump_preparation_expired' }
  if (!plan.snapshot.every(tile => unchanged(actor, tile))) return { ok: false as const, code: 'pump_preparation_world_changed' }
  if (find_world_entities(actor.surface, { position: plan.position, radius: 5, type: ['deconstructible-tile-proxy', 'entity-ghost', 'tile-ghost'], limit: 1 }).length > 0) return { ok: false as const, code: 'pump_site_existing_deconstruction' }
  if (!actor_safe(actor, plan.removals)) return { ok: false as const, code: 'pump_site_actor_on_cover' }
  if (plan.snapshot.some(tile => protected_entities(actor, tile.position))) return { ok: false as const, code: 'pump_site_protected_entity' }
  if (plan.removals.some(tile => actor.surface.get_tile(tile.position).to_be_deconstructed())) return { ok: false as const, code: 'pump_site_existing_deconstruction' }
  const reach = actor.character.reach_distance
  if (plan.removals.some(tile => (tile.position.x + 0.5 - actor.position.x) ** 2 + (tile.position.y + 0.5 - actor.position.y) ** 2 > reach ** 2)) return { ok: false as const, code: 'pump_site_out_of_reach', position: plan.position }
  if (!stock_fits(actor, plan.removals)) return { ok: false as const, code: 'pump_site_inventory_full' }
  return { ok: true as const, code: 'pump_site_ready', plan }
}

/** Remove only proxies this admitted job created. Never cancel another force's work. */
export function cleanup_pump_preparation(task: PlayerParametersPreparePumpSite) {
  for (const proxy of task.owned_proxies ?? []) if (proxy.valid && proxy.force.index === task.owner_force_index
    && proxy.surface.index === task.owner_surface_index) proxy.destroy()
  task.owned_proxies = undefined
}

export function tick_pump_preparation(actor: ControlledActor, task: PlayerParametersPreparePumpSite): { state: 'pending' | 'complete' | 'failed', reason: string } {
  if (!task.started_tick) {
    const checked = pump_site_preflight(actor, task.preparation_id)
    if (!checked.ok) return { state: 'failed', reason: checked.code }
    const plan = checked.plan
    task.started_tick = game.tick
    task.position = plan.position
    task.expected_tiles = plan.removals.map(tile => ({ ...tile }))
    task.prepared_snapshot = plan.snapshot.map(tile => ({ ...tile }))
    task.removed_layers = 0
    task.reclaimed_items = {}
    task.owned_proxies = []
    actor.set_walking_state({ walking: false, direction: defines.direction.north })
    actor.set_mining_state({ mining: false })
    // Exact native tile jobs are the handoff boundary for a future robot
    // strategy. The actor backend owns these proxies and executes the work now.
    // Avoid superforced blueprints: their collateral structure marks would
    // grant broader deconstruction authority than this bounded tile job.
    log(`[AUTORIO] pump_site.preparation_started preparation_id=${task.preparation_id} operation_id=${task.operation_id} strategy=actor tiles=${plan.removals.length}`)
  }
  if (!task.expected_tiles || !task.prepared_snapshot || !task.owned_proxies || !task.position) return { state: 'failed', reason: 'pump_preparation_state_invalid' }
  if (game.tick < task.started_tick || game.tick - task.started_tick > 60 * 60) return { state: 'failed', reason: 'pump_preparation_execution_expired' }
  const index = task.tile_index ?? 0
  const expected = task.expected_tiles[index]
  if (!actor_safe(actor, task.expected_tiles)) return { state: 'failed', reason: 'pump_site_actor_on_cover' }
  if (task.prepared_snapshot.some(tile => protected_entities(actor, tile.position, task.owned_proxies))) return { state: 'failed', reason: 'pump_site_protected_entity' }
  if (!task.prepared_snapshot.every(tile => unchanged(actor, tile))) return { state: 'failed', reason: 'pump_preparation_world_changed' }
  if (!expected) {
    if (!task.expected_tiles.every(tile => actor.surface.get_tile(tile.position).prototype.fluid?.name === 'water')) return { state: 'failed', reason: 'pump_native_water_not_exposed' }
    cleanup_pump_preparation(task)
    return { state: 'complete', reason: 'covered_water_exposed' }
  }
  const tile = actor.surface.get_tile(expected.position)
  const reach = actor.character?.reach_distance ?? 0
  if ((expected.position.x + 0.5 - actor.position.x) ** 2 + (expected.position.y + 0.5 - actor.position.y) ** 2 > reach ** 2) return { state: 'failed', reason: 'pump_site_out_of_reach' }
  if (!stock_fits(actor, task.expected_tiles.slice(index))) return { state: 'failed', reason: 'pump_site_inventory_full' }
  const mining = tile.prototype.mineable_properties
  const speed = (actor.character?.prototype.mining_speed ?? 0) * (1 + (actor.character?.character_mining_speed_modifier ?? 0) + actor.force.manual_mining_speed_modifier)
  if (speed <= 0 || mining.mining_time <= 0) return { state: 'failed', reason: 'pump_native_mining_rate_unavailable' }
  task.layer_started_tick ??= game.tick
  // LuaControl.mine_tile cannot remove landfill on 2.0.77. Native proxy.mine
  // performs the real terrain transition and real item transfer; enforce actor
  // reach, native mining duration and inventory before invoking that API.
  if (game.tick - task.layer_started_tick < math.ceil(mining.mining_time / speed * 60)) return { state: 'pending', reason: 'actor_mining_cover' }
  // Actor work keeps no robot-actionable marks while waiting. Create and mine
  // exactly this tile's proxy in the same Lua invocation after all checks pass.
  const proxy = tile.order_deconstruction(actor.force)
  if (!proxy) return { state: 'failed', reason: 'pump_native_proxy_unavailable' }
  task.owned_proxies.push(proxy)
  if (proxy.force.index !== actor.force.index || proxy.surface.index !== actor.surface.index) return { state: 'failed', reason: 'pump_native_proxy_owner_changed' }
  const product = mining.products?.[0]
  if (!product || product.type !== 'item') return { state: 'failed', reason: 'pump_native_product_unsupported' }
  const inventory = actor.get_main_inventory()!
  const before = inventory.get_item_count(product.name)
  if (!proxy.mine({ inventory, force: false })) return { state: 'failed', reason: 'pump_native_mining_rejected' }
  invalidate_actor_fluid_source_observations(actor)
  invalidate_actor_pump_candidates(actor)
  const delta = inventory.get_item_count(product.name) - before
  const after = actor.surface.get_tile(expected.position)
  if (delta !== (product.amount ?? product.amount_max) || after.name === expected.name) return { state: 'failed', reason: 'pump_native_removal_unverified' }
  record_hand_mined_item(actor.force.index, product.name)
  task.removed_layers = (task.removed_layers ?? 0) + 1
  task.reclaimed_items![product.name] = (task.reclaimed_items![product.name] ?? 0) + delta
  log(`[AUTORIO] pump_site.cover_removed preparation_id=${task.preparation_id} operation_id=${task.operation_id} reason=native_proxy_mined item=${product.name} count=${delta} tile=${after.name}`)
  const updated = snapshot(actor, expected.position)
  task.prepared_snapshot = task.prepared_snapshot.map(value => same_position(value.position, expected.position) ? updated : value)
  task.layer_started_tick = undefined
  if (after.prototype.fluid?.name === 'water') task.tile_index = index + 1
  else {
    if (!water_beneath(updated) || task.removed_layers > MAX_TILES) return { state: 'failed', reason: 'pump_native_water_not_exposed' }
    task.expected_tiles[index] = updated
  }
  return { state: 'pending', reason: 'native_cover_layer_removed' }
}
