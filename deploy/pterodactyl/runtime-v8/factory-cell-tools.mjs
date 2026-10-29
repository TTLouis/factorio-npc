import { luaString } from '../staging/structured-policy.mjs'
import { deploymentStatus } from '../staging/supervisor-adapter.mjs'
import { nativeAdmissionJournal } from '../staging/native-admission-journal.mjs'
import { createFactoryCellObserver } from './factory-cell-observation.mjs'
import { FactoryRegistryError } from './factory-registry.mjs'
import { getActivePlan } from './planning-state.mjs'

const names = new Set(['listFactoryCells', 'inspectFactoryCell'])
const fail = code => { throw new FactoryRegistryError(code, /stale|world_mismatch|owner_mismatch/.test(code) ? `${code}: observation cancelled or superseded` : code) }
export const isFactoryCellTool = name => names.has(name)
const tool = (name, description, properties, required = []) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } })
export const factoryCellToolDefinitions = [
  tool('listFactoryCells', 'List persistent production assignments. First use may initialize native world UUID metadata; no gameplay or assignment changes. Use next_offset for omitted cells. Declarations do not prove supply or production.', {
    offset: { type: 'integer', minimum: 0, maximum: 256, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32, default: 16 },
  }),
  tool('inspectFactoryCell', 'Read exact registered members and native compatibility, including before a plan is committed. Optional direct-feed binding requires committed step material supply. First use may initialize native world UUID metadata; no gameplay or assignment changes.', {
    cell_id: { type: 'string', pattern: '^cell-[1-9][0-9]*$', maxLength: 32 },
    binding: { type: 'object', additionalProperties: false, required: ['source_unit_number', 'target_unit_number'], properties: {
      source_unit_number: { type: 'integer', minimum: 1 }, target_unit_number: { type: 'integer', minimum: 1 }, product: { type: 'string', minLength: 1, maxLength: 160 },
    } },
  }, ['cell_id']),
]

function exact(raw, keys) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) fail('factory_tool_arguments_invalid')
  for (const key of Reflect.ownKeys(raw)) {
    const desc = Object.getOwnPropertyDescriptor(raw, key)
    if (!keys.includes(key) || !desc.enumerable || !Object.hasOwn(desc, 'value')) fail('factory_tool_arguments_invalid')
  }
}
export function validateFactoryCellTool(name, args) {
  if (!isFactoryCellTool(name)) fail('factory_tool_unknown')
  exact(args, name === 'listFactoryCells' ? ['offset', 'limit'] : ['cell_id', 'binding'])
  if (name === 'listFactoryCells') {
    const offset = args.offset ?? 0; const limit = args.limit ?? 16
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 256 || !Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('factory_tool_arguments_invalid')
    return { offset, limit }
  }
  if (typeof args.cell_id !== 'string' || !/^cell-[1-9][0-9]*$/.test(args.cell_id) || args.cell_id.length > 32
    || !Number.isSafeInteger(Number(args.cell_id.slice(5)))) fail('factory_tool_cell_id_invalid')
  if (Object.hasOwn(args, 'binding')) {
    exact(args.binding, ['source_unit_number', 'target_unit_number', 'product'])
    for (const key of ['source_unit_number', 'target_unit_number']) if (!Number.isSafeInteger(args.binding[key]) || args.binding[key] < 1) fail('factory_binding_invalid')
    if (args.binding.source_unit_number === args.binding.target_unit_number) fail('factory_binding_invalid')
    if (Object.hasOwn(args.binding, 'product') && (typeof args.binding.product !== 'string' || !args.binding.product.trim() || args.binding.product.length > 160 || /[\u0000-\u001f\u007f]/u.test(args.binding.product))) fail('factory_binding_invalid')
  }
  return structuredClone(args)
}

