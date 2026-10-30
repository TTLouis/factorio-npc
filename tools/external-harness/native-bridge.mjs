import { randomBytes } from 'node:crypto'

import { nativeAdmissionJournal } from '../../deploy/pterodactyl/staging/native-admission-journal.mjs'
import { executeAuthorizedBatch } from '../../deploy/pterodactyl/staging/supervisor-adapter.mjs'
import { luaString } from '../../deploy/pterodactyl/staging/structured-policy.mjs'
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
// Advanced placement requires the autonomous runtime's preservation obligations.
export const PLACEMENT_PROTOTYPES = Object.freeze(['stone-furnace', 'burner-mining-drill', 'wooden-chest'])
export const OPERATION_NAMES = Object.freeze(['wait', 'walk_to_position', 'craft_item', 'mine_resource_at', 'move_items_exact', 'place_entity'])
export const OBSERVATION_NAMES = Object.freeze([
  'getActorStatus', 'getInventoryItems', 'getEquipmentStatus', 'getRecipeDetails',
  'getPrototypeDetails', 'discoverPrototypes', 'getNearbyEntities', 'getEntityStatus',
  'getCraftingStatus', 'getNavigationStatus',
])
export const observationDefinitions = toolDefinitions.filter(tool => OBSERVATION_NAMES.includes(tool.function.name))
export function capabilities() {
  return { operations: operationTypeCatalog().filter(operation => OPERATION_NAMES.includes(operation.name)),
    observations: [...OBSERVATION_NAMES], observation_schemas: observationDefinitions.map(tool => ({
      name: tool.function.name, description: tool.function.description, inputSchema: tool.function.parameters,
    })), limits: { wait_ticks: 3600, count: 100, transfer_count: 1000, walk_distance: 128, placement_prototypes: [...PLACEMENT_PROTOTYPES], placement_requires_exact_grid: true, placement_clearing: false } }
}
const MAX_REPLY_BYTES = 512 * 1024
const PREFIX = '/silent-command '
const JSON_PREFIX = `${PREFIX}rcon.print(helpers.table_to_json(`
const REVISION = 'sgluna-deploy-v8-npc-staging'

export class BridgeError extends Error {
  constructor(code, message = code, { notAdmitted = false } = {}) {
    super(message)
    this.code = code
    this.notAdmitted = notAdmitted
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
  if (operation.name !== 'place_entity') return expression
  const { entity_name: name, x, y, direction = 0 } = operation.args
  // Consume the same native footprint and nonfluid witness as the full runtime;
  // never infer dimensions, snapping or fluid ports from a vanilla name.
  return `(function() local p=${expression}; if p.ok~=true then return p end; local w=p.preservation_nonfluid_output; local f=p.planned_footprint; if not w or w.fluid_port_count~=0 or w.entity_name~=${luaString(name)} or not f or not f.world_box then return {ok=false,code="nonfluid_footprint_unproven"} end; if f.position.x~=${x} or f.position.y~=${y} then return {ok=false,code="exact_grid_required",planned_footprint=f} end; local surface=game.surfaces[w.surface_index]; local force=game.forces[w.force_index]; if not surface or not force or not surface.can_place_entity({name=${luaString(name)},position=f.position,direction=${direction},force=force,build_check_type=defines.build_check_type.manual}) then return {ok=false,code="placement_not_clear"} end; local found=surface.find_entities_filtered({area=f.world_box,limit=129}); if #found>=129 then return {ok=false,code="placement_footprint_dense"} end; for _,entity in pairs(found) do if entity.valid and entity.type~="resource" then return {ok=false,code="placement_footprint_occupied"} end end; return p end)()`
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
  const operation = parseOperation(raw)
  check(OPERATION_NAMES.includes(operation.name), 'operation_not_supported', 'This external mode does not enable that operation')
  // The inherited parser is authoritative; these are additional experiment limits.
  if (operation.name === 'wait') check(operation.args.ticks <= 3600, 'operation_limit', 'wait is bounded to 3600 ticks')
  if (operation.name === 'craft_item' || operation.name === 'mine_resource_at') check(operation.args.count <= 100, 'operation_limit', 'count is bounded to 100')
  if (operation.name === 'place_entity') check(PLACEMENT_PROTOTYPES.includes(operation.args.entity_name)
    && Number.isFinite(operation.args.x) && Number.isFinite(operation.args.y), 'placement_not_supported', 'Use explicit coordinates for an allowed nonfluid prototype')
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
    check(result.ok === true, result.code ?? 'bind_failed')
    return this.snapshot()
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
    check(OBSERVATION_NAMES.includes(name), 'observation_not_supported')
    const command = toolCommand(name, args)
    // Observations remain allowed after a control loss, to support diagnosis.
    const raw = await this.rcon.command(command)
    check(typeof raw === 'string' && Buffer.byteLength(raw) <= 48 * 1024, 'observation_too_large', 'Narrow the observation; replies are limited to 48 KiB')
    try { return JSON.parse(raw.trim()) }
    catch { return { text: raw } }
  }

