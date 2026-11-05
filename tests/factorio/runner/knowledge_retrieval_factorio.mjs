#!/usr/bin/env node
// Exact-version isolated native library/profile/save proof. Parent owns server,
// save/reload and teardown. No providers, operation submission or gameplay.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i < 0) { assert.notEqual(fallback, undefined, `missing --${name}`); return fallback } return process.argv[i + 1] }
const repo = path.resolve(arg('repo'))
const results = path.resolve(arg('results'))
const phase = arg('phase')
assert.ok(['prepare', 'reload'].includes(phase))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon, confirmLuaConsoleReady } = await load('runtime-v8/common.mjs')
const { luaString, toolCommand } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const pack = JSON.parse(await fs.readFile(path.join(repo, 'packages/autorio/src/fixtures/leveled-library-v1.json'), 'utf8'))
const referenceId = pack.knowledge[0].id
const transcript = []
const events = []
const evidence = { phase, status: 'failed', providers: 0, operations_submitted: 0 }
let connection
const rcon = { command: async command => { assert.ok(!command.includes('"submit"'), 'No native operation submission permitted'); const response = await connection.command(command); transcript.push({ command, response }); return response } }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const read = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const profile = async name => { const value = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_skills","select_curated_library",${luaString(name)})))`); assert.equal(value.ok, true); return value }
// Console storage is scenario-local unless the exact mod scope is selected.
const snapshot = () => lua('__autorio__ assert(script.mod_name=="autorio","wrong snapshot mod scope");assert(type(storage.sgluna_skill_definitions)=="table","library definitions are uninitialized");assert(storage.sgluna_curated_library_profile=="basic" or storage.sgluna_curated_library_profile=="leveled","library profile is uninitialized");rcon.print(helpers.table_to_json({profile=storage.sgluna_curated_library_profile,definitions=storage.sgluna_skill_definitions,exports=storage.sgluna_skill_exports,preserved=storage.sgluna_preserved_curated_variants}))')
const list = () => lua('rcon.print(helpers.table_to_json(remote.call("autorio_skills","list")))')
async function assertViews() {
  const refs = await read('findKnowledge', { query: 'capabilities freshness dependencies acquisition', limit: 10 })
  assert.equal(refs.ok, true); assert.ok(refs.results.length > 0)
  assert.ok(refs.results.every(row => row.content_type === 'knowledge' && row.verification === undefined))
  for (const entry of pack.knowledge) {
    const found = await read('getKnowledgeDetails', { id: entry.id })
    assert.equal(found.id, entry.id); assert.equal(found.content_type, 'knowledge')
    for (const key of ['verification', 'stage', 'status', 'topology', 'operations']) assert.equal(found[key], undefined)
    const excluded = await lua(`rcon.print(helpers.table_to_json({missing=remote.call("autorio_skills","get",${luaString(entry.id)})==nil}))`)
    assert.equal(excluded.missing, true)
  }
  const procedures = await list()
  assert.ok(procedures.every(row => row.content_type !== 'knowledge'))
  const offer = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_skills","offer",{goal="capabilities freshness dependencies acquisition",limit=10})))')
  assert.equal(offer.ok, true)
  assert.ok(!Array.isArray(offer.cards) || offer.cards.every(row => row.content_type !== 'knowledge'))
  const search = await read('findSkills', { query: 'capabilities freshness dependencies acquisition', limit: 10 })
  assert.equal(search.ok, true)
  assert.ok(!Array.isArray(search.results) || search.results.every(row => row.content_type !== 'knowledge'))
  return { references: refs, procedural_count: procedures.length, offer, search }
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password', 'offline-fixture-only'), 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect()
  assert.match(await rcon.command('/version'), /2\.0\.77/)
  evidence.lua_handshake = await confirmLuaConsoleReady(rcon)
  await lua('assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;rcon.print("{}")')
  if (phase === 'prepare') {
    await configureNpcSession(rcon, 'knowledge-native-20261031')
    await profile('leveled')
    evidence.catalog = await assertViews()
    assert.equal(evidence.catalog.procedural_count, 54)
    const saved = await snapshot()
    assert.equal(Object.values(saved.definitions).filter(entry => entry.content_type === 'knowledge').length, 7)
    const imported = { ...pack.knowledge[0], id: 'personal-reference', name: 'Owner reference survives profiles', source: { kind: 'manual', entity_unit_numbers: [], recipe_ids: [], evidence_refs: ['owner:knowledge-native-fixture'] } }
    const importedSkill = { ...pack.skills[0], id: 'personal-procedure', name: 'Owner procedure survives profiles', source: { kind: 'manual', entity_unit_numbers: [], recipe_ids: [], evidence_refs: ['owner:knowledge-native-fixture'] } }
    for (const entry of [imported, importedSkill]) {
      const result = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_skills","put_definition",helpers.json_to_table(${luaString(JSON.stringify(entry))}))))`)
      assert.equal(result[0], true)
    }
    const original = (await snapshot()).definitions
    await profile('basic')
    const basic = await snapshot()
    assert.deepEqual(basic.definitions['personal-reference'], original['personal-reference'])
    assert.deepEqual(basic.definitions['personal-procedure'], original['personal-procedure'])
    assert.ok(!Object.hasOwn(basic.definitions, referenceId))
    assert.equal((await read('getKnowledgeDetails', { id: 'personal-reference' })).id, 'personal-reference')
    await profile('leveled')
    const restored = await snapshot()
    assert.deepEqual(restored.definitions['personal-reference'], original['personal-reference'])
    assert.deepEqual(restored.definitions['personal-procedure'], original['personal-procedure'])
    evidence.export = await lua('rcon.print(helpers.table_to_json(remote.call("autorio_skills","export","personal-reference")))')
    assert.equal(evidence.export[0], true)
    assert.match(evidence.export[1], /sgluna-knowledge\/personal-reference/)
    await fs.writeFile(path.join(results, 'expected.json'), JSON.stringify(await snapshot(), null, 2))
  }
  else {
    const expected = JSON.parse(await fs.readFile(path.join(results, 'expected.json'), 'utf8'))
    assert.deepEqual(await snapshot(), expected, 'native save/reload preserves exact library, imports and export history')
    evidence.catalog = await assertViews()
    assert.equal(evidence.catalog.procedural_count, 55)
    assert.equal((await read('getKnowledgeDetails', { id: 'personal-reference' })).id, 'personal-reference')
    evidence.saved_identity_equal = true
  }
  const actor = await deploymentStatus(rcon, { requireAllowed: true })
  const before = await snapshot()
  for (const role of ['planner', 'executor']) {
    const agent = new NpcAgentLoop({ rcon, provider: async () => { evidence.providers++; throw new Error('Inference forbidden') }, completionProtocolVersion: 3,
      stateFile: null, traceFile: null, decisionTraceFile: null, onActivity: (event, data) => events.push({ event, data }) })
    Object.assign(agent, { active: true, epoch: actor, traceRequest: { id: `native-${phase}-${role}`, usage: { tool_calls: 0, tool_result_chars: 0, duplicate_tool_calls: 0 } } })
    agent.agentContext.beginLineage(role)
    const tool_calls = [{ id: `${role}-reference`, type: 'function', function: { name: 'getKnowledgeDetails', arguments: JSON.stringify({ id: referenceId }) } }]
    await agent.handleToolBatch({ content: null, tool_calls })
    assert.equal(agent.loadedSkillContext.size, 0); assert.equal(agent.skillContext(), '')
    const messages = agent.providerMessages()
    assert.ok(messages.some(row => row.role === 'tool' && JSON.parse(row.content).content_type === 'knowledge'))
    assert.ok(messages.every(row => row.role === 'tool' || !row.content?.includes(pack.knowledge[0].summary)))
    assert.equal(agent.recordLoadedSkillToolResult('getSkillDetails', { id: referenceId }, pack.knowledge[0]), false)
  }
  assert.deepEqual(await snapshot(), before, 'explicit reads never mutate persistent library state')
  assert.equal(evidence.providers, 0)
  evidence.status = 'passed'
}
catch (error) { evidence.error = error.stack ?? String(error); process.exitCode = 1 }
finally {
  if (connection) {
    try { evidence.final = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))') } catch (error) { evidence.status = 'failed'; evidence.final_error = String(error); process.exitCode = 1 }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, `${phase}.json`), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, `${phase}-transcript.json`), JSON.stringify(transcript, null, 2))
  await fs.writeFile(path.join(results, `${phase}-events.json`), JSON.stringify(events, null, 2))
}
console.log(JSON.stringify({ phase, status: evidence.status, providers: evidence.providers, results }))
