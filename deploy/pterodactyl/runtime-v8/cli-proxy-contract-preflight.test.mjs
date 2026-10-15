import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { configuration, Session } from './supervisor.mjs'
import * as provider from './provider.mjs'
import { resolveAgentRole } from './agent-roles.mjs'
import { getActivePlan } from './planning-state.mjs'
import { FurnaceFactorio, ScriptedModel, recoveryWorld, recoverySession, settle, completeAndReport, KEY } from './recovery-loop-fixtures.mjs'
import { inventoryCheckpoint, planReply } from './task-loop-fixtures.mjs'

const captured = JSON.parse(await fs.readFile(new URL('./fixtures/run-u-cli-proxy-closed-contract.json', import.meta.url), 'utf8'))
const [capturedError] = captured.provider_response_error
const history = captured.closed_request.message_refs.map(ref => captured.wire_message_pool[ref])
const env = (extra = {}) => ({ SGLUNA_ACTOR_MODE: 'npc', OPENAI_API_KEY: 'fixture-only', OPENAI_API_BASEURL: 'https://proxy.example.test/v1', OPENAI_MODEL: 'gpt-6.1-sol,gpt-6-luna', ...extra })
const reply = message => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1200, completion_tokens: 100, total_tokens: 1300 } }), { status: 200 })
const tool = (name, args = {}) => ({ content: null, tool_calls: [{ id: `probe-${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
const submit = intent => tool('submitPlan', intent)

function bridge(config, fetchImpl) {
  const session = Object.create(Session.prototype)
  session.config = config
  session.provider = (roleConfig, messages, context) => provider.providerRequest(roleConfig, messages, { ...context, promptTraceFile: null, fetchImpl })
  return session
}

test('selected Run U evidence retains the actual generic closed request and rejects attachment speculation', () => {
  assert.equal(captured.candidate, '6ceaa2ae65f2a00e479ba45d56bd64eb79ee457e')
  assert.equal(captured.closed_request.request_id, 'recovery_mva623o2')
  assert.equal(captured.closed_request.ts, '2026-10-15T23:28:27.371Z')
  assert.equal(captured.closed_request.allow_tools, false)
  assert.equal(captured.closed_request.capability_profile, 'generic')
  assert.deepEqual(captured.closed_request.payload_without_messages, { model: 'gpt-6-luna', max_tokens: 4000 })
  assert.equal(history.length, 16)
  assert.ok(history.every(message => message && typeof message.role === 'string'))
  assert.equal(captured.provider_response_error.length, 1)
  assert.equal(capturedError.response_bytes, 270557)
  assert.equal(capturedError.diagnostic_code, 'provider_response_too_large')
  assert.equal(captured.guard_source.body_cap_bytes, 262144)
  assert.equal(captured.failed_response_body_available, false)
  assert.match(captured.body_unavailability_reason, /no response content logged.*Do not infer attachment\/content shape/)
  assert.equal(captured.native_final.production['copper-plate'].produced, 10)
  assert.equal(captured.native_final.production['iron-plate'].produced, 0)
  assert.equal(captured.native_final.red_produced_count, 0)
})

test('configuration through Session.roleProvider reproduces generic Run U shape; explicit CLI-proxy keeps both role schemas while closed', async () => {
  const generic = configuration({}, env())
  const proxy = configuration({}, env({ AI_API_METHOD: 'cli-proxy' }))
  assert.equal(generic.aiApiMethod, undefined)
  assert.equal(generic.profile, 'auto')
  const wires = []
  for (const config of [generic, proxy]) {
    const session = bridge(config, async (_url, options) => { wires.push({ config, body: JSON.parse(options.body) }); return reply({ content: '{}' }) })
    for (const role of ['planner', 'executor']) {
      await session.roleProvider(history, { role, allowTools: false, requestId: captured.closed_request.request_id, triggerSource: 'recovery', recoveryAttempt: 0 })
    }
  }
  assert.deepEqual(wires.slice(0, 2).map(row => Object.keys(row.body)), [['model', 'messages', 'max_tokens'], ['model', 'messages', 'max_tokens']])
  assert.deepEqual(wires[1].body.model, captured.closed_request.payload_without_messages.model)
  assert.equal(wires[1].body.max_tokens, 4000)
  for (const [index, { body }] of wires.slice(2).entries()) {
    assert.equal(body.model, index === 0 ? 'gpt-6.1-sol' : 'gpt-6-luna')
    assert.equal(body.tool_choice, 'none')
    const schema = body.tools.find(row => row.function.name === 'submitPlan').function.parameters
    assert.ok(body.tools.some(row => row.function.name === 'getEntityStatus'))
    assert.equal(schema.required.includes('stepId'), index === 1)
    assert.equal(schema.required.includes('plan'), index === 0)
    assert.ok(body.messages.some(row => typeof row.content === 'string' && row.content.includes('steam-power')))
  }
})

test('CLI-proxy method is an explicit configuration choice; model/gateway names and stored mirror cannot infer it', () => {
  for (const raw of [{}, { aiApiMethod: 'cli-proxy' }, { providerUrl: 'https://proxy.example.test/v1', model: 'gpt-6.1-sol,gpt-6-luna' }]) {
    const config = configuration(raw, env())
    assert.equal(config.aiApiMethod, undefined)
    assert.equal(provider.providerCapabilityProfile(resolveAgentRole(config, 'executor')).id, 'generic')
  }
  const explicit = configuration({ providerProfile: 'generic' }, env({ AI_API_METHOD: 'cli-proxy', PROVIDER_PROFILE: 'generic' }))
  assert.equal(explicit.aiApiMethod, 'cli-proxy')
  assert.equal(explicit.profile, 'cli-proxy')
  assert.equal(explicit.aiApiMethodOverridesProfile, true)
})

test('explicit CLI-proxy preflight verifies two actual closed wire bodies without external fetches or mutable budget changes', async t => {
  const config = configuration({}, env({ AI_API_METHOD: 'cli-proxy' }))
  const before = structuredClone(config)
  let externalFetches = 0
  t.mock.method(globalThis, 'fetch', async () => { externalFetches++; throw new Error('external inference forbidden in deterministic preflight') })
  assert.equal(typeof provider.verifyCliProxyProviderContracts, 'function')
  const proof = await provider.verifyCliProxyProviderContracts(config, { requestId: 'fixture_cli_proxy_preflight' })
  assert.equal(externalFetches, 0)
  assert.deepEqual(config, before)
  assert.equal(proof.event, 'provider.cli_proxy_contract_verified')
  assert.equal(proof.request_id, 'fixture_cli_proxy_preflight')
  assert.equal(proof.reason, 'explicit_cli_proxy_method_and_role_closed_wire_verified')
  assert.equal(proof.status, 'pass')
  assert.equal(proof.ai_api_method, 'cli-proxy')
  assert.equal(proof.external_inference_calls, 0)
  assert.deepEqual(proof.roles.map(row => row.role), ['planner', 'executor'])
  for (const row of proof.roles) {
    assert.equal(row.body.model, row.role === 'planner' ? 'gpt-6.1-sol' : 'gpt-6-luna')
    assert.equal(row.body.tool_choice, 'none')
    assert.ok(row.body.tools.some(tool => tool.function.name === 'submitPlan'))
    assert.equal(row.profile, 'cli-proxy')
    assert.equal(row.capabilities.model_family, 'openai-gpt')
    assert.equal(row.capabilities.tools_kept_when_closed, true)
    const schema = row.body.tools.find(tool => tool.function.name === 'submitPlan').function.parameters
    assert.equal(schema.required.includes('stepId'), row.role === 'executor')
    assert.equal(schema.required.includes('plan'), row.role === 'planner')
  }
})

test('deterministic CLI-proxy preflight rejects ambiguous methods and non-GPT role configuration before any external call', async t => {
  let externalFetches = 0
  t.mock.method(globalThis, 'fetch', async () => { externalFetches++; throw new Error('unexpected paid call') })
  assert.equal(typeof provider.verifyCliProxyProviderContracts, 'function')
  for (const config of [
    configuration({}, env()),
    configuration({}, env({ AI_API_METHOD: 'direct' })),
    configuration({}, env({ AI_API_METHOD: 'local' })),
    configuration({}, env({ AI_API_METHOD: 'router', OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1' })),
    configuration({}, env({ AI_API_METHOD: 'cli-proxy', OPENAI_MODEL: 'gpt-6.1-sol,qwen3-coder-30b-a3b-instruct' })),
    configuration({}, env({ AI_API_METHOD: 'cli-proxy', OPENAI_MODEL: 'qwen3-coder-30b-a3b-instruct,gpt-6-luna' })),
    { ...configuration({}, env({ AI_API_METHOD: 'cli-proxy' })), profile: 'generic' },
  ]) await assert.rejects(provider.verifyCliProxyProviderContracts(config, { requestId: 'fixture_bad_proxy_configuration' }), /CLI.proxy|local|GPT|closed/i)
  assert.equal(externalFetches, 0)
})

test('generic, direct and router GPT requests retain conservative existing closed behavior', async () => {
  for (const extra of [{}, { AI_API_METHOD: 'direct' }, { AI_API_METHOD: 'router', OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1' }]) {
    const wires = []
    const session = bridge(configuration({}, env(extra)), async (_url, options) => { wires.push(JSON.parse(options.body)); return reply({ content: '{}' }) })
    await session.roleProvider(history, { role: 'executor', allowTools: false, triggerSource: 'recovery' })
    assert.equal(wires[0].tools, undefined)
    assert.equal(wires[0].tool_choice, undefined)
    assert.equal(wires[0].model, 'gpt-6-luna')
  }
})

test('CLI-proxy contract applies to closed planner/executor decisions; ordinary observations remain available and scoped JSON-only calls remain distinct', async () => {
  const wires = []
  const session = bridge(configuration({}, env({ AI_API_METHOD: 'cli-proxy' })), async (_url, options) => { wires.push(JSON.parse(options.body)); return reply({ content: '{}' }) })
  await session.roleProvider(history, { role: 'executor', allowTools: true, triggerSource: 'recovery' })
  assert.equal(wires[0].tool_choice, 'auto')
  assert.ok(wires[0].tools.some(row => row.function.name === 'getEntityStatus'))
  await session.roleProvider([{ role: 'user', content: 'Route this message.' }], { role: 'planner', allowTools: false, interactionRouter: true, triggerSource: 'interaction_router', requestBodyPatch: { max_tokens: 180 } })
  assert.equal(wires[1].tools, undefined)
  assert.equal(wires[1].tool_choice, undefined)
  assert.equal(wires[1].max_tokens, 180)
})

test('256 KiB guard still rejects oversized synthetic text even with a correct CLI-proxy closed contract', async () => {
  let called = 0
  const config = configuration({}, env({ AI_API_METHOD: 'cli-proxy' }))
  const session = bridge(config, async (_url, options) => {
    called++
    const body = JSON.parse(options.body)
    assert.equal(body.tool_choice, 'none')
    // Synthetic size-boundary fixture: Run U's rejected body was unavailable.
    // This is deliberately text, and makes no claim about its original content.
    return reply({ content: 'x'.repeat(capturedError.response_bytes) })
  })
  await assert.rejects(session.roleProvider(history, { role: 'executor', allowTools: false, triggerSource: 'recovery' }), /Provider response too large/)
  assert.equal(called, 1, 'no implicit retry or cap increase')
})

class IronBootstrapGame extends FurnaceFactorio {
  smelt(count) {
    if ((this.furnace.output['copper-plate'] ?? 0) > 0 && (this.furnace.source['iron-ore'] ?? 0) > 0) return 0
    return super.smelt(count)
  }
}

test('configured CLI-proxy full loop clears copper output, smelts and collects fifty iron on one immutable step with unchanged limits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const config = configuration({}, env({ AI_API_METHOD: 'cli-proxy' }))
  const budgets = { hourly: config.budget, output: config.maxProviderOutputUnits }
  const proof = await provider.verifyCliProxyProviderContracts(config, { requestId: 'fixture_full_loop_preflight' })
  assert.equal(proof.event, 'provider.cli_proxy_contract_verified')
  const game = new IronBootstrapGame({ inventory: { 'iron-plate': 8 }, furnace: { output: { 'copper-plate': 10 }, source: { 'iron-ore': 50 }, fuel: { wood: 8 } } })
  const model = new ScriptedModel(), wires = []
  const connection = bridge(config, async (_url, options) => {
    const body = JSON.parse(options.body)
    wires.push(body)
    const context = connection.currentContext
    return reply(await model.provide(body.messages, context))
  })
  const world = recoveryWorld({ game, model, agentRoleConfig: config, roleProvider: (messages, context) => { connection.currentContext = context; return connection.roleProvider(messages, context) } })
  const { session, logs } = recoverySession(world)
  const ctx = { game, model, world, session }
  const checkpoint = inventoryCheckpoint('iron-plate', 58), step = 'Clear the copper output, smelt the iron ore and collect fifty iron plates'
  const decision = operations => ({ chatMessage: '', stepId: world.agent.targetedObservationIdentity().data.stepId, operations })
  let identity, allowance, budget
  model.push('planner', 'sol:iron-bootstrap', planReply({ plan: [step], currentStep: 0, operations: [], checkpoint,
    stepCompletions: [{ kind: 'deterministic', checkpoint }], goal: { scope: 'finite', summary: step, doneWhen: checkpoint.requirements } }))
    .push('executor', 'luna:read-furnace', () => {
      identity = structuredClone(getActivePlan(world.memory.planningState(KEY)))
      allowance = structuredClone(world.memory.autoResumeAllowance(KEY))
      // Declared last ordinary observation slot, as at the captured boundary.
      // The normal admission path consumes it and closes the next wire round.
      world.agent.observationBudgetRemaining = 1
      budget = world.agent.observationBudgetRemaining
      return tool('getEntityStatus', { name: 'stone-furnace', radius: 20 })
    })
    .push('executor', 'luna:clear-copper', (messages, context) => {
      assert.equal(context.allowTools, false)
      assert.equal(world.agent.observationBudgetRemaining, 0)
      const entity = JSON.parse(messages.findLast(row => row.role === 'tool').content).entity
      const plate = entity.inventories.find(row => row.index === 3).items.find(row => row.name === 'copper-plate')
      assert.equal(plate.count, 10)
      // Model chooses this actual fresh target; the harness does not insert a correction.
      return { content: JSON.stringify(decision([{ name: 'move_items_exact', args: { unit_number: entity.unit_number, item_name: plate.name, max_count: plate.count, to_entity: false } }])) }
    })
  assert.equal(game.smelt(50), 0)
  assert.equal(session.queuePlayerRequest('TTLouis', step), true)
  await settle(session)
  assert.ok(game.pendingBatch, JSON.stringify({ logs, labels: model.labels, violations: model.violations, trace: world.trace.slice(-12) }))
  assert.equal(game.inventory['copper-plate'], undefined)
  model.push('executor', 'luna:read-new-iron', tool('getEntityStatus', { unit_number: game.furnace.unit_number }))
    .push('executor', 'luna:collect-iron', messages => {
      const entity = JSON.parse(messages.findLast(row => row.role === 'tool').content).entity
      const plate = entity.inventories.find(row => row.index === 3).items.find(row => row.name === 'iron-plate')
      assert.equal(plate.count, 50)
      return submit(decision([{ name: 'move_items_exact', args: { unit_number: entity.unit_number, item_name: plate.name, max_count: plate.count, to_entity: false } }]))
    })
  await completeAndReport(ctx, { smelt: 50 })
  assert.equal(game.inventory['copper-plate'], 10)
  assert.equal(game.inventory['iron-plate'], 8, 'iron collection requires the admitted native-style operation receipt')
  const active = getActivePlan(world.memory.planningState(KEY))
  assert.deepEqual([active.plan_id, active.plan_version, active.steps[0].step_id, active.steps[0].completion_contract], [identity.plan_id, identity.plan_version, identity.steps[0].step_id, identity.steps[0].completion_contract])
  const afterAllowance = world.memory.autoResumeAllowance(KEY)
  // The progress mark includes receipt history; it legitimately changes when
  // the copper transfer settles. Limits, counters and ownership cannot change.
  for (const field of ['per_step', 'per_goal', 'step_attempts', 'goal_attempts', 'goal_id', 'plan_id', 'plan_version', 'step_id', 'step_key']) assert.equal(afterAllowance[field], allowance[field], field)
  await completeAndReport(ctx)
  assert.equal(game.inventory['iron-plate'], 58)
  assert.equal(world.named('goal.evaluated').at(-1).satisfied, true)
  assert.equal(game.pendingBatch, null); assert.equal(game.queueLength, 0)
  assert.equal(game.status.connected_players, 0)
  assert.deepEqual(model.violations, []); assert.deepEqual(model.remaining, [])
  assert.deepEqual(world.named('request.failed'), [])
  assert.deepEqual({ hourly: config.budget, output: config.maxProviderOutputUnits }, budgets)
  assert.ok(budget > 0)
  assert.equal(wires[0].model, 'gpt-6.1-sol')
  assert.ok(wires.slice(1).every(body => body.model === 'gpt-6-luna'))
  assert.ok(wires.some(body => body.tool_choice === 'auto'))
  assert.ok(wires.some(body => body.tool_choice === 'none'))
})
