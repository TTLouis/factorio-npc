import assert from 'node:assert/strict'
import test from 'node:test'

import { checkApiMethodUrlRule, profileForApiMethod } from './provider-base.mjs'
import { aiApiMethodLine, configuration, migrateConfig } from './supervisor.mjs'

// Plan 1.10: AI_API_METHOD (direct/router/local) replaces hand-picking a
// PROVIDER_PROFILE, adds a comma-separated OPENAI_MODEL list (main +
// reserved subagent model), and a method-aware https rule. These tests are
// static/unit only: no provider calls, no network, no Docker.

function baseEnv(overrides = {}) {
  return {
    SGLUNA_ACTOR_MODE: 'npc',
    OPENAI_API_KEY: `fixture-key-${'x'.repeat(20)}`,
    OPENAI_MODEL: 'main-model',
    OPENAI_API_BASEURL: 'https://provider.example.test/v1',
    ...overrides,
  }
}

test('profileForApiMethod maps each method to exactly one existing capability profile', () => {
  assert.equal(profileForApiMethod('direct'), 'auto')
  assert.equal(profileForApiMethod('router'), 'openrouter')
  assert.equal(profileForApiMethod('local'), 'local')
  assert.throws(() => profileForApiMethod('guess'), /Invalid AI_API_METHOD/)
  assert.throws(() => profileForApiMethod(undefined), /Invalid AI_API_METHOD/)
})

test('each method resolves the effective provider profile configuration expects', () => {
  const direct = configuration({}, baseEnv({ AI_API_METHOD: 'direct' }))
  assert.equal(direct.aiApiMethod, 'direct')
  assert.equal(direct.profile, 'auto')

  const router = configuration({}, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
  }))
  assert.equal(router.aiApiMethod, 'router')
  assert.equal(router.profile, 'openrouter')

  const local = configuration({}, baseEnv({
    AI_API_METHOD: 'local',
    OPENAI_API_BASEURL: 'http://host.docker.internal:1234/v1',
  }))
  assert.equal(local.aiApiMethod, 'local')
  assert.equal(local.profile, 'local')
})

test('AI_API_METHOD is case-insensitive and trims whitespace; an unknown value is rejected', () => {
  const config = configuration({}, baseEnv({ AI_API_METHOD: ' Router ' }))
  assert.equal(config.aiApiMethod, 'router')
  assert.throws(() => configuration({}, baseEnv({ AI_API_METHOD: 'openai' })), /AI_API_METHOD must be direct, router, or local/)
})

test('direct and router require https even to an otherwise-allowed local hostname', () => {
  assert.throws(
    () => checkApiMethodUrlRule('direct', 'http://localhost:8080/v1'),
    /AI_API_METHOD=direct requires an https OPENAI_API_BASEURL/,
  )
  assert.throws(
    () => checkApiMethodUrlRule('router', 'http://127.0.0.1:8080/v1'),
    /AI_API_METHOD=router requires an https OPENAI_API_BASEURL/,
  )
  assert.doesNotThrow(() => checkApiMethodUrlRule('direct', 'https://api.example.test/v1'))
  assert.throws(
    () => configuration({}, baseEnv({ AI_API_METHOD: 'direct', OPENAI_API_BASEURL: 'http://localhost:1234/v1' })),
    /AI_API_METHOD=direct requires an https OPENAI_API_BASEURL/,
  )
  assert.throws(
    () => configuration({}, baseEnv({ AI_API_METHOD: 'router', OPENAI_API_BASEURL: 'http://example.test/v1' })),
    /AI_API_METHOD=router requires an https OPENAI_API_BASEURL/,
  )
})

test('local allows plain http only to the fixed local hostname allowlist, https elsewhere', () => {
  assert.doesNotThrow(() => checkApiMethodUrlRule('local', 'http://localhost:1234/v1'))
  assert.doesNotThrow(() => checkApiMethodUrlRule('local', 'http://127.0.0.1:1234/v1'))
  assert.doesNotThrow(() => checkApiMethodUrlRule('local', 'http://[::1]:1234/v1'))
  assert.doesNotThrow(() => checkApiMethodUrlRule('local', 'http://host.docker.internal:1234/v1'))
  assert.doesNotThrow(() => checkApiMethodUrlRule('local', 'https://lmstudio.example.test/v1'))
  // checkApiMethodUrlRule itself only adds the direct/router https gate; the
  // existing providerEndpoint hostname allowlist (unchanged) is what actually
  // rejects a non-local http host for `local`, exercised end to end here.
  assert.throws(
    () => configuration({}, baseEnv({ AI_API_METHOD: 'local', OPENAI_API_BASEURL: 'http://not-local.example.test/v1' })),
    /Remote provider URL requires HTTPS/,
  )
})

test('OPENAI_MODEL is a comma-separated list: [0] is the main model, [1] is the reserved subagent model', () => {
  const single = configuration({}, baseEnv({ OPENAI_MODEL: 'solo-model' }))
  assert.equal(single.model, 'solo-model')
  assert.deepEqual(single.models, ['solo-model'])
  assert.equal(single.subagentModel, undefined)

  const pair = configuration({}, baseEnv({ OPENAI_MODEL: 'main-model, sub-model ' }))
  assert.equal(pair.model, 'main-model')
  assert.equal(pair.subagentModel, 'sub-model')
  assert.deepEqual(pair.models, ['main-model', 'sub-model'])

  const extra = configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,sub-model,third-model' }))
  assert.equal(extra.model, 'main-model')
  assert.equal(extra.subagentModel, 'sub-model')
  assert.deepEqual(extra.models, ['main-model', 'sub-model', 'third-model'])
})

