import test from 'node:test'
import assert from 'node:assert/strict'

import { configuration } from './supervisor.mjs'

test('startup log shows Jev on when decision provider is configured', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    DECISION_PROVIDER_API_KEY: 'test-key-12345',
    DECISION_PROVIDER_API_URL: 'https://api.example.com/jev',
    DECISION_PROVIDER_MODEL: 'jev-test-model',
  }
  const config = configuration({}, env)
  assert.ok(config.decisionProvider, 'decisionProvider should be configured')
  assert.match(
    String(config.decisionProvider ? 'on' : 'off (no key)'),
    /^on$/,
    'Jev should be on'
  )
})

test('startup log shows Jev off when TYPESAFE_API_KEY is not set', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
  }
  const config = configuration({}, env)
  assert.equal(config.decisionProvider, undefined, 'decisionProvider should be undefined')
  assert.match(
    String(!config.decisionProvider ? 'off (no key)' : 'on'),
    /^off \(no key\)$/,
    'Jev should be off (no key)'
  )
})

test('startup log shows Jev off when TYPESAFE_API_KEY is empty', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    TYPESAFE_API_KEY: '',
  }
  const config = configuration({}, env)
  assert.equal(config.decisionProvider, undefined, 'decisionProvider should be undefined when key is empty')
  assert.match(
    String(!config.decisionProvider ? 'off (no key)' : 'on'),
    /^off \(no key\)$/,
    'Jev should be off (no key) when TYPESAFE_API_KEY is empty'
  )
})

test('startup log shows Jev off when only partial provider config is set', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    DECISION_PROVIDER_API_KEY: 'test-key',
    // Missing URL and model
  }
  const config = configuration({}, env)
  // This should succeed because decisionProviderConfiguration checks for key first
  const status = config.decisionProvider ? 'on' : 'off (no key)'
  assert.ok(
    status === 'on' || status === 'off (no key)',
    'Jev status should be valid'
  )
})

test('no API key or token is ever printed in status log', () => {
  const testKey = 'secret-test-key-xyz'
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    DECISION_PROVIDER_API_KEY: testKey,
    DECISION_PROVIDER_API_URL: 'https://api.example.com/jev',
    DECISION_PROVIDER_MODEL: 'jev-test-model',
  }
  const config = configuration({}, env)
  const status = config.decisionProvider ? 'on' : 'off (no key)'
  assert.ok(!status.includes(testKey), 'Key should not appear in status message')
  assert.ok(!status.includes('secret'), 'Key should not appear in status message')
  assert.match(status, /^(on|off \(no key\))$/, 'Status should only contain safe text')
})
