import { randomBytes, randomUUID } from 'node:crypto'

import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { executeAuthorizedBatch } from '../staging/supervisor-adapter.mjs'
import { luaString, PolicyError } from '../staging/structured-policy.mjs'
import { machineDeliveryToolDefinition, validateMachineDeliveryBindingArgs } from './machine-delivery.mjs'
import {
  batchWatermark,
  buildPendingOperation,
  operationIdentity,
  operationSignature,
  reconcilePendingOperation,
} from './operation-reconciliation.mjs'
import {
  operationTypeCatalog,
  parseOperation,
  renderOperation,
  renderOperationPreflight,
  toolCommand,
  toolDefinitions,
} from './structured-policy.mjs'

// Capability membership is separate from native legality. Generic placements
// require live geometry/fluid witnesses, never membership in a prototype list.
export const PLACEMENT_PROTOTYPES = Object.freeze([])
export const FLUID_PLACEMENT_PROTOTYPES = Object.freeze([])
export const OPERATION_NAMES = Object.freeze(['wait', 'walk_to_position', 'craft_item', 'mine_resource_at', 'move_items_exact', 'place_entity', 'harvest_product', 'research_technology', 'place_candidate', 'set_machine_recipe', 'walk_to_entity', 'walk_to_entity_exact', 'gather_resource', 'supply_entity', 'mine_entity_exact', 'rotate_entity', 'prepare_pump_site', 'clear_construction_area', 'set_auto_defense', 'equip_weapon', 'equip_ammo', 'equip_armor', 'select_weapon_slot', 'attack_nearest_enemy', 'clear_enemy_area', 'launch_rocket', 'place_line', 'pick_up_ground_items'])
// place_line is external-only: this bridge parses and renders it (the shared runtime-v8 catalog and the internal planner
// prompts do not list it). One admitted operation places a straight run, one native placement task per tile, in order.
export const LINE_PROTOTYPES = Object.freeze(['transport-belt', 'small-electric-pole'])
export const MAX_LINE_PLACEMENTS = 32
export const MAX_LINE_SPACING = 8
const LINE_DIRECTIONS = Object.freeze([0, 4, 8, 12])
const LINE_ARGUMENTS = Object.freeze(['entity_name', 'x', 'y', 'direction', 'line_direction', 'count', 'spacing'])
const LINE_OPERATION = Object.freeze({
  name: 'place_line', args: [...LINE_ARGUMENTS], external_only: true,
  arguments: {
    entity_name: { kind: 'closed_enum', required: true, defaulted: false, values: [...LINE_PROTOTYPES] },
    x: { kind: 'planner_numeric', required: true, defaulted: false },
    y: { kind: 'planner_numeric', required: true, defaulted: false },
    direction: { kind: 'closed_enum', required: false, defaulted: true, default: 0, values: [...LINE_DIRECTIONS] },
    line_direction: { kind: 'closed_enum', required: true, defaulted: false, values: [...LINE_DIRECTIONS] },
    count: { kind: 'bounded_integer', required: true, defaulted: false, minimum: 1, maximum: MAX_LINE_PLACEMENTS },
    spacing: { kind: 'bounded_integer', required: false, defaulted: true, default: 1, minimum: 1, maximum: MAX_LINE_SPACING },
  },
  scopes: ['construction'], preflight: true, risk: 'high',
})
const MAX_LINE_COORDINATE = 1000000
// pick_up_ground_items is external-only as well: the items lying on the ground in a box of at most 5x5 tiles, picked up
// with the character's native mining. Nothing else in the box is mined, and placement still never clears.
export const MAX_PICKUP_RADIUS = 2
export const MAX_PICKUP_ITEMS = 16
const PICKUP_ARGUMENTS = Object.freeze(['x', 'y', 'radius'])
const PICKUP_OPERATION = Object.freeze({
  name: 'pick_up_ground_items', args: [...PICKUP_ARGUMENTS], external_only: true,
  arguments: {
    x: { kind: 'planner_numeric', required: true, defaulted: false },
    y: { kind: 'planner_numeric', required: true, defaulted: false },
    radius: { kind: 'bounded_integer', required: false, defaulted: true, default: 0, minimum: 0, maximum: MAX_PICKUP_RADIUS },
  },
  scopes: ['construction'], preflight: true, risk: 'medium',
})
export function lineTiles({ x, y, line_direction, count, spacing }) {
  const step = { 0: [0, -1], 4: [1, 0], 8: [0, 1], 12: [-1, 0] }[line_direction]
  return Array.from({ length: count }, (_, index) => ({ index, x: x + step[0] * spacing * index, y: y + step[1] * spacing * index }))
}
export const OBSERVATION_NAMES = Object.freeze([
  'getActorStatus', 'getInventoryItems', 'getEquipmentStatus', 'getRecipeDetails',
  'getPrototypeDetails', 'discoverPrototypes', 'getNearbyEntities', 'getEntityStatus',
  'getCraftingStatus', 'getNavigationStatus', 'getTechnology', 'getResearchStatus',
  'getPlacementCandidates', 'getFluidSourceTiles', 'getEntityGeometry', 'getTransportCapacity',
  'getResourceAmounts', 'getProductionScope', 'solveProduction', 'getMiningDetails', 'estimateProductionTime', 'getResearchPath',
  'findLongRangeEntities', 'getLogisticsTopology', 'measureTransportThroughput', 'getLocalSpatialObservation', 'planPlacement', 'findConstructionSites', 'getMapContext',
  'getTaskStatus', 'getResearchRequest', 'findNearestEnemy', 'getDefenseStatus', 'getCombatStatus', 'getPumpSitePreparation', 'getWorldEntityFacts',
])
export const observationDefinitions = toolDefinitions.filter(tool => OBSERVATION_NAMES.includes(tool.function.name))
export function capabilities() {
  return { operations: [...operationTypeCatalog().filter(operation => OPERATION_NAMES.includes(operation.name)), structuredClone(LINE_OPERATION), structuredClone(PICKUP_OPERATION)],
    goal_metadata_tools: [{ name: machineDeliveryToolDefinition.function.name, description: machineDeliveryToolDefinition.function.description,
      inputSchema: machineDeliveryToolDefinition.function.parameters, world_mutation: false, operation_authority: false }],
    observations: [...OBSERVATION_NAMES], observation_schemas: observationDefinitions.map(tool => ({
      name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters,
    })), limits: { wait_ticks: 3600, count: 100, transfer_count: 1000, walk_distance: 128, fluid_network_entities: 16, placement_prototypes: [...PLACEMENT_PROTOTYPES], fluid_candidate_prototypes: [...FLUID_PLACEMENT_PROTOTYPES], harvest_radius: 64, placement_requires_exact_grid: true, placement_clearing: false, line_prototypes: [...LINE_PROTOTYPES], line_count: MAX_LINE_PLACEMENTS, line_spacing: MAX_LINE_SPACING, pickup_radius: MAX_PICKUP_RADIUS, pickup_items: MAX_PICKUP_ITEMS, placement_domain: 'native-nonfluid-or-proven-fluid-candidate', recipe_domain: 'native-compatible-empty-isolated-assembling-machine' },
    operation_notes: { ...OPERATION_NOTES }, observation_notes: { ...OBSERVATION_NOTES } }
}

