import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { buildArtifacts } from './build-payload.mjs'

test('both eggs expose mode-specific optional setup without requiring a plan provider for external mode', () => {
  const artifacts = buildArtifacts(readFileSync(new URL('./payload-src/installer.sh', import.meta.url)))
  for (const text of [artifacts.mainEggJson, artifacts.e2eEggJson]) {
    const egg = JSON.parse(text)
    const variables = new Map(egg.variables.map(entry => [entry.env_variable, entry]))
    assert.equal(variables.size, egg.variables.length, 'configuration names are unique')
    const mode = variables.get('SGLUNA_HARNESS_MODE')
    assert.equal(mode.default_value, 'plan')
    assert.match(mode.rules, /in:external,plan,pursuit/)
    assert.equal(variables.get('SGLUNA_SOURCE_REF').default_value, 'main')
    for (const name of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_API_BASEURL', 'SGLUNA_RCON_HOST', 'SGLUNA_RCON_PORT', 'SGLUNA_RCON_PASSWORD', 'EXTERNAL_HARNESS_SESSION', 'EXTERNAL_HARNESS_STATE_DIR', 'OPERATOR_PROVIDER_BASE', 'CLI_PROXY_GATEWAY_KEY', 'SGLUNA_PURSUIT_PROFILE']) {
      assert.match(variables.get(name)?.rules ?? '', /nullable/, name)
    }
    assert.equal(variables.get('SGLUNA_RCON_HOST').default_value, '127.0.0.1')
    assert.equal(variables.get('SGLUNA_RCON_PORT').default_value, '', 'plan retains automatic port selection')
    for (const name of ['SGLUNA_RCON_PASSWORD', 'CLI_PROXY_GATEWAY_KEY']) {
      assert.equal(variables.get(name).user_viewable, false)
      assert.equal(variables.get(name).default_value, '')
    }
  }
})
