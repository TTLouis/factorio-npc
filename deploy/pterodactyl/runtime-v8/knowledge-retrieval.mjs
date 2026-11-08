// Explicit authored-reference reads. No autoload, durable context, world-fact
// handoff or physical skill verification. The cache lives only for one request.
import { isNotebookTool, spendContextCalls } from './agent-notebook.mjs'
import { PolicyError, luaString } from '../staging/structured-policy.mjs'
import { compactLoadedSkill, sanitizeSkillCard } from './skill-offers.mjs'
import { canonicalLibraryResult, readCanonicalLibraryTool } from './canonical-library-tools.mjs'

export const KNOWLEDGE_LIMITS = Object.freeze({ calls: 8, batch: 3, results: 10, chars: 7000 })
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/
export const isKnowledgeTool = name => name === 'findKnowledge' || name === 'getKnowledgeDetails'
const tool = (name, description, properties, required) => ({ type: 'function', function: { name, description,
  parameters: { type: 'object', properties, required, additionalProperties: false } } })
export const knowledgeToolDefinitions = [
  tool('findKnowledge', 'Search authored concept references only when needed. Read-only for planner and executor; no skill selection, current-world facts, plan authority or autoload. Call reference tools separately from world observations.', {
    query: { type: 'string', minLength: 1, maxLength: 160 }, limit: { type: 'integer', minimum: 1, maximum: 8, default: 5 },
  }, ['query']),
  tool('getKnowledgeDetails', 'Read one exact authored knowledge reference on demand. This is concept guidance, not a procedure selected in skillIds or evidence of current recipes, ratios or world state. Call reference tools separately from world observations.', {
    id: { type: 'string', minLength: 1, maxLength: 100, pattern: ID.source },
  }, ['id']),
]
export function knowledgeToolCommand(name, args) {
  const search = name === 'findKnowledge'
  const allowed = search ? ['query', 'limit'] : ['id']
  if (!isKnowledgeTool(name) || !args || typeof args !== 'object' || Array.isArray(args)
    || Object.keys(args).some(key => !allowed.includes(key))) throw new PolicyError('Invalid knowledge arguments')
  if (search) {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 160) throw new PolicyError('Invalid knowledge query')
    const limit = args.limit ?? 5
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new PolicyError('Invalid knowledge limit')
    return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_references","find",${luaString(args.query.trim())},${limit})))`
  }
  if (typeof args.id !== 'string' || !ID.test(args.id)) throw new PolicyError('Invalid knowledge id')
  return `/silent-command rcon.print(helpers.table_to_json(remote.call("autorio_references","get",${luaString(args.id)})))`
}
// Native canonical text is retained whole. A malformed/oversized field refuses
// the result rather than truncating a personal reference's meaning.
const text = (value, max = 1000) => value === undefined ? '' : typeof value === 'string' && value.length <= max ? value : undefined
const texts = value => {
  if (value === undefined || (value && !Array.isArray(value) && typeof value === 'object' && Object.keys(value).length === 0)) return [] // empty Lua table
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length <= 1000) ? [...value] : undefined
}
function parse(raw) { try { return typeof raw === 'string' ? JSON.parse(raw) : raw } catch { return undefined } }
export function compactKnowledge(raw, expectedId, detail = true) {
  const value = parse(raw)
  if (!value || value.content_type !== 'knowledge' || typeof value.id !== 'string'
    || !ID.test(value.id) || value.id.length > 80 || (expectedId && value.id !== expectedId)) return undefined
  const result = { content_type: 'knowledge', id: value.id, revision: Number.isSafeInteger(value.revision) && value.revision > 0 ? value.revision : 1,
    name: text(value.name, 200), summary: text(value.summary, 1000) }
  if (Number.isInteger(value.level) && value.level >= 0 && value.level <= 7) result.level = value.level
  if (detail) {
    result.schema_version = 1
    if (value.search_aliases !== undefined) result.search_aliases = texts(value.search_aliases)
    if (value.applicability && typeof value.applicability === 'object') result.applicability = {
      when_to_use: text(value.applicability.when_to_use), when_to_skip: text(value.applicability.when_to_skip),
      live_checks: texts(value.applicability.live_checks), required_capabilities: texts(value.applicability.required_capabilities),
    }
    if (value.reference && typeof value.reference === 'object') result.reference = {
      concepts: texts(value.reference.concepts), interpretation_checks: texts(value.reference.interpretation_checks),
    }
    result.related_ids = texts(value.related_ids)
    result.known_failure_modes = texts(value.known_failure_modes)
    result.source = { kind: text(value.source?.kind, 80), evidence_refs: texts(value.source?.evidence_refs) }
  }
  // Refuse oversized references intact rather than delivering truncated JSON or
  // silently presenting a partial conceptual instruction as the whole entry.
  const hasUndefined = value => value && typeof value === 'object' && Object.values(value).some(child => child === undefined || hasUndefined(child))
  return !hasUndefined(result) && JSON.stringify(result).length <= KNOWLEDGE_LIMITS.chars ? result : undefined
}
export function sanitizeLibraryToolOutput(name, raw, args = {}) {
  if (canonicalLibraryResult(raw)) return typeof raw === 'string' ? raw : JSON.stringify(raw)
  const value = parse(raw)
  const failure = { ok: false, error: 'library_type_or_bounds_mismatch' }
  if (value?.ok === false && value.error === 'library_entry_not_found') return JSON.stringify({ ok: false, error: 'library_entry_not_found' })
  if (name === 'getSkillDetails') return JSON.stringify(compactLoadedSkill(value, args.id) ?? failure)
  if (name === 'findSkills') return JSON.stringify({ ok: value?.ok === true,
    results: (Array.isArray(value?.results) ? value.results : []).map(sanitizeSkillCard).filter(Boolean).slice(0, 10) })
  if (name === 'getKnowledgeDetails') return JSON.stringify(compactKnowledge(value, args.id) ?? failure)
  const results = (Array.isArray(value?.results) ? value.results : []).map(item => compactKnowledge(item, undefined, false)).filter(Boolean).slice(0, args.limit ?? 3)
  while (results.length && JSON.stringify({ ok: value?.ok === true, results }).length > KNOWLEDGE_LIMITS.chars) results.pop()
  return JSON.stringify({ ok: value?.ok === true, results })
}