// Semantics the shared catalog leaves implicit and operators misread in the
// 2026-11-01 trial. Facts about this bridge, not strategy advice.
export const OPERATION_NOTES = Object.freeze({
  craft_item: 'count is the number of recipe crafts, not items. A recipe with N products per craft yields count x N items (read getRecipeDetails products).',
  place_entity: 'direction uses Factorio defines.direction values (0 north, 4 east, 8 south, 12 west). For inserters it names the pickup side; drop is opposite. Verify pickup/drop with getEntityGeometry after placement. getPlacementCandidates rows with external_footprint.eligible=false will be refused. Use mine_entity_exact for custody-backed removal when native removal_readiness permits it; protected, active, nonempty or unproved hydraulic networks and unsupported contents are refused. Items on the ground in a footprint can be picked up with pick_up_ground_items.',
  place_candidate: 'A fluid candidate that joins an entity (connects_to) needs the native preservation guard to prove that entity\'s whole connected fluid network, at most 16 entities. getPlacementCandidates reports this as connects_to.preservation_network (provable, entity_count, limit; unit_number names an entity the guard cannot read, for example one not visible now) and marks such candidates external_preservation.eligible=false. They are refused before they are sent. A join to a network of 16 brings it to 17; a network of 17 or more cannot be joined.',
  place_line: `Places count (1-${MAX_LINE_PLACEMENTS}) entities of entity_name (${LINE_PROTOTYPES.join(' or ')}) in a straight line, one native placement per tile in order: tile i is at (x, y) plus i x spacing (1-${MAX_LINE_SPACING}, default 1) tiles toward line_direction (0 north, 4 east, 8 south, 12 west). direction (default 0) is each entity's own facing; for belts it is the flow direction. x, y is the exact grid centre of tile 0. Before sending, every tile is checked like place_entity (exact grid, can_place_entity, the external footprint rule, within 128 tiles of the actor) and the actor must hold count items; any failure refuses the whole line with details.tile_index and nothing is placed. The actor's own character does not block a tile in this check: during execution it walks into build reach and steps out of any tile it stands on before placing it. Any other character still blocks. If a tile becomes blocked during execution the line stops there: the receipt is partial, line_placement.placed lists each placed entity (index, unit_number, position) and line_placement.refusal names the first refused tile. Nothing is cleared or replaced.`,
  pick_up_ground_items: `Picks up the items lying on the ground (item-on-ground entities, for example ore a drill dropped, or an item listed as a placement blocker) in the square box centred on (x, y) with half-width radius + 0.5 tiles: radius 0 (the default) is one tile, radius ${MAX_PICKUP_RADIUS} (the maximum) is 5x5. The actor walks into reach and mines each item stack, as a player picks items up, into its inventory. Nothing else in the box is mined: no tree, rock, building, resource or character. As with every walk, navigation may clear a tree or rock that blocks the only path. Before sending, the box must hold 1-${MAX_PICKUP_ITEMS} ground stacks, each of which fits the actor inventory now, within 128 tiles of the actor; otherwise it is refused (no_ground_items, ground_items_over_limit, inventory_full). A completed receipt means the box held no ground items when the task ended; observed_effect has the inventory delta for each item the preflight found. If the inventory fills during the task, or items keep landing in the box (${MAX_PICKUP_ITEMS * 2} pickups), the task stops and the receipt is cancelled.`,
  research_technology: 'A completed receipt means research was started and queued, not finished. While other force research is active the request is appended behind it in the native queue (queued_behind) and the labs reach it when the earlier work finishes; queue the next technology before the current one completes so labs never idle. Read getResearchStatus or getTechnology for progress and researched.',
  walk_to_position: 'Target must be within 128 tiles of the current actor position.',
  move_items_exact: 'Name-targeted transfers use getNearbyEntities/findLongRangeEntities to select an exact unit, with no fallback after target loss. May walk the actor into reach first. A terminal receipt includes observed_effect with the actor inventory delta for item_name and the actor position before and after.',
  harvest_product: 'Searches up to 64 tiles and may walk the actor there. A terminal receipt includes observed_effect with the actor inventory delta for product_name and the actor position before and after.',
  mine_entity_exact: 'Exact visible target only; native world binding, full recovered-item capacity and immutable admission custody are required. Hydraulic targets require a fresh bounded empty-network proof, complete native claim history and no protected entity/edge/candidate footprint; the captured witness is repeated at execution. Working/in-flight processes and unsupported contents are refused. Completion requires a verified removal receipt.',
  rotate_entity: 'Exact visible target only. Hydraulic rotation proves the complete empty network and all networks in its native rotation/port envelope are unprotected, captures the witness at queueing and rechecks it at execution. Missing legacy claim history, unseen/truncated geometry or changed networks refuse; no model override.',
  set_machine_recipe: 'Native compatible assembler only; first assignment with empty inventory and no active process. Fluid machines additionally need complete, empty, disconnected native ports, rechecked at execution.',
  clear_construction_area: 'Bounded native hand-mining of natural construction blockers only. Force-owned or item-placeable buildings, resources and characters are preserved; no implicit placement clearing.',
  prepare_pump_site: 'Executes only the current native proposal for bounded removable landfill over observed water; no arbitrary clearing.',
  submit_refusals: 'A factorio_submit error with effect "not_happened" means this call was refused before its operation was sent to the game and used no journal slot. An error without that field may have had an effect; read the receipt or native state. Placement refusals name blockers in details. A refusal during atomic admission instead returns a rejected receipt.',
  running_receipts: 'A running receipt includes observed_progress: the actor position and inventory delta for the operation\'s item so far, read when the reply is sent. It is an observation of the actor, not a native progress count.',
})
// Native observation semantics the same operator misread: where a radius is
// centred and what a visibility refusal means.
export const OBSERVATION_NOTES = Object.freeze({
  getNearbyEntities: 'radius is centred on the actor\'s current position (actor_position in the result), not where an earlier call ran. Operations that walk the actor move that centre.',
  getEntityStatus: 'Reads only chunks the force sees live now (Factorio force chunk visibility: near the actor, or radar coverage). entity_not_visible means there is no live vision there, not that the entity is gone. status and status_name are the native defines.entity_status values.',
  getResearchStatus: 'available lists up to 24 technologies the force can research now (enabled, not researched, every prerequisite researched), each with the recipes it unlocks (unlocks, up to 12), its science ingredients and unit count, or trigger_type for a technology completed by its trigger instead of labs. getTechnology({name}) also lists unlocks for any technology.',
})
const MAX_REPLY_BYTES = 512 * 1024
const PREFIX = '/silent-command '
const JSON_PREFIX = `${PREFIX}rcon.print(helpers.table_to_json(`
const REVISION = 'sgluna-deploy-v8-npc-staging'

// Bridge-authored messages and details are deterministic strings/facts, never
// raw native text, so they are safe to show the operator verbatim.
export class BridgeError extends Error {
  constructor(code, message = code, { notAdmitted = false, details } = {}) {
    super(message)
    this.code = code
    this.publicMessage = message
    this.notAdmitted = notAdmitted
    if (details !== undefined) this.details = details
  }
}

function check(ok, code, message, options) {
  if (!ok) throw new BridgeError(code, message, options)
}
function positive(value) { return Number.isSafeInteger(value) && value > 0 }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function array(value) { return object(value) && Object.keys(value).length === 0 ? [] : value }
function json(raw) {
  check(typeof raw === 'string' && Buffer.byteLength(raw) <= MAX_REPLY_BYTES, 'native_reply_too_large')
  try { return JSON.parse(raw.trim()) }
  catch { throw new BridgeError('native_reply_invalid_json') }
}
function marker() { return `SGLUNA_RESULT_${randomBytes(12).toString('hex')}:` }
function identity(pending) {
  check(pending?.protocol_version === 2 && positive(pending.actor?.actor_id) && positive(pending.actor?.epoch)
    && positive(pending.ordinal) && pending.ordinal < Number.MAX_SAFE_INTEGER
    && typeof pending.operation_key === 'string' && /^[a-z0-9_/-]{1,120}$/i.test(pending.operation_key)
    && typeof pending.attempt_id === 'string' && /^[a-z0-9_/-]{1,120}$/i.test(pending.attempt_id)
    && /^[a-f0-9]{64}$/.test(pending.signature), 'invalid_pending_identity')
}
function lineArgsLua(args) {
  return `{entity_name=${luaString(args.entity_name)},x=${args.x},y=${args.y},direction=${args.direction},line_direction=${args.line_direction},count=${args.count},spacing=${args.spacing}}`
}
function preflightExpression(operation) {
  if (operation.name === 'place_line') {
    // The native preflight checks every tile (items for the whole line, nonfluid witness, exact grid, reservation, manual
    // can_place_entity, the external footprint rule); this re-applies the bridge's own footprint rule to each returned tile
    // so preflight and candidate annotation keep one definition. Read-only; rerun inside atomic admission.
    const { entity_name: name, count } = operation.args
    return `(function() ${FOOTPRINT_RULE_LUA} local p=remote.call("autorio_preflight","operation","place_line",${lineArgsLua(operation.args)}); if p.ok~=true then return p end; local w=p.preservation_nonfluid_output; if not w or w.fluid_port_count~=0 or w.entity_name~=${luaString(name)} or type(p.tiles)~="table" or #p.tiles~=${count} then return {ok=false,code="nonfluid_footprint_unproven"} end; local surface=game.surfaces[w.surface_index]; if not surface then return {ok=false,code="nonfluid_footprint_unproven"} end; local own=remote.call("sgluna_deployment","status").actor_id; for i,t in ipairs(p.tiles) do local f={position=t.position,world_box=t.world_box}; local code,blockers=external_footprint(surface,t.world_box,own,${luaString(name)}); if code=="placement_footprint_dense" then return {ok=false,code=code,tile_index=i-1} end; if code then return {ok=false,code=code,tile_index=i-1,blockers=blockers,planned_footprint=f} end end; return p end)()`
  }
  if (operation.name === 'pick_up_ground_items') {
    const a = operation.args
    return `remote.call("autorio_preflight","operation","pick_up_ground_items",{x=${a.x},y=${a.y},radius=${a.radius}})`
  }
  const command = renderOperationPreflight(operation)
  if (!command) return '{ok=true,validation="not_required"}'
  check(command.startsWith(JSON_PREFIX) && command.endsWith('))'), 'preflight_renderer_changed')
  const expression = command.slice(JSON_PREFIX.length, -2)
  if (['set_machine_recipe', 'mine_entity_exact', 'rotate_entity'].includes(operation.name)) {
    return `(function() local p=${expression}; if p.ok~=true then return p end; if not remote.interfaces.sgluna_world_safety then return {ok=false,code="world_safety_capability_missing"} end; local w=remote.call("sgluna_world_safety","preflight",${luaString(operation.name)},${operation.args.unit_number}); if w.ok~=true then return w end; p.external_world_safety=w.external_world_safety; return p end)()`
  }
  if (operation.name === 'walk_to_entity_exact') return `(function() local p=${expression}; if p.ok~=true then return p end; local s=remote.call("autorio_operations","status"); local a=s.actor and s.actor.position; local t=p.target and p.target.position; if not a or not t or (a.x-t.x)^2+(a.y-t.y)^2>16384 then return {ok=false,code="walk_out_of_range"} end; return p end)()`
  if (!['place_entity', 'place_candidate'].includes(operation.name)) return expression
  if (operation.name === 'place_candidate') return `(function() ${FOOTPRINT_RULE_LUA} local p=${expression}; if p.ok~=true then return p end; local f=p.planned_footprint; local n=f and f.entity_name; if not f or not f.world_box or p.preservation_clears_count~=0 then return {ok=false,code="external_candidate_unproven"} end; local actor=remote.call("sgluna_deployment","status"); local surface=game.surfaces[actor.surface_index]; if not surface then return {ok=false,code="external_candidate_unproven"} end; ${footprintCheckLua('n')} return p end)()`
  const { entity_name: name, x, y, direction = 0 } = operation.args
  // Consume the same native footprint and nonfluid witness as the full runtime;
  // never infer dimensions, snapping or fluid ports from a vanilla name.
  return `(function() ${FOOTPRINT_RULE_LUA} local p=${expression}; if p.ok~=true then return p end; local w=p.preservation_nonfluid_output; local f=p.planned_footprint; if not w or w.fluid_port_count~=0 or w.entity_name~=${luaString(name)} or not f or not f.world_box then return {ok=false,code="nonfluid_footprint_unproven"} end; if f.position.x~=${x} or f.position.y~=${y} then return {ok=false,code="exact_grid_required",planned_footprint=f} end; local surface=game.surfaces[w.surface_index]; local force=game.forces[w.force_index]; if not surface or not force or not surface.can_place_entity({name=${luaString(name)},position=f.position,direction=${direction},force=force,build_check_type=defines.build_check_type.manual}) then return {ok=false,code="placement_not_clear"} end; ${footprintCheckLua(luaString(name))} return p end)()`
}