/** Preserve valid JSON and explicit omission counts within the ordinary tool cap. */
export function projectFactoryCellResult(value, limit = 12000) {
  const result = structuredClone(value)
  result.projection = { omitted: false, omitted_native_members: 0, omitted_cells: 0, omitted_checks: 0, omitted_dependencies: 0 }
  for (const cell of result.cells ?? []) {
    if (JSON.stringify(cell).length <= 6000) continue
    const assignment = cell.assignment
    cell.assignment = { products: assignment.products.slice(0, 8), purpose: assignment.purpose.slice(0, 512), method: assignment.method.slice(0, 512) }
    cell.assignment_omissions = { products: assignment.products.length - cell.assignment.products.length,
      purpose_chars: assignment.purpose.length - cell.assignment.purpose.length, method_chars: assignment.method.length - cell.assignment.method.length }
    result.projection.omitted = true
  }
  const fit = () => JSON.stringify(result).length <= limit
  for (const [rows, counter] of [[result.native?.members, 'omitted_native_members'], [result.cells, 'omitted_cells'], [result.checks, 'omitted_checks'], [result.dependencies, 'omitted_dependencies']]) {
    while (!fit() && Array.isArray(rows) && rows.length) { rows.pop(); result.projection[counter]++; result.projection.omitted = true }
  }
  if (!fit()) fail('factory_tool_projection_limit')
  if (Array.isArray(result.cells)) result.next_offset = result.offset + result.cells.length < result.total_cells ? result.offset + result.cells.length : null
  return JSON.stringify(result)
}

const parse = raw => {
  try { const value = JSON.parse(String(raw)); if (value && typeof value === 'object') return value }
  catch { /* Refuse unreadable native evidence. */ }
  fail('factory_tool_native_unreadable')
}
const nativeRead = async read => {
  try { return await read() }
  catch { fail('factory_tool_native_unavailable') }
}

/** Host-created capability; provider JSON never supplies this callback or Lua. */
export function prepareFactoryCellTool(agent, name, rawArgs) {
  return prepareFactoryCellAccess(agent, name, validateFactoryCellTool(name, rawArgs))
}

// Internal capability for committed enrollment/world validation. Never exposed
// in tool definitions or provider JSON; read tools retain their existing path.
export function prepareFactoryCellHost(agent, action) {
  if (typeof action !== 'function') fail('factory_host_action_required')
  return prepareFactoryCellAccess(agent, 'factoryCellEnrollment', {}, action)
}

// Trusted host declaration bridge only. No model tool, observation publication,
// endpoint verification or gameplay authority is added by this transaction.
export async function commitFactoryCellMetadata(agent, change) {
  if (!agent.stateFile) fail('factory_metadata_persistence_unavailable')
  const traceOwner = Object.freeze({ request: agent.traceRequest, requestId: agent.traceRequest?.id,
    actorId: agent.epoch?.actor_id, actorEpoch: agent.epoch?.epoch, sessionId: agent.epoch?.session, turn: agent.continuations + 1 })
  return prepareFactoryCellHost(agent, async (observer, access) => {
    const runtime = observer.runtime; const scope = runtime.scope()
    let prepared
    try { prepared = runtime.prepareMetadata(change, scope) }
    catch (error) {
      if (agent.memory.factoryRegistryStatus().status === 'fault') {
        try { await agent.persistState({ strict: true }) } catch { /* Original committed transaction remains on disk; never retry publication. */ }
      }
      throw error
    }
    if (prepared.duplicate) return prepared
    const { ticket } = prepared
    try {
      await agent.persistState({ strict: true, requiredFactoryMetadata: { ticket, phase: 'prepare' } })
      await access.refresh(); access.fence()
      await agent.persistState({ strict: true, requiredFactoryMetadata: { ticket, phase: 'commit' } })
      access.fence()
      const cell = agent.memory.finishFactoryMetadata(ticket)
      access.acceptPublishedRevision()
      await agent.traceEvent('factory_metadata.published', { request_id: scope.request_id, session_id: scope.session_id,
        goal_id: scope.goal_id, plan_id: scope.plan_id, cell_id: cell.cell_id, cell_revision: cell.revision,
        transaction_id: change.transaction_id, state: 'unverified' })
      return { duplicate: false, cell }
    } catch (error) {
      agent.memory.abortFactoryMetadata(ticket)
      // WAL restoration already fails closed if candidate commit did not land.
      // Fault persistence is best effort when storage or request ownership fails.
      try { await agent.persistState({ strict: true }) } catch { /* Retain WAL and original failure. */ }
      await agent.captureFactoryObservationTrace(traceOwner,
      'factory_cell.tool_refused', { request_id: scope.request_id, tool: 'factoryMetadataPublication', code: error.code ?? 'factory_metadata_persistence_failed' })
      throw error
    }
  }).execute()
}

