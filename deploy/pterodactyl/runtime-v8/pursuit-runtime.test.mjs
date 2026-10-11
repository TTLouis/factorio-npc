import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PursuitRuntime, pursuitProvider, pursuitIntake, pursuitMessages, renderPursuitOperation } from './pursuit-runtime.mjs'
import { providerRequest } from './provider.mjs'
import { pursuitDecisionToolDefinition, approvedOperationListText } from './structured-policy.mjs'

const goal = { objective: 'Gather ten copper ore.', predicate: { scope: 'finite', summary: 'Hold ten copper ore.',
  doneWhen: [{ kind: 'inventory_count', item_name: 'copper-ore', minimum: 10 }] } }
const action = { notes: 'Acquire the requested ore.', operations: [{ name: 'gather_resource', args: { resource_name: 'copper-ore', count: 10 } }] }

test('pursuit advertised operations match its restricted adapter while the general catalog stays available', () => {
  const names = pursuitDecisionToolDefinition.function.parameters.properties.decision.properties.operations.items.properties.name.enum
  const prompt = pursuitMessages({})[0].content
  const operations = prompt.split('Approved operations and argument shapes: ')[1].split('\n')[0]
  for (const denied of ['mine_entity', 'rotate_entity', 'clear_area', 'clear_construction_area', 'execute_construction_plan']) {
    assert.equal(names.includes(denied), false)
    assert.equal(operations.split('; ').some(row => row.startsWith(`${denied} {`)), false)
  }
  assert.ok(approvedOperationListText().includes('mine_entity {'))
  assert.ok(approvedOperationListText().includes('rotate_entity {'))
  for (const allowed of ['place_entity', 'place_candidate', 'supply_entity', 'mine_entity_exact', 'gather_resource']) assert.ok(names.includes(allowed))
  assert.match(prompt, /Never guess a future unit_number/)
})

test('pursuit accepts one decision submission and refuses other or multiple wire tools', async () => {
  const context = { signal: new AbortController().signal, requestId: 'wire_fixture' }
  const tool = { type: 'function', function: { name: 'submitPursuitDecision', arguments: JSON.stringify({ decision: action }) } }
  const call = pursuitProvider(async () => ({ tool_calls: [tool] }))
  assert.deepEqual((await call({}, context)).decision, action)
  for (const calls of [[{ ...tool, function: { ...tool.function, name: 'executeLua' } }], [tool, tool], {}, 'malformed', [null]]) {
    await assert.rejects(pursuitProvider(async () => ({ tool_calls: calls }))({}, context), /pursuit_wire_tools_refused/)
  }
  const refused = await pursuitProvider(async () => ({ content: JSON.stringify({ decision: action, extra: true }) }))({}, context)
  assert.equal(refused.decision, undefined)
  assert.equal(refused.refusal.code, 'pursuit_wire_envelope_invalid')
})