  async prepare(rawOperation, key) {
    const operation = parseExternalOperation(rawOperation)
    check(typeof key === 'string' && /^[a-z0-9_/-]{1,120}$/i.test(key), 'invalid_operation_key')
    const snapshot = await this.snapshot()
    check(snapshot.speed === 1, 'nonstandard_game_speed')
    check(snapshot.status.task_state === 'idle' && snapshot.status.queue_length === 0 && !snapshot.status.active_batch, 'native_busy')
    check(!nativeAdmissionJournal(snapshot.status.admission_journal).unresolved, 'unresolved_native_operation')
    check(snapshot.high_water < Number.MAX_SAFE_INTEGER - 1, 'native_ordinal_exhausted')
    if (operation.name === 'place_entity') check(snapshot.status.placement_no_clear_supported === true, 'placement_safety_capability_missing')
    if (operation.name === 'walk_to_position') {
      const position = snapshot.actor.position
      check(Number.isFinite(position?.x) && Number.isFinite(position?.y)
        && Math.hypot(operation.args.x - position.x, operation.args.y - position.y) <= 128, 'operation_limit', 'walk target must be within 128 tiles of the current actor')
    }
    const preflight = json(await this.rcon.command(`${JSON_PREFIX}${preflightExpression(operation)}))`))
    check(preflight?.ok === true, 'preflight_rejected', `Native preflight rejected: ${typeof preflight?.code === 'string' ? preflight.code : 'unknown'}`, { notAdmitted: true })
    const pending = buildPendingOperation({ requestId: key, operationKey: key, attemptId: key,
      ordinal: snapshot.high_water + 1, protocolVersion: 2, operations: [operation], actor: snapshot.actor,
      baseline: batchWatermark(snapshot.status), now: Date.now(), surfaceIndex: snapshot.actor.surface_index })
    return { operation, pending, preflight }
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
    const placementGate = operation.name === 'place_entity' ? 'if s.placement_no_clear_supported~=true then return "placement_safety_capability_missing" end; ' : ''
    const gate = `local g=remote.call("sgluna_deployment","status"); if g.session~=${session} or g.allowed~=true or g.actor_id~=${pending.actor.actor_id} or g.epoch~=${pending.actor.epoch} then return "session_or_actor_changed" end; if game.speed~=1 then return "nonstandard_game_speed" end; local s=remote.call("autorio_operations","status"); if s.task_state~="idle" or s.queue_length~=0 or s.active_batch then return "native_busy" end; if s.batch_generation~=${pending.baseline.generation} then return "native_generation_changed" end; ${walkGate}${placementGate}local j=remote.call("autorio_operation_admission","status"); if j.high_water~=${pending.ordinal - 1} then return "ordinal_not_fresh" end; for _,r in pairs(j.records) do if r.state=="admitting" or r.state=="admitted" or r.state=="uncertain" then return "unresolved_native_operation" end end; local p=${preflightExpression(operation)}; if p.ok~=true then return "preflight_rejected" end; return nil`
    const guardedRcon = { command: async command => {
      check(command.startsWith(PREFIX), 'batch_renderer_changed')
      return this.rcon.command(`${PREFIX}local refusal=(function() ${gate} end)(); if refusal then rcon.print(${luaString(ack)}..helpers.table_to_json({ok=false,result="external_guard_refused:"..refusal,prefix={}})) else ${command.slice(PREFIX.length)} end`)
    } }
    try {
      const result = await executeAuthorizedBatch(guardedRcon, pending.actor.epoch, [renderExternalOperation(operation)], ack, pending)
      return { admitted: true, admission: result.admission }
    }
    catch (error) {
      if (/^external_guard_refused:(?:session_or_actor_changed|nonstandard_game_speed|native_busy|ordinal_not_fresh|unresolved_native_operation|preflight_rejected|walk_out_of_range|placement_safety_capability_missing|native_generation_changed)$/.test(error.factorioError ?? '')
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
