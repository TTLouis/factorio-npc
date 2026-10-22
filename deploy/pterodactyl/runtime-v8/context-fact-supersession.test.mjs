import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

import { EXECUTOR_ROLE } from './agent-roles.mjs'
import { NpcAgentLoop, NpcDialogueMemory } from './npc-agent-loop.mjs'
import { POST_BATCH_FACTS_MARKER, postBatchStepKey } from './post-batch-facts.mjs'

const inventory = count => `{ { count = ${count}, name = "iron-plate" } }`
const entity = (amount, mode = 'full') => JSON.stringify({ observation_mode: mode, found: true,
  entity: { unit_number: 35, name: 'boiler', fluid: { amount } } })
const call = (id, name, args = {}) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })

async function world() {
  const deployment = { revision: 'sgluna-deploy-v8-npc-staging', session: '0123456789abcdef0123456789abcdef',
    mode: 'npc', actor_id: 18, actor_kind: 'standalone_character', connected_players: 0, allowed: true,
    idle: true, epoch: 3, actor_interface: true, operations: true, tools: true }
  const rcon = { commands: [], inventory: inventory(4), entity: entity(0), async command(text) {
    this.commands.push(text)
    if (text.includes('sgluna_deployment')) return JSON.stringify(deployment)
    if (text.includes('get_inventory_items')) return this.inventory
    if (text.includes('get_entity_status')) return this.entity
    if (text.includes('autorio_skills')) return JSON.stringify({ id: 'old-skill', revision: 1, name: 'Old Skill' })
    return '{}'
  } }
  const payloads = []
  const events = []
  const agent = new NpcAgentLoop({ rcon, memory: new NpcDialogueMemory(), systemPrompt: 'superseded fact regression',
    provider: async (messages, context) => { payloads.push(structuredClone({ messages, requestId: context.requestId })); throw new Error('scripted payload captured') },
    stateFile: null, traceFile: null, decisionTraceFile: null })
  agent.active = true
  agent.epoch = deployment
  agent.messages = [{ role: 'system', content: 'test' }, { role: 'user', content: '[MOD] Autorio operation batch completed' }]
  agent.agentContext.role = EXECUTOR_ROLE
  agent.traceRequest = { id: 'req_preventive_superseded_tail' }
  agent.traceEvent = async (event, data) => { events.push({ event, data }) }
  agent.postBatchStepKey = () => postBatchStepKey('npc:standalone_character:18:3', 'plan', 'step')
  // No topology is needed for this observation-only fixture; all tool admission, fact delivery,
  // tail assembly, baseline repair and the provider boundary use the production methods.
  agent.gatherTopologyContext = async () => undefined
  agent.observationBudgetRemaining = 4
  agent.observationDecisionForced = false
  const bundle = await agent.postBatchFactBundle('targeted_observation', { families: ['inventory_equipment', 'entity_status'], view: {
    basic_operation: { last_result: { type: 'placing', completed: true, code: 'completed', actor_id: 18, placed_unit_number: 35, entity_name: 'boiler', placed_position: { x: 1, y: 2 } } },
    last_completed_batch: { task_count: 1, task_types: ['placing'] },
  } })
  agent.deliverPostBatchFacts(bundle)
  assert.equal(bundle.reads.length, 2)
  const capture = async label => {
    await assert.rejects(agent.callProvider(deployment, agent.generation, { round: 1 }), /scripted payload captured/)
    const payload = payloads.at(-1)
    if (process.env.CONTEXT_EVIDENCE_DIR) fs.writeFileSync(`${process.env.CONTEXT_EVIDENCE_DIR}/${process.env.CONTEXT_RUN_LABEL}-${label}.json`, JSON.stringify({ payload, events, commands: rcon.commands }, null, 2))
    return payload.messages
  }
  return { agent, rcon, events, bundle, capture }
}
const tail = messages => messages.find(row => String(row.content).startsWith(POST_BATCH_FACTS_MARKER))?.content ?? ''
const result = (messages, id) => messages.find(row => row.role === 'tool' && row.tool_call_id === id)?.content