test('retained extra-envelope finding refuses all effects and corrects within the durable campaign budget', async t => {
  const f = await fixture(t)
  let attempts = 0
  const provider = async messages => {
    const decision = ++attempts === 1 ? { decision: action, goal: 'Replace the owner objective', notes: 'Outside envelope' } : { decision: action }
    if (attempts === 2) assert.equal(JSON.parse(messages[1].content).remainingCalls, 29)
    return { tool_calls: [{ type: 'function', function: { name: 'submitPursuitDecision', arguments: JSON.stringify(decision) } }],
      _sglunaProvider: { usage: { prompt_tokens: 10, completion_tokens: 8 } } }
  }
  const agent = f.agent
  agent.provider = pursuitProvider(provider)
  // Stop after this decision boundary to inspect and reload its durable state.
  agent.drive = reason => agent.loop.wake(reason)
  await agent.request(goal.objective)
  const original = agent.loop.snapshot()
  assert.equal(original.status, 'active'); assert.equal(original.budget.calls, 1)
  assert.equal(original.pending, null); assert.equal(original.ordinal, 0); assert.equal(f.mutations.length, 0)
  assert.equal(original.objective, goal.objective)
  assert.equal(original.metrics[0].usage.completion_tokens, 8)
  assert.match(original.observations.at(-1).result, /pursuit_wire_envelope_invalid/)
  const restarted = new PursuitRuntime({ ...f.options, provider })
  await restarted.loadPersistentState()
  assert.deepEqual(restarted.loop.snapshot().budget, original.budget)
  assert.equal(restarted.loop.snapshot().request_id, original.request_id)
  assert.deepEqual(restarted.loop.snapshot().observations, []) // restart discards all read memory
  f.setAgent(restarted)
  await restarted.pollPursuit()
  assert.equal(restarted.loop.snapshot().budget.calls, 2)
  assert.equal(restarted.loop.snapshot().budget.startedAt, original.budget.startedAt)
  assert.equal(f.mutations.length, 1)
  assert.equal(restarted.loop.snapshot().objective, goal.objective)
  const rows = (await fsp.readFile(f.options.traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert(rows.some(row => row.event === 'pursuit.decision_refused' && row.reason === 'invalid_decision_envelope' && row.request_id === original.request_id))
})

async function fixture(t, replies = [action]) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'pursuit-runtime-'))
  t.after(() => fsp.rm(root, { recursive: true, force: true }))
  const actor = { revision: 'sgluna-deploy-v8-npc-staging', mode: 'npc', actor_kind: 'standalone_character',
    actor_id: 18, epoch: 3, allowed: true, idle: true, actor_interface: true, operations: true, tools: true }
  const runtime = { batch_generation: 1, task_state: 'idle', queue_length: 0, admission_journal: [] }
  const requests = [], mutations = []
  let satisfied = false, failSend = false, time = 1000
  let agent
  const rcon = { command: async command => {
    if (command.includes('SGLUNA_RESULT_')) {
      mutations.push(command)
      if (failSend) throw new Error('lost native acknowledgement')
      const identity = agent.loop.snapshot().pending
      const record = { ...identity, actor_id: actor.actor_id, epoch: actor.epoch, generation: 1,
        operation_count: identity.operations.length, state: 'admitted', slots: [] }
      runtime.admission_journal.push(record)
      runtime.task_state = 'running'; runtime.queue_length = 1
      const marker = command.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]
      return marker + JSON.stringify({ ok: true, result: [true], admission: record })
    }
    if (command.includes('sgluna_deployment')) return JSON.stringify(actor)
    if (command.includes('autorio_operation_admission')) return JSON.stringify({ high_water: runtime.admission_journal.at(-1)?.ordinal ?? 0 })
    if (command.includes('evaluate_condition')) return JSON.stringify({ ok: true, current: satisfied ? 10 : 0, satisfied })
    if (command.includes('autorio_preflight')) return JSON.stringify({ ok: true, target: { unit_number: 25, last_user: null } })
    if (command.includes('autorio_operations')) return JSON.stringify(runtime)
    return '{\n  { name = "copper-ore", count = 0 }\n}'
  } }
  const options = { rcon, stateFile: path.join(root, 'state.json'), traceFile: path.join(root, 'trace.jsonl'), ownerGoal: goal,
    now: () => time, provider: async (messages, context) => {
      requests.push({ messages, context })
      const reply = replies.shift()
      if (reply instanceof Error) throw reply
      return { content: JSON.stringify(reply ?? { pauseReason: 'Fixture exhausted.' }),
        _sglunaProvider: { usage: { prompt_tokens: 120, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } } } }
    } }
  agent = new PursuitRuntime(options)
  return { agent, options, actor, runtime, requests, mutations, setAgent: next => { agent = next },
    advance: ms => { time += ms }, failSend: () => { failSend = true }, satisfy: () => { satisfied = true },
    complete: () => { runtime.task_state = 'idle'; runtime.queue_length = 0; runtime.admission_journal.at(-1).state = 'completed' } }
}