// Any non-resource entity in the footprint blocks external placement, including
// items on the ground and characters that can_place_entity (and therefore the
// native candidate search) accepts. One Lua definition serves placement preflight
// and candidate annotation so they cannot disagree. It names up to eight blockers
// so the operator can tell an item on the ground from a real structure; clearing
// is still never attempted.
const FOOTPRINT_RULE_LUA = 'local function external_footprint(surface,box,own,placed) local pp=placed and prototypes.entity[placed]; local ok_mask,mask=pcall(function() return pp.collision_mask.layers end); if not ok_mask or type(mask)~="table" then mask=nil end; local found=surface.find_entities_filtered({area=box,limit=129}); if #found>=129 then return "placement_footprint_dense",{} end; local blockers={}; local function blocks(e) if e.type=="item-entity" or e.type=="character" or not mask then return true end; local ok,layers=pcall(function() return e.prototype.collision_mask.layers end); if not ok or type(layers)~="table" then return true end; for k,on in pairs(layers) do if on and mask[k] then return true end end; return false end; for _,e in pairs(found) do if e.valid and e.type~="resource" and e.name~="sgluna-npc-vision" and not (own and e.type=="character" and e.unit_number==own) and #blockers<8 and blocks(e) then blockers[#blockers+1]={name=e.name,type=e.type,position=e.position,unit_number=e.unit_number,item=e.type=="item-entity" and e.stack and e.stack.valid_for_read and e.stack.name or nil} end end; if #blockers>0 then return "placement_footprint_occupied",blockers end; return nil,blockers end;'
const footprintCheckLua = placed => `local code,blockers=external_footprint(surface,f.world_box,nil,${placed}); if code=="placement_footprint_dense" then return {ok=false,code=code} end; if code then return {ok=false,code=code,blockers=blockers,planned_footprint=f} end;`
// An admission-time preflight refusal carries its native cause in the guard's refusal text, the only channel the shared batch
// executor returns before any admission: ":code", "@tile_index" and up to eight ";type:name:item:x:y" blockers, each field
// restricted to prototype-name characters and two-decimal coordinates. parseGuardRefusal reads it back.
const REFUSAL_DETAIL_LUA = '(function(p) local function id(v) return type(v)=="string" and string.match(v,"^[a-z0-9_-]+$") and string.sub(v,1,64) or nil end; local c=type(p.code)=="string" and string.match(p.code,"^[a-z0-9_]+$") and string.sub(p.code,1,80) or "unknown"; local out=":"..c; local t=p.tile_index; if type(t)=="number" and t>=0 and t<1000 and t==math.floor(t) then out=out.."@"..string.format("%d",t) end; if type(p.blockers)=="table" then for i,b in ipairs(p.blockers) do if i>8 then break end; local x=type(b)=="table" and b.position and tonumber(b.position.x); local y=type(b)=="table" and b.position and tonumber(b.position.y); if x and y and math.abs(x)<1e6 and math.abs(y)<1e6 then out=out..";"..(id(b.type) or "unknown")..":"..(id(b.name) or "unknown")..":"..(id(b.item) or "")..":"..string.format("%.2f",x)..":"..string.format("%.2f",y) end end end; return out end)'
const GUARD_CODES = 'session_or_actor_changed|nonstandard_game_speed|native_busy|ordinal_not_fresh|unresolved_native_operation|preflight_rejected|walk_out_of_range|placement_safety_capability_missing|fluid_safety_capability_missing|line_placement_capability_missing|ground_pickup_capability_missing|native_generation_changed'
const GUARD_REFUSAL = new RegExp(String.raw`^external_guard_refused:(${GUARD_CODES})(?::([a-z0-9_]{1,80})(?:@(\d{1,3}))?((?:;[a-z0-9_-]{1,64}:[a-z0-9_-]{1,64}:[a-z0-9_-]{0,64}:-?\d{1,7}\.\d{2}:-?\d{1,7}\.\d{2}){0,8}))?$`)

// The guard code, plus the native cause when an admission-time preflight refused. Undefined for any other text.
export function parseGuardRefusal(text) {
  const match = GUARD_REFUSAL.exec(typeof text === 'string' ? text : '')
  if (!match) return undefined
  const [, code, nativeCode, tile, blockerText] = match
  if (nativeCode === undefined) return { code }
  if (code !== 'preflight_rejected') return undefined
  const blockers = (blockerText ?? '').split(';').slice(1).map(part => {
    const [type, name, item, x, y] = part.split(':')
    return { name, type, position: { x: Number(x), y: Number(y) }, ...(item ? { item } : {}) }
  })
  return { code, details: { native_code: nativeCode, ...(tile !== undefined ? { tile_index: Number(tile) } : {}), ...(blockers.length ? { blockers } : {}) } }
}

const ANNOTATED_CANDIDATES = 8 // getPlacementCandidates limit maximum

const PREFLIGHT_HINTS = Object.freeze({
  placement_footprint_occupied: 'The footprint contains non-resource entities that collide or must not be built over (see details.blockers); as in native placement, an entity whose collision layers do not overlap the placed entity, such as a tree stump under a belt, does not count. getPlacementCandidates marks such candidates external_footprint.eligible=false; external placement refuses items on the ground and characters and never clears them. Items on the ground (type item-entity) can be picked up first with pick_up_ground_items at their position; otherwise choose another position.',
  placement_not_clear: 'can_place_entity refused this exact position and direction. Read fresh getPlacementCandidates for the same prototype.',
  exact_grid_required: 'The native footprint snaps to a different center; use details.planned_footprint.position exactly.',
  placement_footprint_dense: 'The footprint area holds too many entities to inspect; choose another position.',
  nonfluid_footprint_unproven: 'No native zero-fluidbox witness for this prototype at this site; use place_candidate for fluid prototypes.',
  line_placement_items_insufficient: 'The actor does not hold enough items for the whole line (details.placement_item: required_count, held_count). Craft or fetch the shortfall, or shorten count.',
  npc_area_reserved: 'A tile of the line lies in an area the NPC has reserved for other construction.',
  invalid_line_args: 'The native line validation refused the arguments (details.field).',
  no_ground_items: 'The box holds no items on the ground now; nothing to pick up. Re-observe the position (getNearbyEntities) if a placement named an item blocker.',
  ground_items_over_limit: `The box holds more than ${MAX_PICKUP_ITEMS} ground item stacks; use a smaller radius.`,
  inventory_full: 'An item stack in the box does not fit the actor inventory now. Free inventory space first (for example insert items into a chest), then pick up again.',
  invalid_pickup_args: 'The native pickup validation refused the arguments (details.field).',
})

