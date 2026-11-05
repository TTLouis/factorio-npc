import { randomBytes } from 'node:crypto'

import { nativeAdmissionJournal } from '../../deploy/pterodactyl/staging/native-admission-journal.mjs'
import { executeAuthorizedBatch } from '../../deploy/pterodactyl/staging/supervisor-adapter.mjs'
import { luaString, PolicyError } from '../../deploy/pterodactyl/staging/structured-policy.mjs'
import {
  batchWatermark,
  buildPendingOperation,
  operationSignature,
  reconcilePendingOperation,
} from '../../deploy/pterodactyl/runtime-v8/operation-reconciliation.mjs'
import {
  operationTypeCatalog,
  parseOperation,
  renderOperation,
  renderOperationPreflight,
  toolCommand,
  toolDefinitions,
} from '../../deploy/pterodactyl/runtime-v8/structured-policy.mjs'

// This is an intentionally smaller capability surface, not an alternate policy.
// Nonfluid sites require native zero-fluidbox witnesses. Fluid candidates use
// the shared frozen native preservation claim and exact v2 admission owner.
export const PLACEMENT_PROTOTYPES = Object.freeze(['stone-furnace', 'burner-mining-drill', 'wooden-chest', 'lab', 'small-electric-pole', 'assembling-machine-1', 'transport-belt', 'inserter', 'burner-inserter'])
export const FLUID_PLACEMENT_PROTOTYPES = Object.freeze(['offshore-pump', 'boiler', 'steam-engine', 'pipe', 'electric-mining-drill'])
export const OPERATION_NAMES = Object.freeze(['wait', 'walk_to_position', 'craft_item', 'mine_resource_at', 'move_items_exact', 'place_entity', 'harvest_product', 'research_technology', 'place_candidate', 'set_machine_recipe'])
export const OBSERVATION_NAMES = Object.freeze([
  'getActorStatus', 'getInventoryItems', 'getEquipmentStatus', 'getRecipeDetails',
  'getPrototypeDetails', 'discoverPrototypes', 'getNearbyEntities', 'getEntityStatus',
  'getCraftingStatus', 'getNavigationStatus', 'getTechnology', 'getResearchStatus',
  'getPlacementCandidates', 'getFluidSourceTiles', 'getEntityGeometry', 'getTransportCapacity',
  'getResourceAmounts',
])
export const observationDefinitions = toolDefinitions.filter(tool => OBSERVATION_NAMES.includes(tool.function.name))
export function capabilities() {
  return { operations: operationTypeCatalog().filter(operation => OPERATION_NAMES.includes(operation.name)),
    observations: [...OBSERVATION_NAMES], observation_schemas: observationDefinitions.map(tool => ({
      name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters,
    })), limits: { wait_ticks: 3600, count: 100, transfer_count: 1000, walk_distance: 128, fluid_network_entities: 16, placement_prototypes: [...PLACEMENT_PROTOTYPES], fluid_candidate_prototypes: [...FLUID_PLACEMENT_PROTOTYPES], harvest_radius: 64, placement_requires_exact_grid: true, placement_clearing: false },
    operation_notes: { ...OPERATION_NOTES }, observation_notes: { ...OBSERVATION_NOTES } }
}