test('production adapter dispatches the exact persisted journal identity; receipt poll spends no extra calls', async t => {
  const f = await fixture(t)
  f.runtime.actor = { actor_id: f.actor.actor_id, position: { x: 11, y: -3 } }
  await f.agent.request(goal.objective, { sender: 'owner' })
  const stored = JSON.parse(await fsp.readFile(f.options.stateFile))
  assert.equal(stored.current.pending.protocol_version, 2)
  assert.equal(stored.budget.calls, 1)
  assert.equal(f.mutations.length, 1)
  assert.ok(f.mutations[0].includes(stored.current.pending.operation_key))
  assert.equal(f.requests[0].context.controlProtocol, 'pursuit')
  assert.equal(f.requests[0].context.allowTools, false)
  assert.match(JSON.parse(f.requests[0].messages[1].content).world.inventory, /name = "copper-ore"/)
  assert.deepEqual(JSON.parse(f.requests[0].messages[1].content).world.actor_position, { x: 11, y: -3 })
  assert.ok(stored.budget.inputChars >= JSON.stringify(f.requests[0].messages).length)
  await f.agent.pollPursuit()
  assert.equal(f.requests.length, 1)
  f.complete(); f.satisfy()
  assert.equal((await f.agent.pollPursuit()).goalStatus, 'completed')
  assert.equal(f.agent.loop.snapshot().history[0].verdict, 'admitted_completed')
  assert.equal(f.requests.length, 1)
})

test('campaign allowance survives failure, restart, Resume and a new owner goal', async t => {
  const f = await fixture(t, [new Error('provider failure'), { pauseReason: 'Cannot progress this turn.' }, { pauseReason: 'No action.' }])
  await f.agent.request(goal.objective)
  assert.equal(f.agent.loop.state.budget.calls, 1)
  const restarted = new PursuitRuntime(f.options)
  const resumed = await restarted.request('Resume')
  assert.equal(restarted.loop.state.budget.calls, 2, JSON.stringify(resumed))
  const objective = { ...goal, objective: 'Gather ore for a second owner request.' }
  await restarted.request(JSON.stringify(objective))
  assert.equal(restarted.loop.state.budget.calls, 3)
  assert.equal(restarted.loop.state.budget.startedAt, 1000)
  assert.equal(restarted.archives[0].objective, goal.objective)
})

test('lost acknowledgement blocks new goals, replay and provider calls after restart', async t => {
  const f = await fixture(t)
  f.failSend()
  await f.agent.request(goal.objective)
  const pending = f.agent.loop.snapshot().pending
  const restarted = new PursuitRuntime(f.options)
  const result = await restarted.request('Resume')
  assert.equal(result.goalStatus, 'paused')
  assert.equal(restarted.loop.state.pending.operation_key, pending.operation_key)
  await assert.rejects(restarted.request(JSON.stringify({ ...goal, objective: 'Different outcome.' })), /pending_effect/)
  assert.equal(f.requests.length, 1)
  assert.equal(f.mutations.length, 1)
})

test('native reservations and human target provenance refuse mutations deterministically', async t => {
  const f = await fixture(t, [{ pauseReason: 'Fixture setup.' }])
  await f.agent.request(goal.objective)
  f.agent.memory.recordReservation('unused', { unit_number: 25, entity_name: 'iron-chest', reserved_by: 'owner' })
  const withdraw = [{ name: 'move_items_exact', args: { unit_number: 25, item_name: 'iron-plate', max_count: 1, to_entity: false } }]
  assert.equal((await f.agent.admit(withdraw, f.agent.loop.state.actor)).ok, false)
  const command = f.options.rcon.command
  f.options.rcon.command = async text => text.includes('autorio_preflight')
    ? JSON.stringify({ ok: true, target: { unit_number: 27, last_user: { name: 'owner' } } }) : command(text)
  assert.equal((await f.agent.admit([{ name: 'mine_entity_exact', args: { unit_number: 27 } }], f.agent.loop.state.actor)).code, 'protected_entity')
  assert.equal(f.mutations.length, 0)
  assert.equal((await f.agent.admit([{ name: 'harvest_product', args: { product_name: 'wooden-chest', count: 1 } }], f.agent.loop.state.actor)).ok, false)
})

test('pursuit harvest routes only through the positive natural-source guard and retains correlated identity', async t => {
  const f = await fixture(t, [{ operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 1 } }] }])
  const command = f.options.rcon.command
  f.options.rcon.command = text => text.includes('autorio_preflight')
    ? JSON.stringify({ ok: true, natural_only: true, source_names: ['tree-01'] }) : command(text)
  await f.agent.request(goal.objective)
  assert.equal(f.mutations.length, 1)
  assert.match(f.mutations[0], /harvest_natural_product/)
  assert.equal(f.agent.loop.state.pending.operations[0].name, 'harvest_product')
  const rows = (await fsp.readFile(f.options.traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
  const admitted = rows.find(row => row.event === 'pursuit.natural_harvest_admitted')
  assert.equal(admitted.request_id, f.agent.loop.state.request_id)
  assert.equal(admitted.reason, 'native_natural_source_guard_verified')
  assert.throws(() => renderPursuitOperation({ name: 'harvest_product', args: { product_name: 'wood', count: '1);evil()' } }))
})

