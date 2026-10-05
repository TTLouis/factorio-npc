import crypto from 'node:crypto'

export class StagingSessionError extends Error {}

export class OperationBatchAdmissionError extends StagingSessionError {
  constructor(message, { operationIndex, factorioError, output, results, admission, notAdmitted } = {}) {
    super(message)
    // The game answered that nothing was recorded or run (begin refused before any journal entry).
    this.notAdmitted = notAdmitted === true
    this.operationIndex = operationIndex
    this.factorioError = factorioError
    this.output = output
    this.noReplay = true
    this.results = results ?? []
    this.admission = admission
  }
}

function sanitizedAdmissionText(value, max = 2000) {
  return String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/Bearer\s+[a-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]')
    .replace(/\b(OPENAI_API_KEY|FACTORIO_TOKEN|API_KEY|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .slice(0, max)
}

function check(ok, message) {
  if (!ok) throw new StagingSessionError(message)
}

// Everything thrown before the first byte is sent to RCON provably never reached the game.
function notSent(error) {
  if (error && typeof error === 'object') error.notSent = true
  return error
}

// Mod admission begin() refusals: each is returned before any journal record or operation exists.
const REFUSED_BEFORE_RECORD = new Set(['invalid_correlation', 'stale_actor_epoch', 'expired_operation_ordinal', 'admission_journal_full', 'stale npc actor epoch'])

function operationName(command) {
  return /^remote\.call\((?:"|')autorio_operations(?:"|'),\s*(?:"|')([a-z_]+)(?:"|')/.exec(command)?.[1] ?? ''
}

function luaString(value) {
  check(typeof value === 'string' && Buffer.byteLength(value) <= 16384, 'Invalid Lua string')
  return `"${value.replace(/[\\"\x00-\x1f\x7f]/g, c => c === '\\' ? '\\\\' : c === '"' ? '\\"' : `\\${String(c.charCodeAt(0)).padStart(3, '0')}`)}"`
}

function parseJson(text, context) {
  try {
    return JSON.parse(String(text).trim())
  }
  catch {
    throw new StagingSessionError(`Invalid JSON from ${context}`)
  }
}

function parseAcknowledgement(raw, marker) {
  const text = String(raw)
  const position = text.lastIndexOf(marker)
  if (position < 0) return null
  try {
    return {
      data: JSON.parse(text.slice(position + marker.length).trim()),
      output: text.slice(0, position).trim(),
    }
  }
  catch {
    return null
  }
}

function acknowledgement(raw, marker, context) {
  const parsed = parseAcknowledgement(raw, marker)
  check(parsed, `Game command acknowledgement missing; ${context} will not be retried`)
  check(parsed.data.ok === true, `Game command failed; ${context} will not be retried`)
  return parsed
}

export async function deploymentStatus(rcon, { requireAllowed = false } = {}) {
  const raw = await rcon.command('/silent-command rcon.print(helpers.table_to_json(remote.call("sgluna_deployment","status")))')
  const status = parseJson(raw, 'sgluna_deployment.status')
  check(status.revision === 'sgluna-deploy-v8-npc-staging', 'Unexpected deployment guard revision')
  check(status.mode === 'npc', 'Deployment guard is not in npc mode')
  if (requireAllowed) check(status.allowed === true, 'NPC deployment session is not authorized')
  else check(typeof status.allowed === 'boolean', 'Deployment guard has no authorization state')
  check(status.actor_kind === 'standalone_character', 'Deployment guard is not bound to a standalone NPC')
  check(Number.isSafeInteger(status.actor_id) && status.actor_id > 0, 'Deployment guard has no stable NPC identity')
  check(Number.isSafeInteger(status.epoch) && status.epoch > 0, 'Deployment guard has no valid epoch')
  check(typeof status.idle === 'boolean', 'Deployment guard has no idle state')
  check(status.actor_interface === true && status.operations === true && status.tools === true, 'Required Autorio interfaces are missing')
  return status
}

export async function configureNpcSession(rcon, session, marker = `SGLUNA_CONFIG_${crypto.randomBytes(12).toString('hex')}:`) {
  check(typeof session === 'string' && session.length >= 16 && session.length <= 256 && !/[\x00-\x1f\x7f]/.test(session), 'Invalid deployment session token')
  check(/^SGLUNA_CONFIG_[a-f0-9]{24}:$/.test(marker), 'Invalid configure acknowledgement marker')

  const command = `/silent-command local ok,result=pcall(function() return remote.call("sgluna_deployment","configure","npc",${luaString(session)}) end); rcon.print(${luaString(marker)}..helpers.table_to_json({ok=ok,result=result}))`

  for (let bindAttempt = 1; bindAttempt <= 2; bindAttempt++) {
    let raw = await rcon.command(command)
    let parsed = parseAcknowledgement(raw, marker)
    if (!parsed) {
      raw = await rcon.command(command)
      parsed = parseAcknowledgement(raw, marker)
    }
    check(parsed, 'Game command acknowledgement missing; configure retry exhausted')
    check(parsed.data.ok === true, `Game command failed; configure retry exhausted: ${JSON.stringify(parsed.data.result)}`)
    check(parsed.data.result === session, `NPC deployment configure handshake failed: ${JSON.stringify(parsed.data.result)}`)

    const status = await deploymentStatus(rcon)
    if (status.allowed === true && status.session === session) return status

    if (bindAttempt === 2) {
      check(status.allowed === true, 'NPC deployment session is not authorized')
      check(status.session === session, 'Deployment status session does not match configure token')
    }
  }

  throw new StagingSessionError('NPC deployment session rebind retry exhausted')
}

export function validatedOperationCall(command) {
  check(typeof command === 'string' && command.length > 0 && command.length <= 4096, 'Invalid operation command')
  check(!/[\r\n\0]/.test(command), 'Operation command contains forbidden control characters')
  check(/^remote\.call\((?:"|')autorio_operations(?:"|'),/.test(command), 'Only validated autorio_operations calls may mutate the game')
  return command
}

export async function executeAuthorizedOperation(rcon, epoch, command, marker = `SGLUNA_RESULT_${crypto.randomBytes(12).toString('hex')}:`) {
  check(Number.isSafeInteger(epoch) && epoch > 0, 'Invalid deployment epoch')
  validatedOperationCall(command)
  check(/^SGLUNA_RESULT_[a-f0-9]{24}:$/.test(marker), 'Invalid operation acknowledgement marker')

  const wrapped = `/silent-command local ok,result=pcall(function() if not remote.call("sgluna_deployment","authorize",${epoch}) then error("stale npc actor epoch") end; return ${command} end); rcon.print(${luaString(marker)}..helpers.table_to_json({ok=ok,result=result}))`
  const parsed = acknowledgement(await rcon.command(wrapped), marker, 'operation')
  check(parsed.data.result !== false && !(Array.isArray(parsed.data.result) && parsed.data.result[0] === false), 'Autorio rejected operation')
  return {
    result: parsed.data.result,
    output: parsed.output,
  }
}

export async function executeAuthorizedBatch(rcon, epoch, commands, marker = `SGLUNA_RESULT_${crypto.randomBytes(12).toString('hex')}:`, correlation) {
  let prepared
  try {
    prepared = prepareAuthorizedBatch(epoch, commands, marker, correlation)
  }
  catch (error) {
    throw notSent(error)
  }
  return sendAuthorizedBatch(rcon, epoch, prepared, marker, correlation)
}

function prepareAuthorizedBatch(epoch, commands, marker, correlation) {
  check(Number.isSafeInteger(epoch) && epoch > 0, 'Invalid deployment epoch')
  check(Array.isArray(commands) && commands.length >= 1 && commands.length <= 16, 'Invalid operation batch')
  const validated = commands.map(validatedOperationCall)
  check(/^SGLUNA_RESULT_[a-f0-9]{24}:$/.test(marker), 'Invalid operation acknowledgement marker')

  if (correlation?.protocol_version === 2) {
    const identity = { operation_key: correlation.operation_key, attempt_id: correlation.attempt_id,
      signature: correlation.signature, actor_id: correlation.actor?.actor_id, epoch, ordinal: correlation.ordinal, operation_count: validated.length }
    check(typeof identity.operation_key === 'string' && identity.operation_key.length > 0 && identity.operation_key.length <= 192 && typeof identity.attempt_id === 'string'
      && typeof identity.signature === 'string' && Number.isSafeInteger(identity.actor_id) && Number.isSafeInteger(identity.ordinal) && identity.ordinal > 0, 'Invalid operation correlation')
    const key = luaString(identity.operation_key)
    const admissions = validated.map((command, index) => {
      const slot = index + 1
      // A refusal is a returned false / false-first tuple; a thrown error is not. Only the mod decides what a refusal proves.
      return `local ok${slot},r${slot}=pcall(function() return ${command} end); local accepted=ok${slot} and r${slot}~=false and not(type(r${slot})=="table" and (r${slot}[1]==false or r${slot}.accepted==false or r${slot}.ok==false)); local refused=ok${slot} and not accepted; local detail=nil; if not ok${slot} then detail=tostring(r${slot}) elseif refused then detail=(type(r${slot})=="table" and r${slot}[2]~=nil) and tostring(r${slot}[2]) or "rejected" end; local snap=remote.call("autorio_".."operations","status"); local refs={}; if snap.active_batch then refs[1]={batch_id=snap.active_batch.batch_id,batch_generation=snap.active_batch.batch_generation,batch_ref=snap.active_batch.batch_ref} end; local stored=remote.call("autorio_operation_admission","slot",${key},${slot},{ok=accepted,result=ok${slot} and r${slot} or nil,error=detail,operation=${luaString(operationName(command))},refused=refused,batch_refs=refs}); if not stored.ok then error("admission slot recording failed: "..tostring(stored.error),0) end; if not accepted then local message="autorio rejected operation ${slot}: "..tostring(detail); local final=remote.call("autorio_operation_admission","finish",${key},{ok=false,error=message}); receipt=final.record; error(message,0) end; results[${slot}]=r${slot}`
    }).join('; ')
    const wrapped = `/silent-command local prefix={}; local receipt=nil; local ok,result=pcall(function() if not remote.call("sgluna_deployment","authorize",${epoch}) then error("stale npc actor epoch",0) end; local b=remote.call("autorio_operation_admission","begin",helpers.json_to_table(${luaString(JSON.stringify(identity))})); if not b.ok then error(tostring(b.error),0) end; if b.duplicate then receipt=b.record; error("duplicate operation admission; reconcile exact record",0) end; local results={}; prefix=results; ${admissions}; local final=remote.call("autorio_operation_admission","finish",${key},{ok=true}); receipt=final.record; if not final.ok then error(tostring(final.error),0) end; return results end); rcon.print(${luaString(marker)}..helpers.table_to_json({ok=ok,result=result,prefix=prefix,admission=receipt}))`
    return { wrapped, validated, v2: true }
  }
  const admissions = validated.map((command, index) => {
    const slot = index + 1
    return `local ok${slot},r${slot}=pcall(function() return ${command} end); if not ok${slot} then error("autorio operation ${slot} failed: "..tostring(r${slot}),0) end; if r${slot}==false or (type(r${slot})=="table" and (r${slot}[1]==false or r${slot}.accepted==false or r${slot}.ok==false)) then error("autorio rejected operation ${slot}: "..helpers.table_to_json(r${slot}),0) end; results[${slot}]=r${slot}`
  }).join('; ')
  const wrapped = `/silent-command local ok,result=pcall(function() if not remote.call("sgluna_deployment","authorize",${epoch}) then error("stale npc actor epoch",0) end; local results={}; ${admissions}; return results end); rcon.print(${luaString(marker)}..helpers.table_to_json({ok=ok,result=result}))`
  return { wrapped, validated, v2: false }
}

async function sendAuthorizedBatch(rcon, epoch, { wrapped, validated, v2 }, marker) {
  if (v2) {
    const parsed = parseAcknowledgement(await rcon.command(wrapped), marker)
    check(parsed, 'Game command acknowledgement missing; operation batch will not be retried')
    if (parsed.data.ok !== true) {
      const factorioError = sanitizedAdmissionText(parsed.data.result)
      const match = /autorio (?:operation|rejected operation) (\d+)/i.exec(factorioError)
      throw new OperationBatchAdmissionError(`Game command failed; reconcile retained operation prefix: ${factorioError}`, {
        operationIndex: match ? Number(match[1]) - 1 : undefined, factorioError, results: parsed.data.prefix,
        admission: parsed.data.admission, output: sanitizedAdmissionText(parsed.output),
        notAdmitted: !parsed.data.admission && REFUSED_BEFORE_RECORD.has(factorioError),
      })
    }
    check(Array.isArray(parsed.data.result) && parsed.data.result.length === validated.length, 'Invalid Autorio batch acknowledgement')
    return { results: parsed.data.result, admission: parsed.data.admission, output: parsed.output }
  }
  const parsed = parseAcknowledgement(await rcon.command(wrapped), marker)
  check(parsed, 'Game command acknowledgement missing; operation batch will not be retried')
  if (parsed.data.ok !== true) {
    const factorioError = sanitizedAdmissionText(parsed.data.result)
    const match = /autorio (?:operation|rejected operation) (\d+)/i.exec(factorioError)
    const operationIndex = match ? Number(match[1]) - 1 : undefined
    throw new OperationBatchAdmissionError(
      `Game command failed; operation batch was not replayed because earlier operations may have produced side effects: ${factorioError || 'unknown Factorio/Autorio error'}`,
      { operationIndex, factorioError, output: sanitizedAdmissionText(parsed.output) },
    )
  }
  check(Array.isArray(parsed.data.result) && parsed.data.result.length === validated.length, 'Invalid Autorio batch acknowledgement')
  return {
    results: parsed.data.result,
    output: parsed.output,
  }
}

export function actorChanged(previous, current) {
  if (!previous || !current) return true
  return previous.mode !== current.mode
    || previous.actor_id !== current.actor_id
    || previous.actor_kind !== current.actor_kind
    || previous.epoch !== current.epoch
}
