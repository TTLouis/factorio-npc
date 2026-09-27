import assert from 'node:assert/strict'
import test from 'node:test'

import { configuration } from './supervisor.mjs'

function decisionKey() {
  return `fixture-typesafe-${'x'.repeat(24)}`
}

test('JEV-only configuration requires Jev but not Main-LLM credentials', () => {
  const config = configuration({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    SGLUNA_REASONING_MODE: 'jev_only',
    TYPESAFE_API_KEY: decisionKey(),
  })

  assert.equal(config.reasoningMode, 'jev_only')
  assert.equal(config.key, '')
  assert.equal(config.decisionProvider?.provider, 'typesafe')
  assert.equal(config.decisionProvider?.model, 'jev-latest')
})

test('JEV-only configuration rejects a missing Jev decision provider', () => {
  assert.throws(() => configuration({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    SGLUNA_REASONING_MODE: 'jev_only',
  }), /requires DECISION_PROVIDER_API_KEY or TYPESAFE_API_KEY/)
})

test('normal llm_jev mode keeps Main-LLM credential validation', () => {
  assert.throws(() => configuration({}, {
    SGLUNA_ACTOR_MODE: 'npc',
    SGLUNA_REASONING_MODE: 'llm_jev',
  }), /OPENAI_API_KEY/)
})
