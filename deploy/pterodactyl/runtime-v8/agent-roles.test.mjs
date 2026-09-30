import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_ROLES, EXECUTOR_ROLE, PLANNER_ROLE, resolveAgentRole } from './agent-roles.mjs'
import { configuration, Session } from './supervisor.mjs'

// Delegation U1: role config. Static/unit only: no provider calls.

function baseEnv(overrides = {}) {
  return {
    SGLUNA_ACTOR_MODE: 'npc',
    OPENAI_API_KEY: `fixture-key-${'x'.repeat(20)}`,
    OPENAI_MODEL: 'flash-model',
    OPENAI_API_BASEURL: 'https://provider.example.test/v1',
    ...overrides,
  }
}

function sessionFor(config) {
  const calls = []
  const session = new Session({
    root: '/tmp/sgluna-test',
    app: '/tmp/app',
    game: '/tmp/game',
    config,
    save: 'x',
    settingsFile: 'x',
    modDir: 'x',
    ini: 'x',
    log: () => {},
    provider: async (...args) => {
      calls.push(args)
      return { content: 'ok' }
    },
  })
  return { session, calls }
}

test('role names are exported constants', () => {
  assert.equal(PLANNER_ROLE, 'planner')
  assert.equal(EXECUTOR_ROLE, 'executor')
  assert.deepEqual([...AGENT_ROLES], ['planner', 'executor'])
})

test('resolveAgentRole maps planner to models[0] and executor to models[1] with fallback to models[0]', () => {
  const two = configuration({}, baseEnv({ OPENAI_MODEL: 'draft-model, exec-model' }))
  assert.equal(resolveAgentRole(two, PLANNER_ROLE).model, 'draft-model')
  assert.equal(resolveAgentRole(two, EXECUTOR_ROLE).model, 'exec-model')
  assert.equal(resolveAgentRole(two, PLANNER_ROLE).role, 'planner')
  assert.equal(resolveAgentRole(two, EXECUTOR_ROLE).role, 'executor')

  const one = configuration({}, baseEnv())
  assert.equal(resolveAgentRole(one, PLANNER_ROLE).model, 'flash-model')
  assert.equal(resolveAgentRole(one, EXECUTOR_ROLE).model, 'flash-model')

  // A config carrying only `model` (no parsed list) still resolves.
  assert.equal(resolveAgentRole({ model: 'solo' }, EXECUTOR_ROLE).model, 'solo')
})

test('resolveAgentRole defaults to planner, rejects unknown roles and does not mutate the config', () => {
  const config = configuration({}, baseEnv({ OPENAI_MODEL: 'a,b' }))
  const before = JSON.stringify(config)
  assert.equal(resolveAgentRole(config).role, 'planner')
  assert.equal(resolveAgentRole(config, undefined).model, 'a')
  assert.throws(() => resolveAgentRole(config, 'reviewer'), /Unknown agent role: reviewer/)
  assert.throws(() => resolveAgentRole(config, null), /Unknown agent role/)
  assert.equal(JSON.stringify(config), before)
  const resolved = resolveAgentRole(config, EXECUTOR_ROLE)
  assert.equal(resolved.base, config.base)
  assert.equal(resolved.key, config.key)
  assert.equal(resolved.profile, config.profile)
  assert.equal(resolved.timeoutMs, config.providerTimeoutMs)
})

test('single-model config: the provider request is byte-identical to the pre-roles request for every role', async () => {
  const config = configuration({}, baseEnv({ OPENAI_MODEL: 'flash-model', PROVIDER_TIMEOUT_MS: '123456' }))
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }]
  // The request the supervisor built before roles existed.
  const legacy = {
    base: config.base,
    key: config.key,
    model: config.model,
    profile: config.profile,
    timeoutMs: config.providerTimeoutMs,
  }
  const baseline = { request: JSON.stringify(legacy), messages: JSON.stringify(messages), context: JSON.stringify({ epoch: 4 }) }
  for (const context of [{ epoch: 4 }, { epoch: 4, role: 'planner' }, { epoch: 4, role: 'executor' }]) {
    const { session, calls } = sessionFor(config)
    await session.roleProvider(messages, context)
    assert.equal(calls.length, 1)
    const [request, sentMessages, sentContext] = calls[0]
    assert.equal(JSON.stringify(request), baseline.request)
    assert.deepEqual(Object.keys(request), ['base', 'key', 'model', 'profile', 'timeoutMs'])
    assert.equal(sentMessages, messages)
    assert.equal(sentContext, context)
  }
  // No context at all behaves the same as today's planner-less call.
  const { session, calls } = sessionFor(config)
  await session.roleProvider(messages, undefined)
  assert.equal(JSON.stringify(calls[0][0]), baseline.request)
  assert.equal(calls[0][2], undefined)
})

test('two-model config: roleProvider sends planner to models[0], executor to models[1], and a missing role to planner', async () => {
  const config = configuration({}, baseEnv({ OPENAI_MODEL: 'draft-model,exec-model' }))
  const { session, calls } = sessionFor(config)
  await session.roleProvider([], { role: 'planner' })
  await session.roleProvider([], { role: 'executor' })
  await session.roleProvider([], {})
  await session.roleProvider([], undefined)
  assert.deepEqual(calls.map(call => call[0].model), ['draft-model', 'exec-model', 'draft-model', 'draft-model'])
  for (const [request] of calls) {
    assert.deepEqual(Object.keys(request), ['base', 'key', 'model', 'profile', 'timeoutMs'])
    assert.equal(request.base, config.base)
    assert.equal(request.key, config.key)
  }
  await assert.rejects(async () => session.roleProvider([], { role: 'nope' }), /Unknown agent role/)
})