function prototypeName(value) { return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/.test(value) ? value : 'unknown' }

// Resource tiles under a candidate footprint, by name (trial 4r: buildings landed on the ore patch with no way to see it).
// A footprint box covers at most a few dozen tiles; the list is bounded anyway.
function resourceCoverage(rows) {
  const list = array(rows)
  if (!Array.isArray(list)) return []
  return list.slice(0, 8).filter(row => object(row) && Number.isSafeInteger(row.tiles) && row.tiles > 0)
    .map(row => ({ name: prototypeName(row.name), tiles: Math.min(row.tiles, 256) }))
}

function footprintBlockers(rows) {
  return (Array.isArray(rows) ? rows : []).slice(0, 8).map(row => ({
    name: prototypeName(row?.name), type: prototypeName(row?.type),
    ...(Number.isFinite(row?.position?.x) && Number.isFinite(row?.position?.y) ? { position: { x: row.position.x, y: row.position.y } } : {}),
    ...(Number.isSafeInteger(row?.unit_number) ? { unit_number: row.unit_number } : {}),
    ...(typeof row?.item === 'string' ? { item: prototypeName(row.item) } : {}) }))
}

function preflightFailure(preflight) {
  const code = typeof preflight?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(preflight.code) ? preflight.code : 'unknown'
  const blockers = Array.isArray(preflight?.blockers) ? footprintBlockers(preflight.blockers) : undefined
  const footprint = object(preflight?.planned_footprint) ? { position: preflight.planned_footprint.position, world_box: preflight.planned_footprint.world_box } : undefined
  const summary = blockers?.length ? ` Blockers: ${blockers.map(b => b.item ? `${b.type} (${b.item})` : `${b.name} [${b.type}]`).join(', ')}.` : ''
  // place_line: which tile refused, and the item accounting for the whole line.
  const tile = Number.isSafeInteger(preflight?.tile_index) && preflight.tile_index >= 0 ? preflight.tile_index : undefined
  const item = object(preflight?.placement_item) && [preflight.placement_item.required_count, preflight.placement_item.held_count].every(Number.isSafeInteger)
    ? { item_name: prototypeName(preflight.placement_item.item_name), required_count: preflight.placement_item.required_count, held_count: preflight.placement_item.held_count } : undefined
  const field = typeof preflight?.field === 'string' && /^[a-z_]{1,40}$/.test(preflight.field) ? preflight.field : undefined
  const where = tile !== undefined ? ` Line tile ${tile} refused.` : ''
  const counts = item && code === 'line_placement_items_insufficient' ? ` Requires ${item.required_count} ${item.item_name}, holds ${item.held_count}.` : ''
  return new BridgeError('preflight_rejected', `Native preflight rejected: ${code}. The operation was not sent to the game.${where}${counts}${summary} ${Object.hasOwn(PREFLIGHT_HINTS, code) ? PREFLIGHT_HINTS[code] : 'Re-observe the target before choosing different arguments.'}`.trim(),
    { notAdmitted: true, details: { native_code: code, ...(tile !== undefined ? { tile_index: tile } : {}), ...(item ? { placement_item: item } : {}),
      ...(field ? { field } : {}), ...(blockers ? { blockers } : {}), ...(footprint ? { planned_footprint: footprint } : {}) } })
}

// Items whose actor-inventory count an operation is expected to change. Used for
// before/after observation only; never as attribution or goal proof.
function effectItems(operation, found) {
  // pick_up_ground_items: the items its preflight found in the box.
  if (operation.name === 'pick_up_ground_items') return [...new Set((Array.isArray(found) ? found : []).filter(name => typeof name === 'string' && /^[a-z0-9_-]{1,100}$/.test(name)))].slice(0, MAX_PICKUP_ITEMS)
  const args = operation.args ?? {}
  const name = { craft_item: args.item_name, harvest_product: args.product_name, move_items_exact: args.item_name,
    mine_resource_at: args.resource_name, place_entity: args.entity_name, place_line: args.entity_name }[operation.name]
  return typeof name === 'string' && /^[a-z0-9_-]{1,100}$/.test(name) ? [name] : []
}

export function renderExternalOperation(raw) {
  const operation = parseExternalOperation(raw)
  if (operation.name === 'place_line') {
    // Placement-only by construction: the native place_line queues every tile with refuse_clearance.
    const a = operation.args
    return `remote.call("autorio_operations","place_line",${luaString(a.entity_name)},${a.x},${a.y},${a.direction},${a.line_direction},${a.count},${a.spacing})`
  }
  if (operation.name === 'pick_up_ground_items') {
    const a = operation.args
    return `remote.call("autorio_operations","pick_up_ground_items",${a.x},${a.y},${a.radius})`
  }
  const command = renderOperation(operation)
  // This safety argument is NOT model-selectable. The native endpoint forwards
  // it to the existing execution-time refuse_clearance task invariant.
  return ['place_entity', 'mine_entity_exact', 'rotate_entity', 'set_machine_recipe'].includes(operation.name) ? `${command.slice(0, -1)},true)` : command
}
function normalizedStatus(status) {
  check(object(status) && typeof status.task_state === 'string' && Number.isSafeInteger(status.queue_length)
    && status.queue_length >= 0 && positive(status.batch_generation), 'native_status_invalid')
  const admissions = array(status.admission_journal)
  check(nativeAdmissionJournal(admissions).known, 'native_journal_invalid')
  const receipts = array(status.receipt_journal)
  check(Array.isArray(receipts), 'native_receipts_invalid')
  return { ...status, receipt_journal: receipts, admission_journal: admissions.map(row => ({
    ...row, slots: array(row.slots).map(slot => ({ ...slot, batch_refs: array(slot.batch_refs) })),
  })) }
}

// Exact keys and bounds; defaults are filled in so the signature is canonical.
function parseLineOperation(raw) {
  check(object(raw) && Object.keys(raw).every(key => key === 'name' || key === 'args') && object(raw.args), 'invalid_operation', 'place_line needs {name, args}')
  const args = raw.args
  const unknown = Object.keys(args).filter(key => !LINE_ARGUMENTS.includes(key))
  check(unknown.length === 0, 'invalid_operation', `place_line does not accept ${unknown.join(', ')}; arguments are ${LINE_ARGUMENTS.join(', ')}`)
  check(LINE_PROTOTYPES.includes(args.entity_name), 'placement_not_supported', `place_line places only ${LINE_PROTOTYPES.join(' or ')}`)
  for (const key of ['x', 'y']) check(typeof args[key] === 'number' && Number.isFinite(args[key]) && Math.abs(args[key]) <= MAX_LINE_COORDINATE, 'invalid_operation', `${key} must be a finite tile-centre coordinate`)
  const direction = args.direction ?? 0
  check(LINE_DIRECTIONS.includes(direction), 'invalid_operation', 'direction must be 0, 4, 8 or 12')
  check(LINE_DIRECTIONS.includes(args.line_direction), 'invalid_operation', 'line_direction must be 0, 4, 8 or 12')
  check(Number.isSafeInteger(args.count) && args.count >= 1 && args.count <= MAX_LINE_PLACEMENTS, 'operation_limit', `count is bounded to 1-${MAX_LINE_PLACEMENTS}`)
  const spacing = args.spacing ?? 1
  check(Number.isSafeInteger(spacing) && spacing >= 1 && spacing <= MAX_LINE_SPACING, 'operation_limit', `spacing is bounded to 1-${MAX_LINE_SPACING}`)
  return { name: 'place_line', args: { entity_name: args.entity_name, x: args.x, y: args.y, direction, line_direction: args.line_direction, count: args.count, spacing } }
}

function parsePickupOperation(raw) {
  check(object(raw) && Object.keys(raw).every(key => key === 'name' || key === 'args') && object(raw.args), 'invalid_operation', 'pick_up_ground_items needs {name, args}')
  const args = raw.args
  const unknown = Object.keys(args).filter(key => !PICKUP_ARGUMENTS.includes(key))
  check(unknown.length === 0, 'invalid_operation', `pick_up_ground_items does not accept ${unknown.join(', ')}; arguments are ${PICKUP_ARGUMENTS.join(', ')}`)
  for (const key of ['x', 'y']) check(typeof args[key] === 'number' && Number.isFinite(args[key]) && Math.abs(args[key]) <= MAX_LINE_COORDINATE, 'invalid_operation', `${key} must be a finite map coordinate`)
  const radius = args.radius ?? 0
  check(Number.isSafeInteger(radius) && radius >= 0 && radius <= MAX_PICKUP_RADIUS, 'operation_limit', `radius is bounded to 0-${MAX_PICKUP_RADIUS}`)
  return { name: 'pick_up_ground_items', args: { x: args.x, y: args.y, radius } }
}