test('passive inventory change: actual provider request carries the new result without the older post-batch count', async () => {
  const w = await world()
  const mutation = w.agent.worldMutationSeq
  w.rcon.inventory = inventory(9)
  await w.agent.handleToolBatch({ tool_calls: [call('inventory-now', 'getInventoryItems')] })
  const messages = await w.capture('inventory')
  assert.equal(w.agent.worldMutationSeq, mutation, 'passive native change has no harness mutation')
  assert.equal(result(messages, 'inventory-now'), inventory(9))
  assert.ok(!tail(messages).includes(inventory(4)), 'older count must not remain beside the current native count')
  assert.ok(tail(messages).includes(entity(0)), 'unrelated entity fact survives')
  assert.deepEqual(w.agent.postBatchFacts.covered, ['entity_status'], 'the remaining tail claims only the family it still answers')
  assert.equal(w.agent.observationBudgetRemaining, 3, 'changed read still spends the normal budget')
  const trace = w.events.find(row => row.event === 'observation.post_batch_fact_superseded')
  assert.equal(trace?.data.request_id, 'req_preventive_superseded_tail')
  assert.equal(trace?.data.reason, 'newer_same_signature_full_result_delivered')
})

test('passive entity change: same exact signature retires only the older placed-entity fact', async () => {
  const w = await world()
  w.rcon.entity = entity(200)
  await w.agent.handleToolBatch({ tool_calls: [call('entity-now', 'getEntityStatus', { unit_number: 35 })] })
  const messages = await w.capture('entity')
  assert.deepEqual(JSON.parse(result(messages, 'entity-now')).entity, JSON.parse(entity(200)).entity)
  assert.ok(!tail(messages).includes(entity(0)), 'older fluid amount must not appear as a current tail fact')
  assert.ok(tail(messages).includes(inventory(4)))
  assert.deepEqual(w.agent.postBatchFacts.covered, ['inventory_equipment'])
})

for (const [label, output] of [
  ['malformed', 'not native JSON'], ['error', JSON.stringify({ ok: false, error: 'read failed' })],
  ['wrong-identity', JSON.stringify({ found: true, entity: { unit_number: 99 } })],
  ['diff', JSON.stringify({ observation_mode: 'diff', found: true, entity: { unit_number: 35 }, changes: { fluid: 200 } })],
  ['unchanged-reference', JSON.stringify({ observation_mode: 'unchanged', found: true, entity: { unit_number: 35 } })],
]) test(`${label} does not replace the full native entity baseline`, async () => {
  const w = await world()
  w.rcon.entity = output
  await w.agent.handleToolBatch({ tool_calls: [call('entity-read', 'getEntityStatus', { unit_number: 35 })] })
  const messages = await w.capture(label)
  assert.ok(tail(messages).includes(entity(0)), 'no authoritative full replacement was delivered')
  assert.equal(w.events.filter(row => row.event === 'observation.post_batch_fact_superseded').length, 0)
})

test('unchanged raw inventory keeps its baseline and its free reread accounting', async () => {
  const w = await world()
  await w.agent.handleToolBatch({ tool_calls: [call('same', 'getInventoryItems')] })
  const messages = await w.capture('unchanged-raw')
  assert.ok(tail(messages).includes(inventory(4)))
  assert.equal(w.agent.observationBudgetRemaining, 4)
  assert.equal(w.events.filter(row => row.event === 'observation.post_batch_fact_superseded').length, 0)
})

test('a different signature never supersedes the held entity, and stale scopes never change the bundle', async () => {
  const w = await world()
  w.rcon.entity = JSON.stringify({ found: true, entity: { unit_number: 36 } })
  await w.agent.handleToolBatch({ tool_calls: [call('other', 'getEntityStatus', { unit_number: 36 })] })
  assert.ok(tail(await w.capture('different-signature')).includes(entity(0)))
  w.agent.postBatchStepKey = () => 'other-step'
  w.agent.toolCache.clear()
  await w.agent.handleToolBatch({ tool_calls: [call('old-step', 'getEntityStatus', { unit_number: 35 })] })
  assert.equal(w.agent.postBatchFacts.reads, w.bundle.reads)
  assert.equal(w.agent.postBatchFactsText(), '')
})