function prepareFactoryCellAccess(agent, name, args, hostAction) {
  const key = agent.activePlanKey()
  const epoch = { ...agent.epoch }
  const request = agent.traceRequest
  const requestId = request?.id
  const admissionOwner = agent.requestAdmissionOwner
  const traceOwner = Object.freeze({ request, requestId, actorId: epoch.actor_id, actorEpoch: epoch.epoch, sessionId: epoch.session, turn: agent.continuations + 1 })
  const generation = agent.generation
  const lineage = agent.agentContext.lineageSequence
  const conversation = agent.agentContext.conversationSeq
  const mutation = agent.worldMutationSeq ?? 0
  const binding = agent.memory.factoryWorldBinding()
  let expectedRevision = agent.memory.factoryRegistryStatus().status === 'initialized' ? agent.memory.getFactoryRegistry().revision : 0
  const planningOwner = () => {
    const state = agent.memory.planningState(key); const plan = getActivePlan(state)
    return JSON.stringify([state?.goal?.goal_id, state?.goal?.status, plan?.plan_id, plan?.plan_version, plan?.active_step_index])
  }
  const planning = planningOwner()
  let live
  const fence = () => {
    if (agent.active !== true || agent.requestAdmissionOwner !== admissionOwner || agent.generation !== generation || agent.agentContext.lineageSequence !== lineage || agent.agentContext.conversationSeq !== conversation
      || agent.traceRequest !== request || agent.traceRequest?.id !== requestId || agent.activePlanKey() !== key
      || agent.epoch?.actor_id !== epoch.actor_id || agent.epoch?.epoch !== epoch.epoch || agent.epoch?.session !== epoch.session
      || (agent.worldMutationSeq ?? 0) !== mutation || agent.memory.factoryWorldBinding().generation !== binding.generation || planningOwner() !== planning) fail('factory_tool_owner_stale')
    if (binding.world_id !== undefined && agent.memory.factoryWorldBinding().world_id !== binding.world_id) fail('factory_world_mismatch')
    if (agent.memory.factoryRegistryStatus().status === 'initialized' && agent.memory.getFactoryRegistry().revision !== expectedRevision) fail('factory_registry_revision_stale')
  }
  const refresh = async () => {
    fence()
    if (agent.memory.factoryRegistryStatus().status === 'fault') fail('factory_registry_fault')
    if (agent.batchInFlight || agent.memory.pendingOperation?.(key) || (agent.memory.pendingOperations?.(key) ?? []).length) fail('factory_runtime_not_idle')
    const deployment = await nativeRead(() => deploymentStatus(agent.rcon, { requireAllowed: true })); fence()
    const actor = parse(await nativeRead(() => agent.rcon.command(agent.observationToolCommand('getActorStatus', {})))); fence()
    const task = parse(await agent.readTaskStatusRaw()); fence()
    const journal = nativeAdmissionJournal(task.admission_journal)
    if (deployment.actor_id !== epoch.actor_id || deployment.epoch !== epoch.epoch || deployment.session !== epoch.session
      || actor.mode !== 'npc' || actor.actor?.actor_id !== epoch.actor_id || actor.actor?.valid !== true
      || actor.actor?.kind !== 'standalone_character'
      || !Number.isSafeInteger(actor.surface_index) || actor.surface_index < 1 || !Number.isSafeInteger(actor.force_index) || actor.force_index < 1
      || (epoch.surface_index !== undefined && epoch.surface_index !== actor.surface_index)
      || (epoch.force_index !== undefined && epoch.force_index !== actor.force_index)
      || (deployment.surface_index !== undefined && deployment.surface_index !== actor.surface_index)
      || (deployment.force_index !== undefined && deployment.force_index !== actor.force_index)) fail('factory_tool_native_owner_stale')
    if (live && (live.surface_index !== actor.surface_index || live.force_index !== actor.force_index)) fail('factory_tool_native_owner_stale')
    if (deployment.idle !== true || task.task_state !== 'idle' || task.queue_empty !== true || task.queue_length !== 0 || task.active_batch
      || task.actor?.mining_state?.mining || !journal.known || journal.unresolved) fail('factory_runtime_not_idle')
    live = { surface_index: actor.surface_index, force_index: actor.force_index, native_idle: true, pending: false, uncertain: false }
  }
  const readContext = () => {
    fence()
    return { ...live, pending: Boolean(agent.batchInFlight || agent.memory.pendingOperation?.(key) || (agent.memory.pendingOperations?.(key) ?? []).length),
      world_id: agent.memory.factoryWorldBinding().world_id, actor_id: agent.epoch?.actor_id, actor_epoch: agent.epoch?.epoch,
      request_id: agent.traceRequest?.id, session_id: agent.epoch?.session }
  }
  const executeInner = async () => {
    await refresh()
    const events = []
    const observer = createFactoryCellObserver({ memory: agent.memory, key, readContext,
      trace: (event, payload) => events.push({ event, payload }),
      callNative: async (method, payload) => {
        if (!['world_identity', 'bind_world_id', 'observe'].includes(method)) fail('factory_native_method_invalid')
        await refresh()
        const argument = method === 'world_identity' ? '' : method === 'bind_world_id' ? `,${luaString(payload)}` : `,helpers.json_to_table(${luaString(JSON.stringify(payload))})`
        const command = `/silent-command rcon.print(helpers.table_to_json(remote.call('sgluna_factory','${method}'${argument})))`
        const raw = String(await nativeRead(() => agent.rcon.command(command)))
        // Retain the reply under its original owner even if that owner became
        // stale or native work began during the read. Capture is not publication.
        await agent.captureFactoryObservationTrace(traceOwner, 'factory_cell.native_evidence', { request_id: requestId, session_id: epoch.session, actor_id: epoch.actor_id,
          actor_epoch: epoch.epoch, tool: name, tool_arguments: args, cell_id: args.cell_id, method,
          registry_revision: expectedRevision, registry_generation: binding.generation, generation, world_mutation_seq: mutation, native_request: payload,
          native_response: raw.slice(0, 262144), native_response_chars: raw.length, capture_truncated: raw.length > 262144 })
        fence()
        await refresh()
        if (raw.length > 262144) fail('factory_observation_body_limit')
        return raw
      },
    })
    await observer.initializeWorld()
    fence()
    let result
    if (hostAction) result = await hostAction(observer, {
      refresh, fence, readContext,
      acceptPublishedRevision: () => { expectedRevision = agent.memory.getFactoryRegistry().revision; fence() },
    })
    else if (name === 'listFactoryCells') {
      const listing = observer.list()
      result = { ...listing, total_cells: listing.cells.length, offset: args.offset,
        cells: listing.cells.slice(args.offset, args.offset + args.limit), next_offset: null }
    }
    else result = await observer.observe(args)
    for (const event of events) {
      await agent.traceEvent(event.event, event.payload, { requestId }); fence()
    }
    await refresh()
    return hostAction ? result : projectFactoryCellResult(result)
  }
  const execute = async () => {
    try { return await executeInner() }
    catch (error) {
      await agent.captureFactoryObservationTrace(traceOwner, 'factory_cell.tool_refused', { request_id: requestId, session_id: epoch.session, actor_id: epoch.actor_id,
        actor_epoch: epoch.epoch, tool: name, cell_id: args.cell_id, code: error.code ?? 'factory_native_read_failed' })
      fence()
      if (hostAction) throw error
      // A refused observation is usable diagnostic data, never a provider
      // outage or a reason to mutate gameplay. Superseded ownership still throws.
      if (error instanceof FactoryRegistryError && !/stale|world_mismatch|owner_mismatch/.test(error.code)) {
        return projectFactoryCellResult({ schema_version: 1, tool: name, cell_id: args.cell_id, request_id: requestId,
          state: 'unverified', refused: true, code: error.code, commissioning: 'unverified', throughput: 'unverified' })
      }
      if (error instanceof FactoryRegistryError && /stale|world_mismatch|owner_mismatch/.test(error.code)) fail(error.code)
      throw error
    }
  }
  return { execute, fence }
}