// Semantics the shared catalog leaves implicit and operators misread in the
// 2026-11-01 trial. Facts about this bridge, not strategy advice.
export const OPERATION_NOTES = Object.freeze({
  craft_item: 'count is the number of recipe crafts, not items. A recipe with N products per craft yields count x N items (read getRecipeDetails products).',
  place_entity: 'direction uses Factorio defines.direction values (0 north, 4 east, 8 south, 12 west). For inserters it names the pickup side; drop is opposite. Verify pickup/drop with getEntityGeometry after placement. getPlacementCandidates rows with external_footprint.eligible=false will be refused. No pickup or deconstruct operation exists, so placements are permanent.',
  place_candidate: 'A fluid candidate that joins an entity (connects_to) needs the native preservation guard to prove that entity\'s whole connected fluid network, at most 16 entities. getPlacementCandidates reports this as connects_to.preservation_network (provable, entity_count, limit; unit_number names an entity the guard cannot read, for example one not visible now) and marks such candidates external_preservation.eligible=false. They are refused before they are sent. A join to a network of 16 brings it to 17; a network of 17 or more cannot be joined.',
  research_technology: 'A completed receipt means research was started and queued, not finished. While other force research is active the request is appended behind it in the native queue (queued_behind) and the labs reach it when the earlier work finishes; queue the next technology before the current one completes so labs never idle. Read getResearchStatus or getTechnology for progress and researched.',
  walk_to_position: 'Target must be within 128 tiles of the current actor position.',
  move_items_exact: 'May walk the actor into reach first. A terminal receipt includes observed_effect with the actor inventory delta for item_name and the actor position before and after.',
  harvest_product: 'Searches up to 64 tiles and may walk the actor there. A terminal receipt includes observed_effect with the actor inventory delta for product_name and the actor position before and after.',
  submit_refusals: 'A factorio_submit error with effect "not_happened" means this call was refused before its operation was sent to the game and used no journal slot. An error without that field may have had an effect; read the receipt or native state. Placement refusals name blockers in details. A refusal during atomic admission instead returns a rejected receipt.',
  running_receipts: 'A running receipt includes observed_progress: the actor position and inventory delta for the operation\'s item so far, read when the reply is sent. It is an observation of the actor, not a native progress count.',
})
// Native observation semantics the same operator misread: where a radius is
// centred and what a visibility refusal means.
export const OBSERVATION_NOTES = Object.freeze({
  getNearbyEntities: 'radius is centred on the actor\'s current position (actor_position in the result), not where an earlier call ran. Operations that walk the actor move that centre.',
  getEntityStatus: 'Reads only chunks the force sees live now (Factorio force chunk visibility: near the actor, or radar coverage). entity_not_visible means there is no live vision there, not that the entity is gone. status and status_name are the native defines.entity_status values.',
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
function preflightExpression(operation) {
  const command = renderOperationPreflight(operation)
  if (!command) return '{ok=true,validation="not_required"}'
  check(command.startsWith(JSON_PREFIX) && command.endsWith('))'), 'preflight_renderer_changed')
  const expression = command.slice(JSON_PREFIX.length, -2)
  if (operation.name === 'set_machine_recipe') {
    // This external capability is only for the bounded nonfluid assembler.
    // Read both static and actual native fluidboxes, even when empty/disabled;
    // rerun the same witness inside atomic admission, not just during prepare.
    const unit = operation.args.unit_number
    return `(function() local p=${expression}; if p.ok~=true then return p end; local t=p.target; local a=remote.call("sgluna_deployment","status"); local e=game.get_entity_by_unit_number(${unit}); if not e and t and t.position and t.surface_index==a.surface_index and t.force_index==a.force_index then local s=game.surfaces[t.surface_index]; if s then for _,candidate in pairs(s.find_entities_filtered({position=t.position,radius=0.25,name=t.name,force=a.force_index,limit=2})) do if candidate.valid and candidate.unit_number==${unit} then e=candidate end end end end; if not t or t.unit_number~=${unit} or not e or not e.valid or e.unit_number~=t.unit_number or e.name~="assembling-machine-1" or e.name~=t.name or e.type~="assembling-machine" or e.surface.index~=a.surface_index or e.force.index~=a.force_index or e.surface.index~=t.surface_index or e.force.index~=t.force_index then return {ok=false,code="external_recipe_target_unproven"} end; local ok,w=pcall(function() local boxes=e.prototype.fluidbox_prototypes; if type(boxes)~="table" then return nil end; for _,box in pairs(boxes) do return nil end; if #e.fluidbox~=0 then return nil end; return {version=1,unit_number=e.unit_number,entity_name=e.name,surface_index=e.surface.index,force_index=e.force.index,prototype_fluidbox_count=0,fluidbox_count=0} end); if not ok or not w then return {ok=false,code="external_recipe_target_unproven"} end; p.external_recipe_nonfluid=w; return p end)()`
  }
  if (!['place_entity', 'place_candidate'].includes(operation.name)) return expression
  if (operation.name === 'place_candidate') return `(function() ${FOOTPRINT_RULE_LUA} local p=${expression}; if p.ok~=true then return p end; local f=p.planned_footprint; local n=f and f.entity_name; if not f or not f.world_box or not (${FLUID_PLACEMENT_PROTOTYPES.map(name => `n==${luaString(name)}`).join(' or ')}) or p.preservation_clears_count~=0 then return {ok=false,code="external_candidate_unproven"} end; local actor=remote.call("sgluna_deployment","status"); local surface=game.surfaces[actor.surface_index]; if not surface then return {ok=false,code="external_candidate_unproven"} end; ${FOOTPRINT_CHECK_LUA} return p end)()`
  const { entity_name: name, x, y, direction = 0 } = operation.args
  // Consume the same native footprint and nonfluid witness as the full runtime;
  // never infer dimensions, snapping or fluid ports from a vanilla name.
  return `(function() ${FOOTPRINT_RULE_LUA} local p=${expression}; if p.ok~=true then return p end; local w=p.preservation_nonfluid_output; local f=p.planned_footprint; if not w or w.fluid_port_count~=0 or w.entity_name~=${luaString(name)} or not f or not f.world_box then return {ok=false,code="nonfluid_footprint_unproven"} end; if f.position.x~=${x} or f.position.y~=${y} then return {ok=false,code="exact_grid_required",planned_footprint=f} end; local surface=game.surfaces[w.surface_index]; local force=game.forces[w.force_index]; if not surface or not force or not surface.can_place_entity({name=${luaString(name)},position=f.position,direction=${direction},force=force,build_check_type=defines.build_check_type.manual}) then return {ok=false,code="placement_not_clear"} end; ${FOOTPRINT_CHECK_LUA} return p end)()`
}

// Any non-resource entity in the footprint blocks external placement, including
// items on the ground and characters that can_place_entity (and therefore the
// native candidate search) accepts. One Lua definition serves placement preflight
// and candidate annotation so they cannot disagree. It names up to eight blockers
// so the operator can tell an item on the ground from a real structure; clearing
// is still never attempted.
const FOOTPRINT_RULE_LUA = 'local function external_footprint(surface,box) local found=surface.find_entities_filtered({area=box,limit=129}); if #found>=129 then return "placement_footprint_dense",{} end; local blockers={}; for _,e in pairs(found) do if e.valid and e.type~="resource" and #blockers<8 then blockers[#blockers+1]={name=e.name,type=e.type,position=e.position,unit_number=e.unit_number,item=e.type=="item-entity" and e.stack and e.stack.valid_for_read and e.stack.name or nil} end end; if #blockers>0 then return "placement_footprint_occupied",blockers end; return nil,blockers end;'
const FOOTPRINT_CHECK_LUA = 'local code,blockers=external_footprint(surface,f.world_box); if code=="placement_footprint_dense" then return {ok=false,code=code} end; if code then return {ok=false,code=code,blockers=blockers,planned_footprint=f} end;'
const ANNOTATED_CANDIDATES = 8 // getPlacementCandidates limit maximum

const PREFLIGHT_HINTS = Object.freeze({
  placement_footprint_occupied: 'The footprint contains non-resource entities (see details.blockers). getPlacementCandidates marks such candidates external_footprint.eligible=false; external placement refuses items on the ground and characters and never clears them. Choose another position.',
  placement_not_clear: 'can_place_entity refused this exact position and direction. Read fresh getPlacementCandidates for the same prototype.',
  exact_grid_required: 'The native footprint snaps to a different center; use details.planned_footprint.position exactly.',
  placement_footprint_dense: 'The footprint area holds too many entities to inspect; choose another position.',
  nonfluid_footprint_unproven: 'No native zero-fluidbox witness for this prototype at this site; use place_candidate for fluid prototypes.',
})

function prototypeName(value) { return typeof value === 'string' && /^[a-z0-9_-]{1,100}$/.test(value) ? value : 'unknown' }

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
  return new BridgeError('preflight_rejected', `Native preflight rejected: ${code}. The operation was not sent to the game.${summary} ${Object.hasOwn(PREFLIGHT_HINTS, code) ? PREFLIGHT_HINTS[code] : 'Re-observe the target before choosing different arguments.'}`.trim(),
    { notAdmitted: true, details: { native_code: code, ...(blockers ? { blockers } : {}), ...(footprint ? { planned_footprint: footprint } : {}) } })
}

// Items whose actor-inventory count an operation is expected to change. Used for
// before/after observation only; never as attribution or goal proof.
function effectItems(operation) {
  const args = operation.args ?? {}
  const name = { craft_item: args.item_name, harvest_product: args.product_name, move_items_exact: args.item_name,
    mine_resource_at: args.resource_name, place_entity: args.entity_name }[operation.name]
  return typeof name === 'string' && /^[a-z0-9_-]{1,100}$/.test(name) ? [name] : []
}

export function renderExternalOperation(raw) {
  const operation = parseExternalOperation(raw)
  const command = renderOperation(operation)
  // This safety argument is NOT model-selectable. The native endpoint forwards
  // it to the existing execution-time refuse_clearance task invariant.
  return operation.name === 'place_entity' ? `${command.slice(0, -1)},true)` : command
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

export function parseExternalOperation(raw) {
  const operation = parseOperation(raw?.name === 'harvest_product' && raw.args?.search_radius === undefined
    ? { ...raw, args: { ...raw.args, search_radius: 64 } } : raw)
  check(OPERATION_NAMES.includes(operation.name), 'operation_not_supported', 'This external mode does not enable that operation')
  // The inherited parser is authoritative; these are additional experiment limits.
  if (operation.name === 'wait') check(operation.args.ticks <= 3600, 'operation_limit', 'wait is bounded to 3600 ticks')
  if (operation.name === 'craft_item' || operation.name === 'mine_resource_at') check(operation.args.count <= 100, 'operation_limit', 'count is bounded to 100')
  if (operation.name === 'place_entity') check(PLACEMENT_PROTOTYPES.includes(operation.args.entity_name)
    && Number.isFinite(operation.args.x) && Number.isFinite(operation.args.y), 'placement_not_supported', 'Use explicit coordinates for an allowed nonfluid prototype')
  if (operation.name === 'harvest_product') {
    check(operation.args.count <= 100 && operation.args.search_radius <= 64, 'operation_limit', 'Harvest is bounded to 100 items within 64 tiles')
  }
  if (operation.name === 'move_items_exact') check(operation.args.max_count <= 1000, 'operation_limit', 'max_count is bounded to 1000')
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
    const command = `${PREFIX}local g=remote.call("sgluna_deployment","status"); local s=remote.call("autorio_operations","status"); if g.session~="" then rcon.print(helpers.table_to_json({ok=false,code="session_already_bound"})) elseif s.task_state~="idle" or s.queue_length~=0 or s.active_batch then rcon.print(helpers.table_to_json({ok=false,code="native_busy"})) else local j=remote.call("autorio_operation_admission","status"); local unresolved=false; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then unresolved=true end end; if unresolved then rcon.print(helpers.table_to_json({ok=false,code="unresolved_native_operation"})) else local result=remote.call("sgluna_deployment","configure","npc",${luaString(this.session)}); rcon.print(helpers.table_to_json({ok=result==${luaString(this.session)}})) end end`
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
    // Observations remain allowed after a control loss, to support diagnosis.
    const raw = await this.rcon.command(command)
    check(typeof raw === 'string' && Buffer.byteLength(raw) <= 48 * 1024, 'observation_too_large', 'Narrow the observation; replies are limited to 48 KiB')
    let result
    try { result = JSON.parse(raw.trim()) }
    catch { return { text: raw } }
    return name === 'getPlacementCandidates' ? this.annotateCandidates(result) : result
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
    const rule = 'Footprint rule: non-resource entities in the footprint (items on the ground, characters) block external placement, which never clears them. Fluid joins: external_preservation.eligible=false when connects_to.preservation_network is not provable. Other preflight checks still apply.'
    const rows = result.candidates.slice(0, ANNOTATED_CANDIDATES)
    const boxes = rows.map(row => row?.footprint?.world_box)
    if (!boxes.every(box => [box?.left_top?.x, box?.left_top?.y, box?.right_bottom?.x, box?.right_bottom?.y].every(Number.isFinite))) {
      return { ...result, external_placement: { rule, checked: false, reason: 'candidate_geometry_missing' } }
    }
    const literal = boxes.map(box => `{{${box.left_top.x},${box.left_top.y}},{${box.right_bottom.x},${box.right_bottom.y}}}`).join(',')
    let checked
    try {
      checked = json(await this.rcon.command(`${JSON_PREFIX}(function() ${FOOTPRINT_RULE_LUA} local a=remote.call("sgluna_deployment","status"); local surface=game.surfaces[a.surface_index]; if not surface then return {ok=false} end; local out={}; for i,box in ipairs({${literal}}) do local code,blockers=external_footprint(surface,box); out[i]={code=code or "clear",blockers=blockers} end; return {ok=true,tick=game.tick,rows=out} end)()))`))
    }
    catch { checked = undefined }
    if (checked?.ok !== true || !Array.isArray(checked.rows) || checked.rows.length !== rows.length) {
      return { ...result, external_placement: { rule, checked: false, reason: 'footprint_check_unavailable' } }
    }
    const candidates = result.candidates.map((candidate, index) => {
      if (index >= rows.length) return { ...candidate, external_footprint: { checked: false } }
      const code = checked.rows[index]?.code
      if (code === 'clear') return { ...candidate, external_footprint: { eligible: true } }
      return { ...candidate, external_footprint: { eligible: false, code: prototypeName(code), blockers: footprintBlockers(checked.rows[index]?.blockers) } }
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
      baseline: batchWatermark(snapshot.status), now: Date.now(), surfaceIndex: snapshot.actor.surface_index,
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
    return { operation, pending, preflight, ...(preservation ? { preservation } : {}), observed_before: await this.effectProbe(operation) }
  }

  // Read-only actor position and relevant inventory counts, for a labelled
  // before/after comparison on terminal receipts. Failure yields null; it never
  // blocks or fails an operation.
  async effectProbe(operation) {
    try {
      const items = effectItems(operation)
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
    const placementGate = ['place_entity', 'place_candidate'].includes(operation.name) ? `if s.placement_no_clear_supported~=true then return "placement_safety_capability_missing" end; ${operation.name === 'place_candidate' ? 'if s.external_fluid_candidates_supported~=1 then return "fluid_safety_capability_missing" end; ' : ''}` : ''
    if (operation.name === 'place_candidate') check(prepared.preservation?.candidate?.owner?.session === this.session, 'fluid_preservation_required')
    const gate = `local g=remote.call("sgluna_deployment","status"); if g.session~=${session} or g.allowed~=true or g.actor_id~=${pending.actor.actor_id} or g.epoch~=${pending.actor.epoch} then return "session_or_actor_changed" end; if game.speed~=1 then return "nonstandard_game_speed" end; local s=remote.call("autorio_operations","status"); if s.task_state~="idle" or s.queue_length~=0 or s.active_batch then return "native_busy" end; if s.batch_generation~=${pending.baseline.generation} then return "native_generation_changed" end; ${walkGate}${placementGate}local j=remote.call("autorio_operation_admission","status"); if j.high_water~=${pending.ordinal - 1} then return "ordinal_not_fresh" end; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then return "unresolved_native_operation" end end; local p=${preflightExpression(operation)}; if p.ok~=true then return "preflight_rejected" end; return nil`
    const guardedRcon = { command: async command => {
      check(command.startsWith(PREFIX), 'batch_renderer_changed')
      return this.rcon.command(`${PREFIX}local refusal=(function() ${gate} end)(); if refusal then rcon.print(${luaString(ack)}..helpers.table_to_json({ok=false,result="external_guard_refused:"..refusal,prefix={}})) else ${command.slice(PREFIX.length)} end`)
    } }
    try {
      const result = await executeAuthorizedBatch(guardedRcon, pending.actor.epoch, [renderExternalOperation(operation)], ack, pending, prepared.preservation)
      return { admitted: true, admission: result.admission }
    }
    catch (error) {
      if (/^external_guard_refused:(?:session_or_actor_changed|nonstandard_game_speed|native_busy|ordinal_not_fresh|unresolved_native_operation|preflight_rejected|walk_out_of_range|placement_safety_capability_missing|fluid_safety_capability_missing|native_generation_changed)$/.test(error.factorioError ?? '')
        && !error.admission && (Array.isArray(error.results) ? error.results.length === 0 : object(error.results) && Object.keys(error.results).length === 0)) {
        error.notAdmitted = true
        error.code = error.factorioError.slice('external_guard_refused:'.length)
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
    return { ...disposition(reconciliation), owned: snapshot.owned, high_water: snapshot.high_water,
      requires_reconciliation: ['cancelled', 'partial', 'uncertain'].includes(disposition(reconciliation).state),
      evidence: { admission: admission ?? null, receipts, tick: snapshot.tick,
        // The last basic result is not assumed correlated. Its batch identity is
        // checked below before inclusion; absent/legacy evidence stays absent.
        ...(snapshot.status.basic_operation?.batch_ref && refs.some(ref => ref.batch_ref === snapshot.status.basic_operation.batch_ref)
          ? { basic_operation: snapshot.status.basic_operation } : {}) } }
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