test('real rendered entity diffs retain the full tool baseline after the obsolete tail fact is suppressed', async () => {
  const w = await world()
  await w.agent.handleToolBatch({ tool_calls: [call('entity-baseline', 'getEntityStatus', { unit_number: 35 })] })
  w.agent.toolCache.clear()
  w.rcon.entity = entity(200)
  await w.agent.handleToolBatch({ tool_calls: [call('entity-diff', 'getEntityStatus', { unit_number: 35 })] })
  const messages = await w.capture('generated-diff')
  assert.equal(JSON.parse(result(messages, 'entity-baseline')).entity.fluid.amount, 0)
  assert.equal(JSON.parse(result(messages, 'entity-diff')).observation_mode, 'diff')
  assert.equal(JSON.parse(result(messages, 'entity-diff')).changes.entity.fluid.amount, 200)
  assert.ok(!tail(messages).includes(entity(0)))
  assert.equal(w.events.filter(row => row.event === 'context.dangling_reference').length, 0)
})

test('cached duplicate suppression is never treated as a new native answer', async () => {
  const w = await world()
  await w.agent.handleToolBatch({ tool_calls: [call('cached-first', 'getInventoryItems')] })
  w.rcon.inventory = inventory(9)
  const reads = w.rcon.commands.filter(text => text.includes('get_inventory_items')).length
  await w.agent.handleToolBatch({ tool_calls: [call('cached-again', 'getInventoryItems')] })
  const messages = await w.capture('cached')
  assert.equal(w.rcon.commands.filter(text => text.includes('get_inventory_items')).length, reads)
  assert.ok(tail(messages).includes(inventory(4)))
  assert.match(result(messages, 'cached-again'), /Duplicate observation suppressed/)
  assert.equal(w.events.filter(row => row.event === 'observation.post_batch_fact_superseded').length, 0)
})

test('authoritative not-found retires the earlier entity while malformed inventory preserves its baseline', async () => {
  const w = await world()
  w.rcon.entity = JSON.stringify({ found: false })
  await w.agent.handleToolBatch({ tool_calls: [call('gone', 'getEntityStatus', { unit_number: 35 })] })
  assert.ok(!tail(await w.capture('not-found')).includes(entity(0)))
  w.rcon.inventory = '{broken'
  await w.agent.handleToolBatch({ tool_calls: [call('bad-inventory', 'getInventoryItems')] })
  assert.ok(tail(await w.capture('bad-inventory')).includes(inventory(4)))
})

for (const kind of ['role', 'step', 'mutation', 'actor-scope']) test(`a stale ${kind} bundle is never rewritten by a new same-signature read`, async () => {
  const w = await world()
  const held = w.agent.postBatchFacts
  if (kind === 'role') w.agent.agentContext.role = 'planner'
  if (kind === 'step') w.agent.postBatchStepKey = () => 'new-step'
  if (kind === 'mutation') w.agent.worldMutationSeq = (w.agent.worldMutationSeq ?? 0) + 1
  if (kind === 'actor-scope') held.scope = 'npc:standalone_character:other:other'
  w.rcon.inventory = inventory(9)
  await w.agent.handleToolBatch({ tool_calls: [call('new-count', 'getInventoryItems')] })
  assert.equal(w.agent.postBatchFacts, held)
  assert.equal(w.agent.postBatchFacts.reads, w.bundle.reads)
  assert.equal(w.agent.postBatchFactsText(), '')
  assert.equal(w.events.filter(row => row.event === 'observation.post_batch_fact_superseded').length, 0)
})