export function parseExternalOperation(raw) {
  if (raw?.name === 'place_line') return parseLineOperation(raw)
  if (raw?.name === 'pick_up_ground_items') return parsePickupOperation(raw)
  const operation = parseOperation(['harvest_product', 'gather_resource'].includes(raw?.name) && raw.args?.search_radius === undefined
    ? { ...raw, args: { ...raw.args, search_radius: raw.name === 'harvest_product' ? 64 : 128 } } : raw)
  check(OPERATION_NAMES.includes(operation.name), 'operation_not_supported', 'This external mode does not enable that operation')
  // The inherited parser is authoritative; these are additional experiment limits.
  if (operation.name === 'wait') check(operation.args.ticks <= 3600, 'operation_limit', 'wait is bounded to 3600 ticks')
  if (['craft_item', 'mine_resource_at', 'gather_resource'].includes(operation.name)) check(operation.args.count <= 100, 'operation_limit', 'count is bounded to 100')
  if (operation.name === 'place_entity') check(Number.isFinite(operation.args.x) && Number.isFinite(operation.args.y), 'placement_not_supported', 'Use explicit coordinates; native preflight must prove the nonfluid prototype and exact footprint')
  if (operation.name === 'harvest_product') {
    check(operation.args.count <= 100 && operation.args.search_radius <= 64, 'operation_limit', 'Harvest is bounded to 100 items within 64 tiles')
  }
  if (operation.name === 'move_items_exact') check(operation.args.max_count <= 1000, 'operation_limit', 'max_count is bounded to 1000')
  if (['walk_to_entity', 'gather_resource'].includes(operation.name)) check(operation.args.search_radius <= 128, 'operation_limit', 'search_radius is bounded to 128')
  if (operation.name === 'supply_entity') check(operation.args.items.length <= 16 && operation.args.items.every(item => item.count <= 1000), 'operation_limit', 'Supply is bounded to 16 item types and 1000 per type')
  return operation
}

function disposition(reconciliation) {
  const states = {
    admitted_in_flight: 'running', admitted_completed: 'completed', admitted_partial: 'partial',
    admitted_cancelled: 'cancelled', not_admitted: 'rejected', refused_before_mutation: 'rejected',
  }
  const state = states[reconciliation.verdict] ?? 'uncertain'
  return { state, reason: reconciliation.reason, effect: reconciliation.effect,
    terminal: ['completed', 'partial', 'cancelled', 'rejected'].includes(state),
    execution_completed: state === 'completed', goal_verified: false, reconciliation }
}

export class NativeBridge {
  constructor({ rcon, session }) {
    check(rcon && typeof rcon.command === 'function', 'rcon_required')
    check(typeof session === 'string' && /^[a-z0-9_-]{32,128}$/i.test(session), 'invalid_session', 'Use a persisted random UUID-derived external session')
    this.rcon = rcon
    this.session = session
  }

  capabilities() { return capabilities() }

  // Operator setup only: never exposed as an agent tool. No takeover, no retry.
  async bind() {
    const worldId = randomUUID()
    const command = `${PREFIX}local g=remote.call("sgluna_deployment","status"); local s=remote.call("autorio_operations","status"); if g.session~="" then rcon.print(helpers.table_to_json({ok=false,code="session_already_bound"})) elseif s.task_state~="idle" or s.queue_length~=0 or s.active_batch then rcon.print(helpers.table_to_json({ok=false,code="native_busy"})) else local j=remote.call("autorio_operation_admission","status"); local unresolved=false; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then unresolved=true end end; if unresolved then rcon.print(helpers.table_to_json({ok=false,code="unresolved_native_operation"})) elseif not remote.interfaces.sgluna_factory then rcon.print(helpers.table_to_json({ok=false,code="world_identity_capability_missing"})) else local w=remote.call("sgluna_factory","world_identity"); if w.code=="world_unbound" then w=remote.call("sgluna_factory","bind_world_id",${luaString(worldId)}) end; if w.ok~=true then rcon.print(helpers.table_to_json(w)); return end; local result=remote.call("sgluna_deployment","configure","npc",${luaString(this.session)}); rcon.print(helpers.table_to_json({ok=result==${luaString(this.session)}})) end end`
    const result = json(await this.rcon.command(command))
    check(result.ok === true, typeof result.code === 'string' && /^[a-z0-9_]{1,80}$/.test(result.code) ? result.code : 'bind_failed')
    return this.snapshot()
  }

  // Operator setup only, never an agent tool: the one-time freeplay start a
  // joining human would trigger (crashed ship, debris and starting items),
  // given to the bound NPC. The session must already be bound and idle. The
  // mod records it once; a repeat reports that first result and changes nothing.
  async spawnCrashSite() {
    await this.snapshot()
    const command = `${PREFIX}local g=remote.call("sgluna_deployment","status"); if not g.allowed or g.session~=${luaString(this.session)} then rcon.print(helpers.table_to_json({ok=false,code="session_not_owned"})) elseif not remote.interfaces.autorio_setup then rcon.print(helpers.table_to_json({ok=false,code="crash_site_setup_unsupported"})) else local j=remote.call("autorio_operation_admission","status"); local unresolved=false; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then unresolved=true end end; if unresolved then rcon.print(helpers.table_to_json({ok=false,code="unresolved_native_operation"})) else rcon.print(helpers.table_to_json(remote.call("autorio_setup","spawn_crash_site"))) end end`
    const result = json(await this.rcon.command(command))
    check(result?.ok === true, typeof result?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(result.code) ? result.code : 'crash_site_setup_failed')
    const items = Array.isArray(result.starter_items) ? result.starter_items : []
    return {
      already_done: result.already_done === true,
      tick: result.tick,
      position: result.position,
      entity_count: result.entity_count,
      entities: Array.isArray(result.entities) ? result.entities.map(entity => entity.name) : [],
      starter_items: items.map(item => ({ name: item.name, requested: item.requested, inserted: item.inserted })),
      freeplay_crash_site_disabled: result.freeplay_crash_site_disabled === true,
    }
  }

  async snapshot({ requireOwned = true } = {}) {
    const raw = json(await this.rcon.command(`${PREFIX}rcon.print(helpers.table_to_json({guard=remote.call("sgluna_deployment","status"),status=remote.call("autorio_operations","status"),journal=remote.call("autorio_operation_admission","status"),tick=game.tick,speed=game.speed}))`))
    const guard = raw.guard
    check(guard?.revision === REVISION && guard.mode === 'npc' && guard.actor_kind === 'standalone_character'
      && positive(guard.actor_id) && positive(guard.epoch), 'native_guard_invalid')
    const owned = guard.allowed === true && guard.session === this.session
    if (requireOwned) check(owned, 'session_not_owned', 'Stop competing controllers; this runtime cannot take over another session')
    check(Number.isSafeInteger(raw.journal?.high_water) && raw.journal.high_water >= 0, 'native_high_water_invalid')
    const status = normalizedStatus(raw.status)
    return {
      actor: { actor_id: guard.actor_id, epoch: guard.epoch, kind: guard.actor_kind,
        surface_index: guard.surface_index, position: status.actor?.position },
      guard, journal: { records: status.admission_journal, high_water: raw.journal.high_water },
      owned, tick: raw.tick, speed: raw.speed, high_water: raw.journal.high_water, status,
    }
  }

  async bindMachineDelivery(input) {
    try { validateMachineDeliveryBindingArgs(input) }
    catch { throw new BridgeError('invalid_machine_delivery_binding') }
    const before = await this.snapshot()
    const actor = before.actor
    const surface = before.guard.surface_index
    const force = before.guard.force_index
    check(positive(surface) && positive(force), 'machine_delivery_world_scope_unavailable')
    // Recheck ownership in the same native command as the metadata update.
    // No dynamic remote name, goal key, Lua or baseline can come from the model.
    const command = `${PREFIX}local g=remote.call("sgluna_deployment","status"); if g.allowed~=true or g.session~=${luaString(this.session)} or g.actor_id~=${actor.actor_id} or g.epoch~=${actor.epoch} or g.surface_index~=${surface} or g.force_index~=${force} then rcon.print(helpers.table_to_json({ok=false,error="machine_delivery_scope_changed"})) elseif not remote.interfaces.autorio_tools or not remote.interfaces.autorio_tools.bind_current_machine_delivery then rcon.print(helpers.table_to_json({ok=false,error="machine_delivery_binding_unsupported"})) else rcon.print(helpers.table_to_json(remote.call("autorio_tools","bind_current_machine_delivery",{unit_number=${input.unit_number}}))) end`
    const result = json(await this.rcon.command(command))
    const after = await this.snapshot()
    check(after.actor.actor_id === actor.actor_id && after.actor.epoch === actor.epoch
      && after.guard.surface_index === surface && after.guard.force_index === force, 'machine_delivery_scope_changed')
    check(result?.ok === true, typeof result?.error === 'string' && /^[a-z0-9_]{1,80}$/.test(result.error) ? result.error : 'machine_delivery_binding_refused')
    check(result.unit_number === input.unit_number && typeof result.acceptance_key === 'string', 'machine_delivery_binding_invalid_result')
    return { ...result, metadata_only: true, world_mutated: false, goal_verified: false }
  }

