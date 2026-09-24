import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildArtifacts, channelInstaller, installerLoader, verifyGeneratedArtifacts } from './build-payload.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const PAYLOAD_REF = '559dde17a93a59eeaa302ee480aad9387697fd53'
const PAYLOAD_SHA256 = 'b054b465fb7fedddee739fb9d100090027a002731cd80635e00cc24a0b4a140a'
const source = Buffer.from(`#!/usr/bin/env bash
AIRI_REF="0123456789abcdef0123456789abcdef01234567"
REVISION="test"
DEPLOYMENT_REVISION="airi-deploy-v8-test"
SGLUNA_ACTOR_MODE="\${SGLUNA_ACTOR_MODE:-npc}"
SGLUNA_CHAT_PLAYERS="\${SGLUNA_CHAT_PLAYERS:-}"
AIRI_ACTOR_MODE="\${AIRI_ACTOR_MODE:-$SGLUNA_ACTOR_MODE}"
AIRI_CHAT_PLAYER="\${AIRI_CHAT_PLAYER:-}"
echo "$DEPLOYMENT_REVISION $SGLUNA_ACTOR_MODE $SGLUNA_CHAT_PLAYERS $AIRI_ACTOR_MODE $AIRI_CHAT_PLAYER"
`)

test('immutable bootstrap loader remains checksummed and pinned', () => {
  const canonical = buildArtifacts(source)
  assert.equal(canonical.installScript, installerLoader(source))
  assert.match(canonical.installScript, new RegExp(PAYLOAD_REF))
  assert.match(canonical.installScript, /payload-src\/installer\.sh/)
  assert.match(canonical.installScript, /EXPECTED_SOURCE_SHA256="[a-f0-9]{64}"/)
})

test('main and NPC E2E eggs resolve different default source refs on reinstall', () => {
  const canonical = buildArtifacts(source)
  const mainEgg = JSON.parse(canonical.mainEggJson)
  const e2eEgg = JSON.parse(canonical.e2eEggJson)

  assert.equal(mainEgg.name, 'SGLuna Factorio Server (Main)')
  assert.equal(e2eEgg.name, 'SGLuna Factorio Server (NPC E2E / Jev Experiment)')
  assert.equal(mainEgg.config.startup, '{"done": "SGLuna Factorio ready"}')
  assert.equal(mainEgg.variables.find(entry => entry.env_variable === 'SGLUNA_SOURCE_REF')?.name, 'SGLuna Source Ref')
  assert.equal(mainEgg.variables.find(entry => entry.env_variable === 'SGLUNA_ACTOR_MODE')?.name, 'SGLuna Actor Mode')
  assert.equal(mainEgg.variables.find(entry => entry.env_variable === 'SGLUNA_CHAT_PLAYERS')?.name, 'SGLuna Chat Players')
  assert.equal(mainEgg.variables.find(entry => entry.env_variable === 'SGLUNA_SOURCE_REF')?.default_value, 'main')
  assert.equal(e2eEgg.variables.find(entry => entry.env_variable === 'SGLUNA_SOURCE_REF')?.default_value, 'experiment/jev-agent-architecture')
  assert.notEqual(mainEgg.scripts.installation.script, e2eEgg.scripts.installation.script)
  assert.match(mainEgg.scripts.installation.script, /CHANNEL="main"/)
  assert.match(e2eEgg.scripts.installation.script, /CHANNEL="npc-e2e"/)
})

