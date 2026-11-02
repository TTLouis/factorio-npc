#!/usr/bin/env node
// Offline exact-native proof. Parent owns isolated servers, save/reload, cold
// save creation and cleanup. This driver never starts a provider or submits an
// operation. Host notebook state is copied byte-for-byte for each replay lane.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); if (i < 0) { assert.notEqual(fallback, undefined, `missing --${name}`); return fallback } return process.argv[i + 1] }
const repo = path.resolve(arg('repo'))
const results = path.resolve(arg('results'))
const phase = arg('phase')
assert.ok(['prepare', 'reload', 'cold'].includes(phase))
const load = name => import(pathToFileURL(path.join(repo, 'deploy/pterodactyl', name)).href)
const { Rcon, confirmLuaConsoleReady } = await load('runtime-v8/common.mjs')
const { luaString, toolCommand } = await load('runtime-v8/structured-policy.mjs')
const { configureNpcSession, deploymentStatus } = await load('staging/supervisor-adapter.mjs')
const { NpcAgentLoop } = await load('runtime-v8/npc-agent-loop.mjs')
const { CanonicalTaskBoardMemory } = await load('runtime-v8/canonical-task-board-memory.mjs')
const pack = JSON.parse(await fs.readFile(path.join(repo, 'packages/autorio/src/fixtures/leveled-library-v1.json'), 'utf8'))
const transcript = []
const events = []
const evidence = { phase, status: 'failed', providers: 0, operations: 0, notes: [] }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const preparedFile = path.join(results, 'notebook-prepared-state.json')
const stateFile = path.join(results, `notebook-${phase}-state.json`)
const expectedFile = path.join(results, 'notebook-expected.json')
const goalText = 'NATIVE-GOAL-NOTE: historical lookup belongs to notebook-goal-a; refresh actual machine evidence before action.'
const persistentText = 'NATIVE-PERSISTENT-NOTE: distinguish a stalled symptom from its cause; consult the machine-state reference and fresh live evidence.'
let connection, actor
const rcon = { command: async command => {
  assert.ok(!command.includes('"submit"') && !command.includes("'submit'"), 'No native operation submission permitted')
  const response = await connection.command(command); transcript.push({ command, response }); return response
} }
const lua = async body => JSON.parse(await rcon.command(`/silent-command ${body}`))
const readNative = async (name, args) => JSON.parse(await rcon.command(toolCommand(name, args)))
const worldIdentity = () => lua('rcon.print(helpers.table_to_json(remote.call("sgluna_factory","world_identity")))')
const librarySnapshot = () => lua('__autorio__ assert(script.mod_name=="autorio");assert(type(storage.sgluna_skill_definitions)=="table");assert(storage.sgluna_curated_library_profile=="leveled" or storage.sgluna_curated_library_profile=="basic");rcon.print(helpers.table_to_json({profile=storage.sgluna_curated_library_profile,definitions=storage.sgluna_skill_definitions,preserved=storage.sgluna_preserved_curated_variants,exports=storage.sgluna_skill_exports}))')
const profile = async name => { const out = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_skills","select_curated_library",${luaString(name)})))`); assert.equal(out.ok, true) }
const invoke = async (agent, name, args, id = `${phase}-${agent.agentContext.role}-${name}-${evidence.notes.length}`) => {
  await agent.handleToolBatch({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
  const out = JSON.parse(agent.messages.findLast(row => row.role === 'tool' && row.tool_call_id === id).content)
  assert.equal(out.ok, true)
  evidence.notes.push({ role: agent.agentContext.role, tool: name, args, output: out })
  assert.equal(agent.loadedSkillContext.size, 0); assert.equal(agent.skillContext(), '')
  assert.equal(agent.freshObservationSinceContinuation, false)
  for (const row of agent.providerMessages()) if (row.content?.includes('NATIVE-GOAL-NOTE') || row.content?.includes('NATIVE-PERSISTENT-NOTE')) assert.equal(row.role, 'tool')
  return out
}
const makeAgent = async role => {
  const memory = new CanonicalTaskBoardMemory()
  const agent = new NpcAgentLoop({ rcon, memory, npcId: 'notebook-native', provider: async () => { evidence.providers++; throw new Error('Providers forbidden') },
    completionProtocolVersion: 3, stateFile, traceFile: null, decisionTraceFile: null, onActivity: (event, data) => events.push({ event, data }) })
  await agent.loadPersistentState()
  Object.assign(agent, { active: true, epoch: actor, traceRequest: { id: `${phase}-${role}-explicit-notes`, usage: { tool_calls: 0, tool_result_chars: 0, duplicate_tool_calls: 0 } } })
  agent.agentContext.beginLineage(role)
  assert.ok(!JSON.stringify(agent.providerMessages()).includes('NATIVE-GOAL-NOTE'), 'Restart does not autoload notes')
  assert.ok(!JSON.stringify(agent.providerMessages()).includes('NATIVE-PERSISTENT-NOTE'), 'Persistent scope is explicit too')
  return agent
}
try {
  await fs.mkdir(results, { recursive: true })
  connection = new Rcon(Number(arg('port')), arg('password', 'offline-fixture-only'), 15000, { host: arg('host', '127.0.0.1') })
  await connection.connect()
  assert.match(await rcon.command('/version'), /2\.0\.77/)
  evidence.lua_handshake = await confirmLuaConsoleReady(rcon)
  await lua('assert(#game.connected_players==0);game.speed=1;game.tick_paused=true;rcon.print("{}")')
  if (phase !== 'reload') await configureNpcSession(rcon, `notebook-native-${phase}-20261031`)
  actor = await deploymentStatus(rcon, { requireAllowed: true })
  if (phase === 'prepare') {
    await assert.rejects(fs.access(preparedFile), 'Prepare must not overwrite prior evidence')
    await profile('leveled')
    const original = await librarySnapshot()
    assert.equal(Object.values(original.definitions).filter(row => row.content_type === 'knowledge').length, 6)
    assert.equal(Object.values(original.definitions).filter(row => row.content_type === 'skill').length, 54)
    evidence.search = []
    for (const [query, expected] of [
      ['The furnace is not making plates', 'knowledge-machine-state'],
      ['These two buildings are next to each other but nothing transfers', 'knowledge-connection-geometry'],
      ['This machine exists but can I actually use it here?', 'knowledge-available-capabilities'],
    ]) {
      const response = await readNative('findKnowledge', { query, limit: 3 })
      assert.ok(response.results.some(row => row.id === expected)); evidence.search.push({ query, expected, response })
    }
    const negative = await readNative('findKnowledge', { query: 'banana poetry telescope', limit: 3 })
    assert.ok(Array.isArray(negative.results) ? negative.results.length === 0 : Object.keys(negative.results).length === 0)
    for (const entry of pack.knowledge) {
      const found = await readNative('getKnowledgeDetails', { id: entry.id })
      assert.equal(found.revision, 2); assert.deepEqual(found.search_aliases, entry.search_aliases)
    }
    const imported = { ...pack.knowledge[0], id: 'notebook-personal-reference', summary: 'Personal reference retained across profiles and reload.', search_aliases: ['owner reference pointer'] }
    const result = await lua(`rcon.print(helpers.table_to_json(remote.call("autorio_skills","put_definition",helpers.json_to_table(${luaString(JSON.stringify(imported))}))))`)
    assert.equal(result[0], true)
    const personal = (await librarySnapshot()).definitions[imported.id]
    await profile('basic'); assert.deepEqual((await librarySnapshot()).definitions[imported.id], personal)
    await profile('leveled'); assert.deepEqual((await librarySnapshot()).definitions[imported.id], personal)
    assert.deepEqual((await readNative('getKnowledgeDetails', { id: imported.id })).search_aliases, imported.search_aliases)
    const planner = await makeAgent('planner')
    planner.memory.admitPlanningGoal('npc:notebook-native', { objective: 'Initial notebook proof goal', goalId: 'notebook-goal-a', owner: 'offline-fixture' })
    assert.equal((await invoke(planner, 'readNotebook', { scope: 'goal' })).text, '')
    assert.equal((await invoke(planner, 'updateNotebook', { scope: 'goal', expectedRevision: 0, text: goalText })).durable, true)
    assert.equal((await invoke(planner, 'updateNotebook', { scope: 'persistent', expectedRevision: 0, text: persistentText })).durable, true)
    const executor = await makeAgent('executor')
    assert.equal((await invoke(executor, 'readNotebook', { scope: 'goal' })).text, goalText)
    assert.equal((await invoke(executor, 'readNotebook', { scope: 'persistent' })).text, persistentText)
    assert.equal((await invoke(executor, 'updateNotebook', { scope: 'goal', expectedRevision: 1, text: goalText })).revision, 2)
    const identity = await worldIdentity(); assert.equal(identity.ok, true); assert.ok(identity.world_id)
    await fs.copyFile(stateFile, preparedFile)
    const bytes = await fs.readFile(preparedFile)
    assert.equal(hash(bytes), hash(await fs.readFile(stateFile)))
    await fs.writeFile(expectedFile, JSON.stringify({ world_id: identity.world_id, goal_id: 'notebook-goal-a', goalText, persistentText,
      host_state_sha256: hash(bytes), native_library: await librarySnapshot() }, null, 2))
    evidence.world_id = identity.world_id; evidence.host_state_sha256 = hash(bytes)
  }
  else {
    const expected = JSON.parse(await fs.readFile(expectedFile, 'utf8'))
    const original = await fs.readFile(preparedFile)
    assert.equal(hash(original), expected.host_state_sha256)
    await fs.copyFile(preparedFile, stateFile)
    assert.equal(hash(await fs.readFile(stateFile)), expected.host_state_sha256)
    evidence.host_copy_verified_before_load = true
    if (phase === 'reload') {
      assert.deepEqual(await librarySnapshot(), expected.native_library)
      assert.equal((await worldIdentity()).world_id, expected.world_id)
    }
    for (const role of ['planner', 'executor']) {
      const agent = await makeAgent(role)
      assert.equal(agent.memory.planningState('npc:notebook-native').goal.goal_id, expected.goal_id)
      const goal = await invoke(agent, 'readNotebook', { scope: 'goal' })
      const persistent = await invoke(agent, 'readNotebook', { scope: 'persistent' })
      if (phase === 'cold') {
        assert.notEqual(goal.world_id, expected.world_id)
        assert.equal(goal.text, ''); assert.equal(goal.revision, 0)
        assert.equal(persistent.text, ''); assert.equal(persistent.revision, 0)
      }
      else {
        assert.equal(goal.text, goalText); assert.equal(goal.revision, 2)
        assert.equal(persistent.text, persistentText); assert.equal(persistent.revision, 1)
      }
      assert.equal(hash(await fs.readFile(stateFile)), expected.host_state_sha256, 'Explicit reads do not rewrite the copied host state')
    }
    if (phase === 'reload') {
      const agent = await makeAgent('planner')
      agent.memory.admitPlanningGoal('npc:notebook-native', { objective: 'A different notebook proof goal', goalId: 'notebook-goal-b', owner: 'offline-fixture' })
      assert.equal(agent.memory.planningState('npc:notebook-native').goal.goal_id, 'notebook-goal-b')
      assert.equal((await invoke(agent, 'readNotebook', { scope: 'goal' })).text, '')
      assert.equal((await invoke(agent, 'readNotebook', { scope: 'persistent' })).text, persistentText)
      await invoke(agent, 'updateNotebook', { scope: 'goal', expectedRevision: 0, text: 'Second goal notes, isolated from the prior goal.' })
      const again = await makeAgent('executor')
      assert.equal((await invoke(again, 'readNotebook', { scope: 'goal' })).text, 'Second goal notes, isolated from the prior goal.')
      assert.equal((await invoke(again, 'readNotebook', { scope: 'persistent' })).text, persistentText)
      assert.equal((await worldIdentity()).world_id, expected.world_id)
    }
    evidence.world_id = (await worldIdentity()).world_id
    assert.equal(hash(await fs.readFile(preparedFile)), expected.host_state_sha256, 'Original prepared host state remains sealed')
  }
  assert.equal(evidence.providers, 0)
  evidence.status = 'passed'
}
catch (error) { evidence.status = 'failed'; evidence.error = error.stack ?? String(error); process.exitCode = 1 }
finally {
  if (connection) {
    try {
      evidence.final = await lua('game.speed=1;game.tick_paused=true;rcon.print(helpers.table_to_json({tick=game.tick,paused=game.tick_paused,speed=game.speed,humans=#game.connected_players}))')
      const status = await deploymentStatus(rcon, { requireAllowed: true }); assert.equal(status.idle, true)
      evidence.final.native_idle = status.idle
    }
    catch (error) { evidence.status = 'failed'; evidence.final_error = String(error); process.exitCode = 1 }
    connection.close()
  }
  await fs.mkdir(results, { recursive: true })
  await fs.writeFile(path.join(results, `${phase}.json`), JSON.stringify(evidence, null, 2))
  await fs.writeFile(path.join(results, `${phase}-transcript.json`), JSON.stringify(transcript, null, 2))
  await fs.writeFile(path.join(results, `${phase}-events.json`), JSON.stringify(events, null, 2))
}
console.log(JSON.stringify({ phase, status: evidence.status, providers: evidence.providers, results }))