  async observe(name, args = {}) {
    check(OBSERVATION_NAMES.includes(name), 'observation_not_supported', `observation_not_supported: supported names are ${OBSERVATION_NAMES.join(', ')}`)
    let command
    try { command = toolCommand(name, args) }
    catch (error) {
      // Policy validation runs before any game call. Name the expected shape
      // instead of collapsing it into an opaque runtime error.
      const schema = observationDefinitions.find(tool => tool.function.name === name)?.function.parameters ?? {}
      const expected = Object.entries(schema.properties ?? {}).map(([key, value]) => `${key}${(schema.required ?? []).includes(key) ? '' : '?'}: ${value.type ?? 'value'}`).join(', ')
      if (!(error instanceof PolicyError)) throw error
      throw new BridgeError('invalid_observation_arguments', `${error.message.slice(0, 200)} for ${name}. Expected args {${expected}}. Nothing was sent to the game.`,
        { details: { observation: name, expected: schema } })
    }
    if (name === 'measureTransportThroughput') return this.measureThroughput(command, args)
    // Observations remain allowed after a control loss, to support diagnosis.
    const raw = await this.rcon.command(command)
    check(typeof raw === 'string' && Buffer.byteLength(raw) <= 48 * 1024, 'observation_too_large', 'Narrow the observation; replies are limited to 48 KiB')
    let result
    try { result = JSON.parse(raw.trim()) }
    catch { return { text: raw } }
    if (name === 'getResourceAmounts' && object(result)) {
      // Factorio serializes an empty Lua table as {}; these fields are lists (trial 4r: an empty area returned tiles {}).
      for (const key of ['resources', 'tiles', 'unseen_chunks']) if (Object.hasOwn(result, key)) result[key] = array(result[key])
    }
    return name === 'getPlacementCandidates' ? this.annotateCandidates(result) : result
  }