test('pursuit harvest refuses legacy-only mod preflight and active reservations', async t => {
  const f = await fixture(t, [{ operations: [{ name: 'harvest_product', args: { product_name: 'wood', count: 1 } }] }, { pauseReason: 'Fixture exhausted.' }])
  await f.agent.request(goal.objective)
  assert.equal(f.mutations.length, 0)
  const harvest = [{ name: 'harvest_product', args: { product_name: 'wood', count: 1, search_radius: 256 } }]
  assert.equal((await f.agent.admit(harvest, f.agent.loop.state.actor)).code, 'pursuit_natural_guard_unavailable')
  f.agent.memory.recordReservation('unused', { unit_number: 25, reserved_by: 'owner' })
  assert.equal((await f.agent.admit(harvest, f.agent.loop.state.actor)).code, 'pursuit_harvest_reserved_world')
})

test('pursuit explains bounded decision submission and grounded blockers', () => {
  const prompt = pursuitMessages({ objective: 'Research green science.' })[0].content
  assert.match(prompt, /Native Factorio actions ARE available/)
  assert.match(prompt, /validates and executes the bounded requests/)
  assert.match(prompt, /name the blocker and supporting observation/)
})

test('two dispatched owner goals share the native ordinal and cumulative campaign', async t => {
  const f = await fixture(t, [action, action])
  await f.agent.request(goal.objective)
  f.complete(); f.satisfy()
  await f.agent.pollPursuit()
  const first = f.agent.loop.state.ordinal
  // A new objective can still need work in the same actor/native campaign.
  const command = f.options.rcon.command
  f.options.rcon.command = text => text.includes('evaluate_condition') ? JSON.stringify({ ok: true, current: 0, satisfied: false }) : command(text)
  await f.agent.request(JSON.stringify({ ...goal, objective: 'Gather ten copper ore for another request.' }))
  assert.equal(f.agent.loop.state.ordinal, first + 1)
  assert.equal(f.agent.loop.state.budget.calls, 2)
  assert.equal(f.mutations.length, 2)
})

test('native atomic queue guard refuses same-actor work started during provider await', async t => {
  const f = await fixture(t)
  f.agent.provider = pursuitProvider(async () => { f.runtime.queue_length = 1; f.runtime.task_state = 'running'; return { content: JSON.stringify(action) } })
  const command = f.options.rcon.command
  f.options.rcon.command = async text => {
    if (text.includes('SGLUNA_RESULT_')) {
      assert.ok(text.includes('s.task_state~="idle" or s.queue_length~=0'))
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)[0]
      return marker + JSON.stringify({ ok: false, result: 'admission_begin_refused:unowned_native_work', prefix: [] })
    }
    return command(text)
  }
  const result = await f.agent.request(goal.objective)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(f.agent.loop.state.pending, null)
  assert.equal(f.agent.loop.state.history.at(-1).verdict, 'not_admitted')
  assert.equal(f.mutations.length, 0)
})

test('native actor changes during a provider request discard its actions but charge the call', async t => {
  const f = await fixture(t)
  f.agent.provider = pursuitProvider(async () => { f.actor.epoch++; return { content: JSON.stringify(action) } })
  await f.agent.request(goal.objective)
  assert.equal(f.agent.loop.state.pauseReason, 'pursuit_stale_actor')
  assert.equal(f.agent.loop.state.budget.calls, 1)
  assert.equal(f.mutations.length, 0)
})

test('trusted intake refuses changed predicates in provider decisions and mismatched unstructured goals', async t => {
  assert.throws(() => pursuitIntake('A different result.', goal), /owner goal/)
  const f = await fixture(t, [{ predicate: { satisfied: true }, operations: [] }])
  await f.agent.request(goal.objective)
  assert.equal(f.agent.loop.state.pauseReason, 'decision_unknown_field')
  assert.equal(f.mutations.length, 0)
  assert.equal(f.agent.loop.state.objective, goal.objective)
})