// Stop a real result-processing trace after delivery, then give the loop a new owner.
// Ordinary observations intentionally have no optional targeted-recovery read fence.
for (const invalidation of ['generation', 'lineage', 'cancel-reset']) {
  for (const [label, pausedEvent, tools] of [
    ['inventory supersession', 'observation.post_batch_fact_superseded', [call('old-inventory', 'getInventoryItems')]],
    ['entity supersession', 'observation.post_batch_fact_superseded', [call('old-entity', 'getEntityStatus', { unit_number: 35 })]],
    ['skill context', 'skill.context_loaded', [call('old-skill', 'getSkillDetails', { id: 'old-skill' })]],
    ['skill loaded', 'skill.loaded', [call('old-skill', 'getSkillDetails', { id: 'old-skill' })]],
    ['native result trace', 'observation.power_gap_observed', [call('old-entity', 'getEntityStatus', { unit_number: 35 })]],
    ['repair completion', 'recovery.action_omission_observation_complete', [call('old-inventory', 'getInventoryItems')]],
    ['between results', 'tool.result', [call('old-inventory', 'getInventoryItems'), call('old-entity', 'getEntityStatus', { unit_number: 35 })]],
  ]) test(`${invalidation} replacement during deferred ${label} stops old bookkeeping`, async () => {
    const w = await world()
    w.rcon.inventory = inventory(9)
    w.rcon.entity = entity(200)
    if (label === 'native result trace') {
      const native = JSON.parse(w.rcon.entity)
      native.entity.power_gap = { poles_found: 0, search_radius: 20 }
      w.rcon.entity = JSON.stringify(native)
    }
    if (label === 'repair completion') w.agent.actionOmissionRepairActive = true
    const owner = { generation: w.agent.generation, lineage: w.agent.agentContext.lineageSequence, requestId: w.agent.traceRequest.id, epoch: { ...w.agent.epoch } }
    let release
    let entered
    const gate = new Promise(resolve => { release = resolve })
    const started = new Promise(resolve => { entered = resolve })
    const trace = w.agent.traceEvent
    w.agent.traceEvent = async (event, data, options) => {
      await trace(event, data)
      if (event === pausedEvent) {
        entered({ data, options })
        await gate
      }
    }
    const oldWork = w.agent.handleToolBatch({ tool_calls: tools })
    // Observe rejection immediately so the negative control never leaves an unhandled promise.
    const outcome = oldWork.then(() => undefined, error => error)
    const paused = await started
    if (invalidation === 'generation') w.agent.generation++
    else if (invalidation === 'lineage') w.agent.agentContext.beginLineage(EXECUTOR_ROLE)
    else w.agent.cancel()
    assert.equal(w.agent.generation === owner.generation, invalidation === 'lineage')
    assert.equal(w.agent.agentContext.lineageSequence === owner.lineage, invalidation === 'generation')
    w.agent.active = true
    w.agent.epoch = { ...owner.epoch, actor_id: invalidation === 'cancel-reset' ? 99 : 18, epoch: invalidation === 'cancel-reset' ? 8 : 3 }
    w.agent.worldMutationSeq = 71
    w.agent.baseMessages = [{ role: 'system', content: 'new owner base' }]
    w.agent.messages = [...w.agent.baseMessages, { role: 'user', content: 'new request' }]
    w.agent.requestInfo = { id: 'fresh-request', sender: 'new-owner', text: 'new goal' }
    w.agent.observationBudgetRemaining = 7
    w.agent.observationDecisionForced = false
    w.agent.providerBudgetGeneration = 3
    w.agent.providerBudgetGenerationOutputUnits = 123
    w.agent.reasoningBudgetOverride = 234
    w.agent.observationBudgetOverride = 7
    w.agent.observationRelevanceOverride = ['inventory_equipment']
    w.agent.planningHorizonOverride = 'fresh-owner-horizon'
    w.agent.handoffInventoryObservations = new Map([['iron-plate', { count: 42, seq: 71, actor_id: w.agent.epoch.actor_id, epoch: w.agent.epoch.epoch }]])
    w.agent.liveEntityObservations = new Map([[35, { unit_number: 35, name: 'boiler', observed_epoch: w.agent.epoch.epoch, observed_seq: 71, fluid: { amount: 999 } }]])
    w.agent.loadedSkillContext = new Map([['fresh-skill', { id: 'fresh-skill', revision: 'new' }]])
    w.agent.toolCache = new Map([['fresh-signature', 'fresh-output']])
    w.agent.postBatchFacts = { fresh_owner: true, reads: [], covered: [] }
    w.agent.traceRequest = { id: 'fresh-trace', usage: { tool_calls: 11, duplicate_tool_calls: 2, tool_result_chars: 777 }, last_tool: { name: 'fresh-tool' } }
    const fields = ['messages', 'baseMessages', 'requestInfo', 'epoch', 'worldMutationSeq', 'observationBudgetRemaining', 'observationDecisionForced',
      'providerBudgetGeneration', 'providerBudgetGenerationOutputUnits', 'reasoningBudgetOverride',
      'observationBudgetOverride', 'observationRelevanceOverride', 'planningHorizonOverride',
      'handoffInventoryObservations', 'liveEntityObservations', 'loadedSkillContext', 'toolCache', 'postBatchFacts', 'traceRequest']
    const before = Object.fromEntries(fields.map(key => [key, structuredClone(w.agent[key])]))
    const identities = Object.fromEntries(fields.filter(key => typeof w.agent[key] === 'object').map(key => [key, w.agent[key]]))
    const commands = [...w.rcon.commands]
    const events = w.events.length
    release()
    const error = await outcome
    assert.deepEqual(Object.fromEntries(fields.map(key => [key, w.agent[key]])), before, 'old results must not contaminate the replacement owner')
    for (const [key, value] of Object.entries(identities)) assert.equal(w.agent[key], value, `${key} remains owned by the replacement`)
    assert.match(error?.message ?? '', /cancelled|superseded/i, 'reject so the caller cannot continue into another provider/admission round')
    assert.deepEqual(w.rcon.commands, commands, 'no stale native/admission work after the fence')
    assert.equal(w.events.length, events, 'no cleanup trace is attributed to the replacement request')
    if (pausedEvent === 'observation.post_batch_fact_superseded') {
      assert.equal(paused.data.request_id, owner.requestId)
      assert.equal(paused.options?.requestId, owner.requestId, 'the queued trace keeps its original request attribution')
    }
    if (process.env.CONTEXT_EVIDENCE_DIR) fs.writeFileSync(`${process.env.CONTEXT_EVIDENCE_DIR}/${process.env.CONTEXT_RUN_LABEL}-${invalidation}-${label.replaceAll(' ', '-')}.json`, JSON.stringify({ owner, paused, error: error.message, before: { ...before, handoffInventoryObservations: [...before.handoffInventoryObservations], liveEntityObservations: [...before.liveEntityObservations] }, events: w.events, commands }, null, 2))
  })
}