  // Measurements own one exact native ID and a bounded lifetime. The runtime
  // serializes this tool with submissions; authority is rechecked atomically on
  // start and every poll. A failed/expired sample is cancelled, never resumed.
  async measureThroughput(command, args) {
    check(command.startsWith(JSON_PREFIX) && command.endsWith('))'), 'measurement_renderer_changed')
    const snapshot = await this.snapshot()
    const actor = snapshot.actor
    const gate = `local g=remote.call("sgluna_deployment","status"); local s=remote.call("autorio_operations","status"); if g.allowed~=true or g.session~=${luaString(this.session)} or g.actor_id~=${actor.actor_id} or g.epoch~=${actor.epoch} or game.speed~=1 then return {ok=false,code="measurement_authority_changed"} end; if s.task_state~="idle" or s.queue_length~=0 or s.active_batch then return {ok=false,code="native_busy"} end; local j=remote.call("autorio_operation_admission","status"); for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then return {ok=false,code="unresolved_native_operation"} end end; `
    const start = json(await this.rcon.command(`${JSON_PREFIX}(function() ${gate} return ${command.slice(JSON_PREFIX.length, -2)} end)()))`))
    if (start.ok !== true) return start
    check(positive(start.measurement_id), 'measurement_identity_missing')
    const id = start.measurement_id
    let complete = false
    const budget = Math.min(180000, Math.max(15000, ((args.warmup_ticks ?? 60) + (args.window_ticks ?? 300)) * 50 + 10000))
    const deadline = Date.now() + budget
    let lastTick = start.started_tick, advancedAt = Date.now()
    try {
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250))
        const result = json(await this.rcon.command(`${JSON_PREFIX}(function() ${gate} return {tick=game.tick,result=remote.call("autorio_planning","throughput_measurement_status",${id})} end)()))`))
        check(result.result?.measurement_id === id, result.code ?? 'measurement_identity_changed')
        if (result.result.state !== 'running') { complete = true; return result.result }
        check(Number.isSafeInteger(result.tick) && result.tick >= lastTick, 'measurement_clock_rollback')
        if (result.tick > lastTick) { lastTick = result.tick; advancedAt = Date.now() }
        check(Date.now() - advancedAt <= 10000, 'measurement_clock_stalled')
      }
      throw new BridgeError('measurement_wall_timeout')
    }
    finally {
      if (!complete) await this.rcon.command(`${JSON_PREFIX}remote.call("autorio_planning","throughput_measurement_cancel",${id})))`)
    }
  }

  // The native candidate search applies can_place_entity only. Re-check each
  // returned footprint with the external placement rule so the operator sees
  // which candidates external placement would refuse. Native fields are kept.
  // A fluid join also needs the native guard to prove the joined network
  // (connects_to.preservation_network is the guard's own walk), so every
  // candidate of an unprovable join is marked too.
  async annotateCandidates(native) {
    if (native?.ok !== true || !Array.isArray(native.candidates) || native.candidates.length === 0) return native
    const network = native.connects_to?.preservation_network
    const result = network?.provable === false
      ? { ...native, candidates: native.candidates.map(candidate => ({ ...candidate, external_preservation: { eligible: false, code: prototypeName(network.reason) } })) }
      : native
    const rule = 'Footprint rule: items on the ground, characters and entities whose collision layers overlap the placed entity block external placement, which never clears them; non-colliding entities such as tree stumps do not. Fluid joins: external_preservation.eligible=false when connects_to.preservation_network is not provable. Other preflight checks still apply. covers_resources lists the resource tiles under a footprint by name (one resource entity per tile); it is a fact, not a refusal.'
    const rows = result.candidates.slice(0, ANNOTATED_CANDIDATES)
    const boxes = rows.map(row => row?.footprint?.world_box)
    if (!boxes.every(box => [box?.left_top?.x, box?.left_top?.y, box?.right_bottom?.x, box?.right_bottom?.y].every(Number.isFinite))) {
      return { ...result, external_placement: { rule, checked: false, reason: 'candidate_geometry_missing' } }
    }
    const literal = boxes.map(box => `{{${box.left_top.x},${box.left_top.y}},{${box.right_bottom.x},${box.right_bottom.y}}}`).join(',')
    let checked
    try {
      checked = json(await this.rcon.command(`${JSON_PREFIX}(function() ${FOOTPRINT_RULE_LUA} local a=remote.call("sgluna_deployment","status"); local surface=game.surfaces[a.surface_index]; if not surface then return {ok=false} end; local out={}; for i,box in ipairs({${literal}}) do local code,blockers=external_footprint(surface,box,nil,${typeof native.entity_name === 'string' && /^[a-z0-9][a-z0-9-]{0,99}$/.test(native.entity_name) ? luaString(native.entity_name) : 'nil'}); local res,seen={},{}; for _,r in pairs(surface.find_entities_filtered{area=box,type="resource",limit=256}) do local p=r.valid and r.position; if p and p.x>box[1][1] and p.x<box[2][1] and p.y>box[1][2] and p.y<box[2][2] then local k=seen[r.name]; if not k then k=#res+1; seen[r.name]=k; res[k]={name=r.name,tiles=0} end; res[k].tiles=res[k].tiles+1 end end; out[i]={code=code or "clear",blockers=blockers,resources=res} end; return {ok=true,tick=game.tick,rows=out} end)()))`))
    }
    catch { checked = undefined }
    if (checked?.ok !== true || !Array.isArray(checked.rows) || checked.rows.length !== rows.length) {
      return { ...result, external_placement: { rule, checked: false, reason: 'footprint_check_unavailable' } }
    }
    const candidates = result.candidates.map((candidate, index) => {
      if (index >= rows.length) return { ...candidate, external_footprint: { checked: false } }
      const code = checked.rows[index]?.code
      const covered = resourceCoverage(checked.rows[index]?.resources)
      const annotated = covered.length > 0 ? { ...candidate, covers_resources: covered } : candidate
      if (code === 'clear') return { ...annotated, external_footprint: { eligible: true } }
      return { ...annotated, external_footprint: { eligible: false, code: prototypeName(code), blockers: footprintBlockers(checked.rows[index]?.blockers) } }
    })
    const blocked = candidates.filter(candidate => candidate.external_footprint.eligible === false || candidate.external_preservation).length
    return { ...result, candidates, external_placement: { rule, checked: true, tick: checked.tick,
      eligible_candidate_count: candidates.filter(candidate => candidate.external_footprint.eligible === true && !candidate.external_preservation).length, blocked_candidate_count: blocked,
      ...(candidates.length > rows.length ? { unchecked_candidate_count: candidates.length - rows.length } : {}) } }
  }

  async prepare(rawOperation, key) {
    const operation = parseExternalOperation(rawOperation)
    check(typeof key === 'string' && /^[a-z0-9_/-]{1,120}$/i.test(key), 'invalid_operation_key')
    let snapshot, preflight
    // Deterministic refusals from this read-only phase are marked notSent; the
    // runtime labels only those as not_happened. Transport faults stay uncertain.
    try {
      snapshot = await this.snapshot()
      check(snapshot.speed === 1, 'nonstandard_game_speed')
      check(snapshot.status.task_state === 'idle' && snapshot.status.queue_length === 0 && !snapshot.status.active_batch, 'native_busy')
      check(!nativeAdmissionJournal(snapshot.status.admission_journal).unresolved, 'unresolved_native_operation')
      check(snapshot.high_water < Number.MAX_SAFE_INTEGER - 1, 'native_ordinal_exhausted')
      if (['place_entity', 'place_candidate'].includes(operation.name)) check(snapshot.status.placement_no_clear_supported === true, 'placement_safety_capability_missing')
      if (operation.name === 'place_candidate') check(snapshot.status.external_fluid_candidates_supported === 1, 'fluid_safety_capability_missing')
      if (operation.name === 'place_line') {
        check(snapshot.status.placement_no_clear_supported === true && snapshot.status.external_line_placement_supported === 1, 'line_placement_capability_missing')
        const position = snapshot.actor.position
        check(Number.isFinite(position?.x) && Number.isFinite(position?.y), 'operation_limit', 'every line tile must be within 128 tiles of the current actor, whose position is unavailable')
        const far = lineTiles(operation.args).map(tile => ({ ...tile, distance: Math.hypot(tile.x - position.x, tile.y - position.y) })).find(tile => tile.distance > 128)
        if (far) check(false, 'operation_limit', `Line tile ${far.index} at (${far.x}, ${far.y}) is ${far.distance.toFixed(1)} tiles from the actor at (${position.x}, ${position.y}); every tile must be within 128. The operation was not sent to the game.`,
          { details: { limit: 'walk_distance', maximum: 128, tile_index: far.index, distance: Math.round(far.distance * 10) / 10, actor_position: { x: position.x, y: position.y } } })
      }
      if (operation.name === 'pick_up_ground_items') {
        check(snapshot.status.external_ground_pickup_supported === 1, 'ground_pickup_capability_missing')
        const position = snapshot.actor.position
        check(Number.isFinite(position?.x) && Number.isFinite(position?.y), 'operation_limit', 'the pickup box must be within 128 tiles of the current actor, whose position is unavailable')
        const distance = Math.hypot(operation.args.x - position.x, operation.args.y - position.y)
        check(distance <= 128, 'operation_limit', `The pickup box is ${distance.toFixed(1)} tiles from the actor at (${position.x}, ${position.y}); the limit is 128. The operation was not sent to the game.`,
          { details: { limit: 'walk_distance', maximum: 128, distance: Math.round(distance * 10) / 10, actor_position: { x: position.x, y: position.y } } })
      }
      if (operation.name === 'walk_to_position') {
        const position = snapshot.actor.position
        check(Number.isFinite(position?.x) && Number.isFinite(position?.y), 'operation_limit', 'walk target must be within 128 tiles of the current actor, whose position is unavailable')
        const distance = Math.hypot(operation.args.x - position.x, operation.args.y - position.y)
        check(distance <= 128, 'operation_limit', `Walk target is ${distance.toFixed(1)} tiles from the actor at (${position.x}, ${position.y}); the limit is 128. The operation was not sent to the game. Walk to an intermediate point first.`,
          { details: { limit: 'walk_distance', maximum: 128, distance: Math.round(distance * 10) / 10, actor_position: { x: position.x, y: position.y } } })
      }
      preflight = json(await this.rcon.command(`${JSON_PREFIX}${preflightExpression(operation)}))`))
      if (preflight?.ok !== true) throw preflightFailure(preflight)
      if (operation.name === 'place_candidate') check(positive(preflight.preservation_join?.connects_to?.unit_number) || preflight.preservation_eligibility?.kind === 'relation_required', 'fluid_candidate_relation_unproven')
    }
    catch (error) {
      if (error instanceof BridgeError) error.notSent = true
      throw error
    }
    const pending = buildPendingOperation({ requestId: key, operationKey: key, attemptId: key,
      ordinal: snapshot.high_water + 1, protocolVersion: 2, operations: [operation], actor: snapshot.actor,
      baseline: batchWatermark(snapshot.status), now: Date.now(), surfaceIndex: snapshot.actor.surface_index, preflight: [preflight],
      ...(operation.name === 'place_candidate' ? { goalId: this.session, planId: 'external-fluid', stepId: key } : {}) })
    let preservation
    if (operation.name === 'place_candidate') {
      const target = preflight.preservation_join?.connects_to?.unit_number
      const isolated = !positive(target)
      const owner = { goal_id: pending.goal_id, plan_id: pending.plan_id, plan_version: 1, step_id: pending.step_id,
        semantic_step_id: pending.step_id, actor_id: pending.actor.actor_id, actor_epoch: pending.actor.epoch, session: this.session }
      const context = { signature: pending.signature, owner, ...(isolated ? { isolated: true } : {}) }
      const frozen = json(await this.rcon.command(`${JSON_PREFIX}remote.call("autorio_preflight","fluid_preservation_candidate",${luaString(operation.args.candidate_set_id)},${luaString(operation.args.candidate_id)},${luaString(key)},{${isolated ? '' : target}},helpers.json_to_table(${luaString(JSON.stringify(context))}))))`))
      const nativeCode = typeof frozen.code === 'string' && /^[a-z0-9_]{1,80}$/.test(frozen.code) ? frozen.code : 'unknown'
      const overLimit = nativeCode === 'preservation_guard_network_over_limit' && positive(frozen.limit) && positive(frozen.entity_count_at_least)
      check(frozen.ok === true && frozen.preservation_join?.version === 4, 'fluid_preservation_refused', `Native fluid preservation refused: ${nativeCode}.${overLimit
        ? ` The fluid network this candidate joins has at least ${frozen.entity_count_at_least} entities; the native preservation guard proves at most ${frozen.limit} (connects_to.preservation_network in getPlacementCandidates).`
        : ''} The operation was not sent to the game.`, { notAdmitted: true, details: { native_code: nativeCode,
        ...(overLimit ? { limit: frozen.limit, entity_count_at_least: frozen.entity_count_at_least } : {}) } })
      preservation = { version: 2, operation_key: key, attempt_id: pending.attempt_id, ordinal: pending.ordinal,
        signature: pending.signature, owner, candidate: frozen.preservation_join }
    }
    return { operation, pending, preflight, ...(preservation ? { preservation } : {}), observed_before: await this.effectProbe(operation, (Array.isArray(preflight?.items) ? preflight.items : []).map(item => item?.name)) }
  }

  // Read-only actor position and relevant inventory counts, for a labelled
  // before/after comparison on terminal receipts. Failure yields null; it never
  // blocks or fails an operation.
  // found: the item names a pick_up_ground_items preflight listed (the runtime passes the names in observed_before back).
  async effectProbe(operation, found) {
    try {
      const items = effectItems(operation, found)
      const raw = json(await this.rcon.command(`${PREFIX}local g=remote.call("sgluna_deployment","status"); local e=g.actor_id and game.get_entity_by_unit_number(g.actor_id); if not e or not e.valid or e.type~="character" then rcon.print(helpers.table_to_json({ok=false})) else local counts={}; for _,n in pairs({${items.map(luaString).join(',')}}) do local ok,c=pcall(e.get_item_count,n); if ok then counts[n]=c end end; rcon.print(helpers.table_to_json({ok=true,tick=game.tick,actor_id=g.actor_id,position=e.position,items=counts})) end`))
      if (raw?.ok !== true || !Number.isSafeInteger(raw.tick) || !Number.isFinite(raw.position?.x) || !Number.isFinite(raw.position?.y)) return null
      const counts = {}
      for (const name of items) if (Number.isSafeInteger(raw.items?.[name])) counts[name] = raw.items[name]
      return { tick: raw.tick, actor_id: raw.actor_id, position: { x: raw.position.x, y: raw.position.y }, items: counts }
    }
    catch { return null }
  }

  // Caller MUST durably store prepared before this call. The transport is sent
  // once; even a missing acknowledgement is never retried by this bridge.
  async submit(prepared) {
    const operation = parseExternalOperation(prepared?.operation)
    const pending = prepared.pending
    identity(pending)
    check(operationSignature([operation]) === pending.signature, 'prepared_signature_mismatch')
    check(positive(pending.baseline?.generation), 'invalid_pending_baseline')
    const ack = marker()
    const session = luaString(this.session)
    const walkGate = operation.name === 'walk_to_position'
      ? `local p=s.actor and s.actor.position; if not p or (p.x-(${operation.args.x}))^2+(p.y-(${operation.args.y}))^2>16384 then return "walk_out_of_range" end; ` : ''
    const pickupGate = operation.name === 'pick_up_ground_items'
      ? `if s.external_ground_pickup_supported~=1 then return "ground_pickup_capability_missing" end; local p=s.actor and s.actor.position; if not p or (p.x-(${operation.args.x}))^2+(p.y-(${operation.args.y}))^2>16384 then return "walk_out_of_range" end; ` : ''
    const lineGate = operation.name === 'place_line'
      ? `local p=s.actor and s.actor.position; if not p then return "walk_out_of_range" end; for _,t in ipairs({${lineTiles(operation.args).map(tile => `{${tile.x},${tile.y}}`).join(',')}}) do if (p.x-(t[1]))^2+(p.y-(t[2]))^2>16384 then return "walk_out_of_range" end end; ` : ''
    const placementGate = ['place_entity', 'place_candidate', 'place_line'].includes(operation.name) ? `if s.placement_no_clear_supported~=true then return "placement_safety_capability_missing" end; ${operation.name === 'place_candidate' ? 'if s.external_fluid_candidates_supported~=1 then return "fluid_safety_capability_missing" end; ' : ''}${operation.name === 'place_line' ? 'if s.external_line_placement_supported~=1 then return "line_placement_capability_missing" end; ' : ''}` : ''
    if (operation.name === 'place_candidate') check(prepared.preservation?.candidate?.owner?.session === this.session, 'fluid_preservation_required')
    const gate = `local g=remote.call("sgluna_deployment","status"); if g.session~=${session} or g.allowed~=true or g.actor_id~=${pending.actor.actor_id} or g.epoch~=${pending.actor.epoch} then return "session_or_actor_changed" end; if game.speed~=1 then return "nonstandard_game_speed" end; local s=remote.call("autorio_operations","status"); if s.task_state~="idle" or s.queue_length~=0 or s.active_batch then return "native_busy" end; if s.batch_generation~=${pending.baseline.generation} then return "native_generation_changed" end; ${walkGate}${lineGate}${pickupGate}${placementGate}local j=remote.call("autorio_operation_admission","status"); if j.high_water~=${pending.ordinal - 1} then return "ordinal_not_fresh" end; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then return "unresolved_native_operation" end end; local p=${preflightExpression(operation)}; if p.ok~=true then return "preflight_rejected"..${REFUSAL_DETAIL_LUA}(p) end; return nil`
    const guardedRcon = { command: async command => {
      check(command.startsWith(PREFIX), 'batch_renderer_changed')
      return this.rcon.command(`${PREFIX}local refusal=(function() ${gate} end)(); if refusal then rcon.print(${luaString(ack)}..helpers.table_to_json({ok=false,result="external_guard_refused:"..refusal,prefix={}})) else ${command.slice(PREFIX.length)} end`)
    } }
    try {
      const result = await executeAuthorizedBatch(guardedRcon, pending.actor.epoch, [renderExternalOperation(operation)], ack, pending, prepared.preservation)
      return { admitted: true, admission: result.admission }
    }
    catch (error) {
      const refusal = parseGuardRefusal(error.factorioError)
      if (refusal && !error.admission && (Array.isArray(error.results) ? error.results.length === 0 : object(error.results) && Object.keys(error.results).length === 0)) {
        error.notAdmitted = true
        error.code = refusal.code
        // The atomic re-run of the preflight refused: name its native cause, as a prepare-time refusal does.
        if (refusal.details) error.details = refusal.details
      }
      throw error
    }
  }

  async receipt(pending) {
    identity(pending)
    const snapshot = await this.snapshot({ requireOwned: false })
    const reconciliation = reconcilePendingOperation(pending, { status: snapshot.status, actor: snapshot.actor })
    const admission = snapshot.status.admission_journal.find(row => row.operation_key === pending.operation_key)
    const refs = admission?.slots.flatMap(slot => slot.batch_refs) ?? []
    const receipts = snapshot.status.receipt_journal.filter(receipt => refs.some(ref => ref.batch_ref === receipt.batch_ref
      && ref.batch_id === receipt.batch_id && ref.batch_generation === receipt.batch_generation))
    let state = disposition(reconciliation)
    let line
    if (pending.operations?.[0]?.name === 'place_line') {
      line = await this.lineEvidence(reconciliation, refs, pending.operations[0].identity)
      // A line counts as completed only when the native record of exactly this request lists every tile as placed.
      const whole = line && line.refusal === null && line.placed_count === line.count && line.placed.every((entity, index) => entity.index === index && Number.isSafeInteger(entity.unit_number))
      if (state.state === 'completed' && !whole) {
        state = { ...state, state: 'uncertain', reason: 'line_receipt_incomplete', terminal: false, execution_completed: false }
      }
    }
    return { ...state, owned: snapshot.owned, high_water: snapshot.high_water,
      requires_reconciliation: ['cancelled', 'partial', 'uncertain'].includes(state.state),
      ...(line !== undefined ? { line_placement: line } : {}),
      evidence: { admission: admission ?? null, receipts, tick: snapshot.tick,
        // The last basic result is not assumed correlated. Its batch identity is
        // checked below before inclusion; absent/legacy evidence stays absent.
        ...(snapshot.status.basic_operation?.batch_ref && refs.some(ref => ref.batch_ref === snapshot.status.basic_operation.batch_ref)
          ? { basic_operation: snapshot.status.basic_operation } : {}) } }
  }

  // Read-only native line record for this admission's single batch. Returns
  // null when it is unavailable; never treated as completion on its own.
  async lineEvidence(reconciliation, refs, requestIdentity) {
    const ref = refs.length === 1 ? refs[0] : undefined
    if (!ref || typeof ref.batch_ref !== 'string') return null
    let raw
    try { raw = json(await this.rcon.command(`${JSON_PREFIX}remote.call("autorio_operations","line_placement_status",${luaString(ref.batch_ref)})))`)) }
    catch { return null }
    const line = raw?.ok === true ? raw.line : undefined
    if (!object(line) || line.batch_ref !== ref.batch_ref || line.batch_id !== ref.batch_id || line.batch_generation !== ref.batch_generation) return null
    // The pending ledger keeps only the request's identity digest; the native record must reproduce it from its own arguments.
    const recorded = { name: 'place_line', args: { entity_name: line.entity_name, x: line.origin?.x, y: line.origin?.y, direction: line.direction,
      line_direction: line.line_direction, count: line.count, spacing: line.spacing } }
    if (typeof requestIdentity !== 'string' || operationIdentity(recorded) !== requestIdentity) return null
    const point = p => ({ x: p?.x, y: p?.y })
    const placed = (Array.isArray(line.placed) ? line.placed : []).slice(0, MAX_LINE_PLACEMENTS).map(entity => ({
      index: entity.index, unit_number: entity.unit_number, position: point(entity.position), direction: entity.direction }))
    const refusal = object(line.refusal) ? { index: line.refusal.index, code: prototypeName(line.refusal.code),
      ...(Array.isArray(line.refusal.blockers) ? { blockers: footprintBlockers(line.refusal.blockers) } : {}) } : null
    return { line_id: line.line_id, entity_name: line.entity_name, count: line.count, placed, placed_count: placed.length,
      refusal, source: reconciliation?.verdict === 'admitted_partial' ? 'native_line_record_sealed_partial' : 'native_line_record' }
  }

  async cancel(pending) {
    identity(pending)
    // A single native callback rechecks session, exact admission and active
    // batch. Never cancel another controller's or a later operation's work.
    const key = luaString(pending.operation_key)
    const command = `${PREFIX}local g=remote.call("sgluna_deployment","status"); local ok=false; local code="session_or_actor_changed"; if g.session==${luaString(this.session)} and g.allowed==true and g.actor_id==${pending.actor.actor_id} and g.epoch==${pending.actor.epoch} then local j=remote.call("autorio_operation_admission","status",${key}); local r=j.records[1]; local s=remote.call("autorio_operations","status"); code="operation_not_active"; if r and r.operation_key==${key} and r.signature==${luaString(pending.signature)} and r.attempt_id==${luaString(pending.attempt_id)} and r.actor_id==${pending.actor.actor_id} and r.epoch==${pending.actor.epoch} and r.ordinal==${pending.ordinal} and r.state=="admitted" and r.operation_count==1 and #r.slots==1 and #r.slots[1].batch_refs==1 and s.active_batch then local ref=r.slots[1].batch_refs[1]; if ref.batch_ref==s.active_batch.batch_ref and ref.batch_id==s.active_batch.batch_id and ref.batch_generation==s.active_batch.batch_generation and r.slots[1].queued_tasks==s.active_batch.task_count then ok=remote.call("autorio_operations","cancel_all_tasks")==true; code=ok and "cancel_requested" or "cancel_failed" end end end; rcon.print(helpers.table_to_json({ok=ok,code=code}))`
    const answer = json(await this.rcon.command(command))
    // Cancel acknowledgement is not a gameplay receipt. Always re-observe.
    return { cancellation: answer, receipt: await this.receipt(pending) }
  }
}