test('channel installer resolves to an exact SHA and loads deployment payload from that same commit', () => {
  const script = channelInstaller(source, 'npcE2e')
  assert.match(script, /api\.github\.com\/repos\/TTLouis\/factorio-npc\/commits/)
  assert.match(script, /raw\.githubusercontent\.com\/TTLouis\/factorio-npc\/\$RESOLVED_SHA\/deploy\/pterodactyl\/payload-src\/installer\.sh/)
  assert.match(script, /RESOLVED_SHA/)
  assert.match(script, /Unexpected AIRI_REF assignment contract/)
  assert.match(script, /Unexpected REVISION assignment contract/)
  assert.match(script, /AIRI_REF=.*RESOLVED_SHA/)
  assert.match(script, /REVISION=.*CHANNEL.*SHORT_SHA/)
  assert.doesNotMatch(script, /PAYLOAD_REF/)
  assert.doesNotMatch(script, /EXPECTED_PAYLOAD_SHA256/)
  assert.doesNotMatch(script, /codeload\.github\.com\/TTLouis\/factorio-npc\/tar\.gz\/\$SOURCE_REF/)
})

test('generated egg variable contract keeps safe provider defaults and 300 request budget', () => {
  const { mainEggJson, e2eEggJson } = buildArtifacts(source)
  for (const text of [mainEggJson, e2eEggJson]) {
    const egg = JSON.parse(text)
    assert.equal(egg.meta.version, 'PTDL_v2')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'OPENAI_MODEL')?.default_value, 'replace-me')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'OPENAI_API_BASEURL')?.default_value, 'https://provider.invalid/v1')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'PROVIDER_PROFILE')?.default_value, 'auto')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'PROVIDER_TIMEOUT_MS')?.default_value, '120000')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'MAX_PROVIDER_REQUESTS_PER_HOUR')?.default_value, '300')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'MAX_PROVIDER_OUTPUT_TOKENS_PER_TURN')?.default_value, '20000')
    assert.equal(egg.variables.find(entry => entry.env_variable === 'SGLUNA_CHAT_PLAYERS')?.default_value, 'none')
    assert.match(egg.variables.find(entry => entry.env_variable === 'SGLUNA_CHAT_PLAYERS')?.description ?? '', /Default none disables/)
    assert.ok(egg.variables.some(entry => entry.env_variable === 'SGLUNA_SOURCE_REF'))
    assert.ok(egg.variables.some(entry => entry.env_variable === 'SGLUNA_ACTOR_MODE'))
    assert.ok(egg.variables.some(entry => entry.env_variable === 'SGLUNA_CHAT_PLAYERS'))
    assert.ok(!egg.variables.some(entry => entry.env_variable === 'PRIVATE_SERVER'))
    assert.ok(!egg.variables.some(entry => entry.env_variable.startsWith('AIRI_')))
    assert.ok(!egg.variables.some(entry => entry.env_variable === 'AIRI_PLAYER'))
    assert.ok(!egg.variables.some(entry => entry.env_variable === 'AIRI_CHAT_PLAYER'))
  }
})

test('Jev credentials and conservation controls exist only on the NPC E2E experiment egg', () => {
  const { mainEggJson, e2eEggJson } = buildArtifacts(source)
  const mainEgg = JSON.parse(mainEggJson)
  const e2eEgg = JSON.parse(e2eEggJson)

  assert.equal(mainEgg.variables.some(entry => entry.env_variable === 'TYPESAFE_API_KEY'), false)
  assert.equal(mainEgg.variables.some(entry => entry.env_variable === 'DECISION_PROVIDER_MODEL'), false)
  assert.equal(mainEgg.variables.some(entry => entry.env_variable === 'MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR'), false)

  const key = e2eEgg.variables.find(entry => entry.env_variable === 'TYPESAFE_API_KEY')
  assert.equal(key?.default_value, '')
  assert.equal(key?.user_viewable, false)
  assert.match(key?.description ?? '', /Leave blank to disable the decision lane/)

  assert.equal(e2eEgg.variables.find(entry => entry.env_variable === 'DECISION_PROVIDER_MODEL')?.default_value, 'jev-latest')
  assert.equal(e2eEgg.variables.find(entry => entry.env_variable === 'MAX_DECISION_PROVIDER_REQUESTS_PER_HOUR')?.default_value, '600')
})