export function isValidatedKnowledgeBatch(prepared) {
  return Array.isArray(prepared) && prepared.length > 0 && prepared.length <= KNOWLEDGE_LIMITS.batch && prepared.every(entry => {
    try { return isKnowledgeTool(entry.tool?.function?.name)
      && entry.command === knowledgeToolCommand(entry.tool.function.name, entry.args)
      && JSON.stringify(JSON.parse(entry.tool.function.arguments)) === JSON.stringify(entry.args) }
    catch { return false }
  })
}

export async function handleKnowledgeToolBatch(loop, message, prepared) {
  const calls = message?.tool_calls
  const refuse = reason => {
    void loop.traceEvent('knowledge.request_refused', { request_id: loop.traceRequest?.id, reason, batch_effect: 'not_sent' })
    throw new PolicyError(reason)
  }
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > KNOWLEDGE_LIMITS.batch || prepared.length !== calls.length
    || calls.some(call => !isKnowledgeTool(call?.function?.name))
    || prepared.some((entry, index) => !isKnowledgeTool(entry.tool?.function?.name) || JSON.stringify(entry.tool) !== JSON.stringify(calls[index])
      || entry.command !== knowledgeToolCommand(entry.tool.function.name, entry.args)
      || JSON.stringify(JSON.parse(calls[index].function.arguments)) !== JSON.stringify(entry.args))) refuse('knowledge_requires_separate_bounded_batch')
  if (loop.observationDecisionForced || loop.actionOmissionRepairActive) refuse('knowledge_unavailable_in_closed_or_targeted_recovery')
  // Key by the request object, not the conversation: restaging does not refill.
  const request = loop.traceRequest
  if (!loop.knowledgeReads || loop.knowledgeReads.request !== request) loop.knowledgeReads = { request, calls: 0, cache: new Map() }
  const state = loop.knowledgeReads
  if (state.calls + prepared.length > KNOWLEDGE_LIMITS.calls) refuse('knowledge_request_budget_exhausted')
  spendContextCalls(loop, prepared.length)
  state.calls += prepared.length
  const generation = loop.generation
  const sequence = loop.agentContext.conversationSeq
  const lineage = loop.agentContext.lineageSequence
  const role = loop.agentContext.role
  const actor = { actor_id: loop.epoch?.actor_id, epoch: loop.epoch?.epoch, session: loop.epoch?.session }
  const fence = async () => {
    await loop.assertCurrent()
    if (loop.generation !== generation || loop.agentContext.conversationSeq !== sequence || loop.traceRequest !== request
      || loop.agentContext.lineageSequence !== lineage || loop.agentContext.role !== role
      || loop.epoch?.actor_id !== actor.actor_id || loop.epoch?.epoch !== actor.epoch || loop.epoch?.session !== actor.session) throw new PolicyError('knowledge_request_superseded')
  }
  await fence()
  loop.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: calls })
  for (const entry of prepared) {
    await fence()
    const name = entry.tool.function.name
    const key = JSON.stringify([name, entry.args])
    const cached = state.cache.has(key)
    await loop.traceEvent('tool.call', { request_id: request?.id, tool_call_id: entry.tool.id, name, args: entry.args, cached })
    await fence()
    const output = cached ? state.cache.get(key) : await readCanonicalLibraryTool(name, entry.args)
    await fence()
    state.cache.set(key, output)
    loop.messages.push({ role: 'tool', tool_call_id: entry.tool.id, content: output })
    if (request?.usage) { request.usage.tool_calls++; request.usage.tool_result_chars += output.length; if (cached) request.usage.duplicate_tool_calls++ }
    await loop.traceEvent('tool.result', { request_id: request?.id, tool_call_id: entry.tool.id, name, cached, output, output_chars: output.length })
    await fence()
    await loop.traceEvent('knowledge.reference_delivered', { request_id: request?.id, tool_call_id: entry.tool.id, role: loop.agentContext.role,
      tool: name, cached, calls_used: state.calls, calls_limit: KNOWLEDGE_LIMITS.calls, delivery: 'tool_result_only' })
    await fence()
  }
  loop.observationOnlyRounds++
  loop.compactWorkingContext()
}

// Historical exchanges may mix reference/world calls or reorder responses.
// Preserve only matched world pairs; reference bodies never enter a digest.
export function withoutKnowledgeExchange(messages) {
  const assistant = messages[0]
  if (!Array.isArray(assistant?.tool_calls) || !assistant.tool_calls.some(call => (isKnowledgeTool(call?.function?.name) || isNotebookTool(call?.function?.name)))) return messages
  const calls = assistant.tool_calls.filter(call => !(isKnowledgeTool(call?.function?.name) || isNotebookTool(call?.function?.name)))
  if (calls.length === 0) return []
  const pairs = calls.map(call => ({ call, result: messages.slice(1).find(row => row.role === 'tool' && row.tool_call_id === call.id) }))
    .filter(pair => pair.result)
  if (pairs.length === 0) return []
  return [{ ...assistant, content: null, tool_calls: pairs.map(pair => pair.call) }, ...pairs.map(pair => pair.result)]
}