test('retained blocker-style reply pauses truthfully while large reads consume the same campaign', async t => {
  const f = await fixture(t, [{ observations: [{ name: 'getInventoryItems', args: {} }] },
    { notes: 'Copper and iron triggers remain unmet.', operations: [], pauseReason: 'Cannot perform remaining work this turn.' }])
  const command = f.options.rcon.command
  f.options.rcon.command = text => text.includes('get_inventory') ? JSON.stringify({ evidence: 'native inventory facts '.repeat(2000) }) : command(text)
  await f.agent.request(goal.objective)
  assert.equal(f.agent.loop.state.status, 'paused')
  assert.match(f.agent.loop.state.pauseReason, /provider_reported/)
  assert.equal(f.requests.length, 2)
  assert.equal(f.mutations.length, 0)
  assert.equal(f.agent.loop.state.metrics[0].usage.prompt_tokens_details.cached_tokens, 40)
})

test('corrupt campaign budget storage fails closed rather than granting a fresh allowance', async t => {
  const f = await fixture(t, [new Error('provider failure')])
  await f.agent.request(goal.objective)
  const stored = JSON.parse(await fsp.readFile(f.options.stateFile))
  stored.budget.calls = 0
  await fsp.writeFile(f.options.stateFile, JSON.stringify(stored))
  await assert.rejects(new PursuitRuntime(f.options).loadPersistentState(), /budget_mismatch/)
  assert.equal(f.requests.length, 1)
})

test('pursuit provider wire protocol preserves JSON and never injects legacy control/tools', async () => {
  let body
  const decision = { notes: 'Inspect.', observations: [{ name: 'getInventoryItems', args: {} }] }
  const history = pursuitMessages({ objective: 'Owner objective', predicate: goal.predicate })
  const message = await providerRequest({ base: 'http://127.0.0.1:18317/v1', key: 'fixture', model: 'gpt-6-luna', profile: 'local' }, history, {
    controlProtocol: 'pursuit', allowTools: false, promptTraceFile: null,
    fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: JSON.stringify(decision) }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 } }), { status: 200 }) },
  })
  assert.deepEqual(body.messages, history)
  assert.equal(body.tools.length, 1)
  assert.equal(body.tools[0].function.name, 'submitPursuitDecision')
  assert.equal(message.content, JSON.stringify(decision))
  assert.equal(message._sglunaProvider.diagnostic_code, 'ok')
})

test('retained Luna oversized-response finding charges one attempt and pauses without admission or automatic retry', async t => {
  const f = await fixture(t)
  const traceFile = path.join(path.dirname(f.options.stateFile), 'provider.jsonl')
  let attempts = 0
  const provider = (messages, context) => providerRequest({ base: 'http://127.0.0.1:18317/v1', key: 'fixture', model: 'gpt-6-luna', profile: 'local' }, messages, {
    ...context, promptTraceFile: traceFile,
    fetchImpl: async (_url, options) => {
      attempts++
      assert.equal(JSON.parse(options.body).max_tokens, 4000)
      // The live body was not retained after reader cancellation. Reproduce
      // its observed byte count/guard failure, without inventing model output.
      return new Response('x'.repeat(263521), { status: 200 })
    },
  })
  const agent = new PursuitRuntime({ ...f.options, provider })
  const result = await agent.request(goal.objective)
  assert.equal(result.goalStatus, 'paused')
  assert.equal(agent.loop.state.pauseReason, 'Provider response too large')
  assert.equal(agent.loop.state.budget.calls, 1)
  assert.equal(agent.loop.state.pending, null)
  assert.equal(f.mutations.length, 0)
  const restarted = new PursuitRuntime({ ...f.options, provider })
  await restarted.loadPersistentState()
  await restarted.pollPursuit()
  assert.equal(restarted.loop.state.budget.calls, 1)
  assert.equal(attempts, 1)
  const rows = (await fsp.readFile(traceFile, 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(rows.filter(row => row.event === 'provider.request').length, 1)
  assert.equal(rows.find(row => row.event === 'provider.response_error').response_bytes, 263521)
})