test('OPENAI_MODEL rejects empty entries from stray or trailing commas', () => {
  assert.throws(() => configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,' })), /OPENAI_MODEL must be a comma-separated list of valid, non-empty model identifiers/)
  assert.throws(() => configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,,sub-model' })), /OPENAI_MODEL must be a comma-separated list of valid, non-empty model identifiers/)
  assert.throws(() => configuration({}, baseEnv({ OPENAI_MODEL: ' , ' })), /OPENAI_MODEL must be a comma-separated list of valid, non-empty model identifiers/)
})

test('legacy path is unchanged: AI_API_METHOD unset keeps PROVIDER_PROFILE-driven resolution, including an explicit PROVIDER_PROFILE', () => {
  const noProfile = configuration({}, baseEnv())
  assert.equal(noProfile.aiApiMethod, undefined)
  assert.equal(noProfile.profile, 'auto')
  assert.equal(noProfile.aiApiMethodOverridesProfile, false)

  const explicitProfile = configuration({}, baseEnv({ PROVIDER_PROFILE: 'deepseek' }))
  assert.equal(explicitProfile.aiApiMethod, undefined)
  assert.equal(explicitProfile.profile, 'deepseek')
  assert.equal(explicitProfile.aiApiMethodOverridesProfile, false)

  // The legacy hostname-only URL rule (providerEndpoint) is untouched: http
  // to a local hostname still passes when no method is set.
  assert.doesNotThrow(() => configuration({}, baseEnv({ OPENAI_API_BASEURL: 'http://localhost:1234/v1' })))
})

test('AI_API_METHOD wins over a conflicting PROVIDER_PROFILE and the config records the override', () => {
  const config = configuration({}, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
    PROVIDER_PROFILE: 'deepseek',
  }))
  assert.equal(config.aiApiMethod, 'router')
  assert.equal(config.profile, 'openrouter')
  assert.equal(config.aiApiMethodOverridesProfile, true)

  // An invalid legacy PROVIDER_PROFILE value never blocks startup once
  // AI_API_METHOD wins: it is not even validated.
  assert.doesNotThrow(() => configuration({}, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
    PROVIDER_PROFILE: 'not-a-real-profile',
  })))
})

test('the AI status line names the method, host, and models, and never the API key', () => {
  const config = configuration({}, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
    OPENAI_MODEL: 'anthropic/claude-opus-5.5,deepseek/deepseek-chat',
  }))
  const line = aiApiMethodLine(config)
  assert.equal(line, 'AI: method=router host=openrouter.ai main=anthropic/claude-opus-5.5 subagent=deepseek/deepseek-chat')
  assert.equal(line.includes(config.key), false)

  const soloConfig = configuration({}, baseEnv())
  const soloLine = aiApiMethodLine(soloConfig)
  assert.match(soloLine, /^AI: method=unset\(profile=auto\) host=provider\.example\.test main=main-model subagent=none$/)
  assert.equal(soloLine.includes(soloConfig.key), false)
})

test('an egg-shaped config with no method and a saved PROVIDER_PROFILE=openai-reasoning keeps openai-reasoning', () => {
  // sgluna-config.json shape: providerProfile persisted by migrateConfig on
  // an earlier run, no AI_API_METHOD anywhere (env or file).
  const savedConfig = migrateConfig({}, baseEnv({ PROVIDER_PROFILE: 'openai-reasoning' }))
  assert.equal(savedConfig.providerProfile, 'openai-reasoning')

  const effective = configuration(savedConfig, baseEnv())
  assert.equal(effective.aiApiMethod, undefined)
  assert.equal(effective.profile, 'openai-reasoning')
  assert.equal(effective.aiApiMethodOverridesProfile, false)
})

test('migrateConfig stops validating PROVIDER_PROFILE once a method is set, so a stale value on disk cannot block startup', () => {
  assert.throws(
    () => migrateConfig({}, baseEnv({ PROVIDER_PROFILE: 'not-a-real-profile' })),
    /PROVIDER_PROFILE must be auto, generic, deepseek, or openai-reasoning/,
  )
  assert.doesNotThrow(() => migrateConfig({}, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
    PROVIDER_PROFILE: 'not-a-real-profile',
  })))
})

test('a method overrides a profile saved in sgluna-config.json (not only an env PROVIDER_PROFILE) and logs it', () => {
  // Simulates an existing server: sgluna-config.json already has
  // providerProfile from before this item, and the operator now also sets
  // AI_API_METHOD without removing the old saved value or env var.
  const savedConfig = { providerProfile: 'deepseek' }
  const config = configuration(savedConfig, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
  }))
  assert.equal(config.aiApiMethod, 'router')
  assert.equal(config.profile, 'openrouter')
  assert.equal(config.aiApiMethodOverridesProfile, true)
  assert.equal(config.overriddenProviderProfile, 'deepseek')

  // An env PROVIDER_PROFILE is reported the same way, and env wins over a
  // saved value when both are present.
  const withEnvAndSaved = configuration(savedConfig, baseEnv({
    AI_API_METHOD: 'router',
    OPENAI_API_BASEURL: 'https://openrouter.ai/api/v1',
    PROVIDER_PROFILE: 'generic',
  }))
  assert.equal(withEnvAndSaved.overriddenProviderProfile, 'generic')
})

test('OPENAI_MODEL validates every entry, not only [0]: an invalid subagent model is rejected', () => {
  assert.throws(
    () => configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,not a valid model id' })),
    /OPENAI_MODEL must be a comma-separated list of valid, non-empty model identifiers/,
  )
  assert.throws(
    () => configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,sub-model,bad model#3' })),
    /OPENAI_MODEL must be a comma-separated list of valid, non-empty model identifiers/,
  )
  assert.doesNotThrow(() => configuration({}, baseEnv({ OPENAI_MODEL: 'main-model,anthropic/claude-opus-5.5' })))
})
