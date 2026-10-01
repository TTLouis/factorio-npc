// MW1 reserved supplies: the PROVISIONAL chat command that marks a container reserved.
//
// STATUS: provisional, pending the owner. The design note (docs/NPC_MACRO_EXECUTION_DESIGN_2026-09-30.md, "Still
// open") has not chosen the exact syntax or the release rule. Everything that depends on the choice lives in THIS
// file so changing it is a one-file edit:
//
//   syntax        a whole chat message that is exactly "reserve" or "unreserve", optionally followed by
//                 "this"/"that"/"the" and "chest"/"container"/"storage" (so `!luna reserve` and `!luna reserve this chest`).
//                 Whole-message only: a goal that merely starts with "reserve ..." is NOT taken as the command.
//   target        the container the sender has SELECTED (the entity under their cursor); if none, the nearest container
//                 within RESERVE_NEAREST_RADIUS tiles of the sender. Wooden/iron/steel chests are `container`;
//                 requester/provider chests are `logistic-container`.
//   release rule  only an explicit "unreserve" on the same container releases it. A reservation never expires, is never
//                 released by the NPC, and survives a restart and a new goal (world facts, planning-state authorization).
//   map tag       the owner also named a map tag as a marker; it is NOT implemented here (needs a tag listener in the mod).
//
// The record and the exclusion check are NOT provisional: see authorization.mjs (recordReservation, evaluateOperationAdmission).

import { luaString } from './structured-policy.mjs'

export const RESERVE_COMMAND_STATUS = 'provisional_pending_owner'
export const RESERVE_NEAREST_RADIUS = 8
export const RESERVABLE_ENTITY_TYPES = Object.freeze(['container', 'logistic-container'])

const RESERVE_PATTERN = /^\s*(reserve|unreserve)(?:\s+(?:this|that|the))?(?:\s+(?:chest|container|storage))?\s*[.!]?\s*$/i

/** `{ action: 'reserve' | 'release' }` for a reserve/unreserve command, otherwise null. */
export function parseReserveCommand(text) {
  const match = RESERVE_PATTERN.exec(String(text ?? ''))
  if (!match) return null
  return { action: match[1].toLowerCase() === 'reserve' ? 'reserve' : 'release' }
}

/** The read-only game query that resolves the targeted container for `playerName`. Prints one JSON line. */
export function reserveTargetLookupCommand(playerName) {
  const types = RESERVABLE_ENTITY_TYPES.map(type => `'${type}'`).join(',')
  const reservableCheck = RESERVABLE_ENTITY_TYPES.map(type => `t.type=='${type}'`).join(' or ')
  return `/silent-command local p=game.get_player(${luaString(String(playerName ?? ''))}); `
    + 'if not p then rcon.print(helpers.table_to_json({ok=false,code=\'no_player\'})) else '
    + 'local t=p.selected; '
    + `if not (t and t.valid and t.unit_number and (${reservableCheck})) then `
    + `t=nil; local best=${(RESERVE_NEAREST_RADIUS * RESERVE_NEAREST_RADIUS) + 1}; `
    + `for _,e in pairs(p.surface.find_entities_filtered{position=p.position,radius=${RESERVE_NEAREST_RADIUS},type={${types}}}) do `
    + 'if e.unit_number then local d=(e.position.x-p.position.x)^2+(e.position.y-p.position.y)^2; '
    + 'if d<best then best=d; t=e end end end end; '
    + 'if not t then rcon.print(helpers.table_to_json({ok=false,code=\'no_container\'})) else '
    + 'rcon.print(helpers.table_to_json({ok=true,unit_number=t.unit_number,name=t.name,surface_index=t.surface.index,position=t.position})) end end'
}

export function parseReserveTarget(raw) {
  let parsed
  try { parsed = JSON.parse(String(raw ?? '').trim()) }
  catch { return { ok: false, code: 'lookup_failed' } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, code: 'lookup_failed' }
  if (parsed.ok !== true) return { ok: false, code: typeof parsed.code === 'string' ? parsed.code : 'lookup_failed' }
  if (!Number.isSafeInteger(parsed.unit_number) || parsed.unit_number < 1) return { ok: false, code: 'lookup_failed' }
  return {
    ok: true,
    unit_number: parsed.unit_number,
    entity_name: typeof parsed.name === 'string' ? parsed.name : undefined,
    surface_index: Number.isSafeInteger(parsed.surface_index) ? parsed.surface_index : undefined,
    position: parsed.position && Number.isFinite(parsed.position.x) && Number.isFinite(parsed.position.y)
      ? { x: parsed.position.x, y: parsed.position.y }
      : undefined,
  }
}

const NO_TARGET_MESSAGES = Object.freeze({
  no_player: 'I could not find you in the game to see which container you mean.',
  no_container: `Select or stand next to a chest (within ${RESERVE_NEAREST_RADIUS} tiles) and say it again.`,
  lookup_failed: 'I could not read which container you mean.',
})

/**
 * Resolve the targeted container and record (or release) the reservation. Returns { ok, message, ... }; `message` is
 * the chat reply. Never throws on a game or lookup failure.
 */
export async function executeReserveCommand({ rcon, memory, key, sender, command, now = Date.now(), requestId }) {
  let target
  try { target = parseReserveTarget(await rcon.command(reserveTargetLookupCommand(sender))) }
  catch { target = { ok: false, code: 'lookup_failed' } }
  if (!target.ok) return { ok: false, code: target.code, message: NO_TARGET_MESSAGES[target.code] ?? NO_TARGET_MESSAGES.lookup_failed }

  const label = `${target.entity_name ?? 'container'} #${target.unit_number}`
  if (command?.action === 'release') {
    const released = memory.releaseReservation(key, { unit_number: target.unit_number, released_by: sender }, { now, requestId, source: 'user' })
    return released.ok
      ? { ok: true, code: 'released', unit_number: target.unit_number, message: `Released ${label}; I may use its contents again.` }
      : { ok: false, code: 'not_reserved', unit_number: target.unit_number, message: `${label} was not reserved.` }
  }
  const reserved = memory.recordReservation(key, {
    unit_number: target.unit_number,
    entity_name: target.entity_name,
    surface_index: target.surface_index,
    position: target.position,
    reserved_by: sender,
  }, { now, requestId, source: 'user' })
  if (reserved.ok) {
    return { ok: true, code: 'reserved', unit_number: target.unit_number, reservation: reserved.reservation, message: `Reserved ${label}: I will not take anything from it. Say "unreserve" next to it to release it.` }
  }
  return { ok: false, code: 'already_reserved', unit_number: target.unit_number, message: `${label} is already reserved.` }
}