test('the same owner resumes a deferred supersession trace and completes normal result bookkeeping', async () => {
  const w = await world()
  w.rcon.inventory = inventory(9)
  w.agent.traceRequest.usage = { tool_calls: 0, duplicate_tool_calls: 0, tool_result_chars: 0 }
  let release
  let entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const trace = w.agent.traceEvent
  w.agent.traceEvent = async (event, data) => {
    await trace(event, data)
    if (event === 'observation.post_batch_fact_superseded') {
      entered()
      await gate
    }
  }
  const work = w.agent.handleToolBatch({ tool_calls: [call('same-owner', 'getInventoryItems')] })
  await started
  release()
  await work
  assert.equal(w.agent.handoffInventoryObservations.get('iron-plate').count, 9)
  assert.equal(w.agent.handoffInventoryObservations.get('iron-plate').epoch, 3)
  assert.equal(w.agent.traceRequest.last_tool.tool_call_id, 'same-owner')
  assert.equal(w.agent.traceRequest.usage.tool_calls, 1)
  assert.equal(w.agent.traceRequest.usage.tool_result_chars, inventory(9).length)
  assert.equal(w.agent.observationBudgetRemaining, 3)
  assert.ok(!tail(await w.capture('deferred-same-owner')).includes(inventory(4)))
})