test('generated artifact verifier rejects source or channel drift', () => {
  const canonical = buildArtifacts(source)
  assert.equal(
    verifyGeneratedArtifacts(source, canonical.installScript, canonical.mainEggJson, canonical.e2eEggJson),
    true,
  )
  const changedSource = Buffer.concat([source, Buffer.from('# changed\n')])
  assert.throws(
    () => verifyGeneratedArtifacts(changedSource, canonical.installScript, canonical.mainEggJson, canonical.e2eEggJson),
    /install\.sh loader is stale|egg schema is stale/,
  )
  const changedE2e = canonical.e2eEggJson.replace('experiment/jev-agent-architecture', 'main')
  assert.throws(
    () => verifyGeneratedArtifacts(source, canonical.installScript, canonical.mainEggJson, changedE2e),
    /npcE2e egg schema is stale|wrong source ref/,
  )
})

test('committed Pterodactyl artifacts are internally valid and reinstall stays deployment-only', () => {
  const committedSource = readFileSync(join(here, 'payload-src', 'installer.sh'))
  const committedInstall = readFileSync(join(here, 'install.sh'), 'utf8')
  const committedMainEgg = readFileSync(join(here, 'egg-sgluna-factorio-server.json'), 'utf8')
  const committedE2eEgg = readFileSync(join(here, 'egg-sgluna-factorio-npc-e2e.json'), 'utf8')
  assert.equal(existsSync(join(here, 'egg-airi-factorio-server.json')), false)
  assert.equal(existsSync(join(here, 'egg-airi-factorio-npc-e2e.json')), false)
  const sourceText = committedSource.toString('utf8')

  assert.equal(verifyGeneratedArtifacts(committedSource, committedInstall, committedMainEgg, committedE2eEgg), true)
  assert.match(committedInstall, new RegExp(PAYLOAD_REF))
  assert.match(committedInstall, new RegExp(`EXPECTED_SOURCE_SHA256="${PAYLOAD_SHA256}"`))
  assert.doesNotMatch(sourceText, /node --test deploy\/pterodactyl\/staging/)
  assert.doesNotMatch(sourceText, /pnpm --filter autorio\.ts run test/)
  assert.match(sourceText, /pnpm --filter autorio\.ts run typecheck/)
  assert.match(sourceText, /pnpm --filter autorio\.ts run build/)
  assert.match(sourceText, /packages\/autorio\/dist\/data\.lua/)
  assert.match(sourceText, /canonical-task-board-memory\.mjs/)
  assert.match(sourceText, /provider-base\.mjs/)
  assert.doesNotMatch(sourceText, /project-board\.mjs/)
  assert.match(sourceText, /jev-decision-taxonomy\.mjs/)
  assert.match(sourceText, /jev-typed-projection\.mjs/)
  assert.match(sourceText, /jev-health\.mjs/)
  assert.match(sourceText, /goal-definition\.mjs/)
  assert.match(sourceText, /AIRI_SUPERVISOR_VERIFY=/)
  assert.match(sourceText, /await import\(pathToFileURL\(process\.env\.AIRI_SUPERVISOR_VERIFY\)\.href\)/)
  assert.match(sourceText, /src\/runtime-v8\/canonical-task-board-memory\.mjs/)
  assert.match(sourceText, /src\/runtime-v8\/provider-base\.mjs/)
  assert.match(sourceText, /README-SGLUNA\.txt/)
  assert.match(sourceText, /SGLUNA_ACTOR_MODE/)
  assert.match(sourceText, /SGLUNA_CHAT_PLAYERS/)
  assert.match(sourceText, /AIRI_ACTOR_MODE/)
  assert.match(sourceText, /AIRI_CHAT_PLAYERS/)
  assert.doesNotMatch(sourceText, /TTLouis\/airi-factorio/)
  assert.doesNotMatch(committedInstall, /TTLouis\/airi-factorio/)
  assert.doesNotMatch(committedMainEgg, /TTLouis\/airi-factorio/)
  assert.doesNotMatch(committedE2eEgg, /TTLouis\/airi-factorio/)
})
