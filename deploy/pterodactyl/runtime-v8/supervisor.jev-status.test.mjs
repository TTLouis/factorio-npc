import test from 'node:test'
import assert from 'node:assert/strict'

import { configuration, jevStatusLine } from './supervisor.mjs'

test('jevStatusLine returns on when decision provider is configured', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    DECISION_PROVIDER_API_KEY: 'test-key-12345',
    DECISION_PROVIDER_API_URL: 'https://api.example.com/jev',
    DECISION_PROVIDER_MODEL: 'jev-test-model',
  }
  const config = configuration({}, env)
  const line = jevStatusLine(config)
  assert.equal(line, 'Jev: on')
  // Verify no part of the key appears in the output
  assert.ok(!line.includes('test-key'), 'Key should not appear in status line')
  const sixCharSubstrings = []
  for (let i = 0; i <= 'test-key-12345'.length - 6; i++) {
    sixCharSubstrings.push('test-key-12345'.substring(i, i + 6))
  }
  for (const substr of sixCharSubstrings) {
    assert.ok(!line.includes(substr), `Key substring "${substr}" should not appear in status line`)
  }
})

test('jevStatusLine returns off (no key) when decision provider is not configured', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
  }
  const config = configuration({}, env)
  const line = jevStatusLine(config)
  assert.equal(line, 'Jev: off (no key)')
})

test('jevStatusLine returns off (no key) when TYPESAFE_API_KEY is empty', () => {
  const env = {
    OPENAI_API_KEY: 'test-main-key',
    OPENAI_MODEL: 'test-model',
    OPENAI_API_BASEURL: 'https://api.example.com/v1',
    TYPESAFE_API_KEY: '',
  }
  const config = configuration({}, env)
  const line = jevStatusLine(config)
  assert.equal(line, 'Jev: off (no key)')
})
