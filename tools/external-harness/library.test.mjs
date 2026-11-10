import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { LIBRARY_SCHEMA, LIBRARY_SOURCE, libraryMetadata, MAX_LIBRARY_RESULT_BYTES, openLibrary, readLibrary } from './library.mjs'
import { MCP_TOOLS, startMcpServer } from './mcp-server.mjs'
import { withMcpClient } from './mcp-call.mjs'
import { openRuntime } from './runtime.mjs'

const sourceUrl = new URL(`../../${LIBRARY_SOURCE}`, import.meta.url)
const pack = JSON.parse(await fs.readFile(sourceUrl))
const everyEntry = [...pack.knowledge, ...pack.skills]
const stageRecords = pack.knowledge_categories.find(category => category.id === 'stage').records
const goalRecords = pack.knowledge_categories.find(category => category.id === 'user-goal').records

test('library reads the leveled export: current schema, reported counts, unique valid ids, resolvable related ids', () => {
  assert.equal(pack.schema, LIBRARY_SCHEMA)
  assert.deepEqual(libraryMetadata().counts, { knowledge: pack.knowledge.length, skills: pack.skills.length })
  const ids = new Set(everyEntry.map(entry => entry.id))
  assert.equal(ids.size, everyEntry.length)
  for (const entry of everyEntry) {
    assert.match(entry.id, /^[a-z0-9][a-z0-9-]{0,99}$/)
    for (const id of entry.related_ids ?? entry.guidance?.related_ids ?? []) assert.ok(ids.has(id), `${entry.id} -> ${id}`)
  }
})

// Same authoring rules the built-in harness enforces on the leveled source: methods, not stored numbers.
test('authored prose holds no numbers and each knowledge reference states exactly one contrast', () => {
  for (const entry of pack.knowledge) {
    assert.equal(entry.reference.concepts.filter(text => text.startsWith('Contrast:')).length, 1, entry.id)
    const prose = JSON.stringify({ summary: entry.summary, applicability: { ...entry.applicability }, reference: entry.reference, failures: entry.known_failure_modes })
    assert.doesNotMatch(prose, /\d|\bper (?:second|minute|tick)\b/i, entry.id)
  }
  for (const entry of pack.skills) {
    const { related_ids: _related, ...guidance } = entry.guidance
    assert.doesNotMatch(JSON.stringify({ summary: entry.summary, guidance, failures: entry.known_failure_modes }), /\d|\bper (?:second|minute|tick)\b/i, entry.id)
  }
})

test('exported fixture is current with the leveled library source (exporter --check)', () => {
  const script = fileURLToPath(new URL('../../scripts/export-leveled-library.mjs', import.meta.url))
  assert.match(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }), /Checked [0-9]+ entries/)
})

test('every full guidance/source ID survives typed advisory views without executable/native verification fields', async () => {
  for (const [kind, entries] of [['knowledge', pack.knowledge], ['skill', pack.skills]]) {
    for (const entry of entries) {
      const result = await readLibrary({ kind, action: 'get', id: entry.id })
      assert.equal(result.entry.id, entry.id)
      assert.equal(result.entry.content_type, kind)
      assert.deepEqual(result.entry.source, entry.source)
      assert.deepEqual(result.entry.guidance ?? result.entry.reference, entry.guidance ?? entry.reference)
      assert.equal(result.authority.native_verified, false)
      assert.equal(result.authority.operation_authority, false)
      for (const key of ['verification', 'topology', 'parameters', 'inputs', 'outputs', 'preconditions', 'confidence']) assert.equal(Object.hasOwn(result.entry, key), false)
      assert.ok(Buffer.byteLength(JSON.stringify(result)) <= MAX_LIBRARY_RESULT_BYTES)
    }
  }
})

test('related links are generic and bidirectional', async () => {
  const sources = new Map(everyEntry.map(entry => [entry.id, new Set(entry.related_ids ?? entry.guidance?.related_ids ?? [])]))
  const kinds = new Map(pack.knowledge.map(entry => [entry.id, 'knowledge']).concat(pack.skills.map(entry => [entry.id, 'skill'])))
  for (const [id, own] of sources) {
    const expected = new Set([...own, ...[...sources].filter(([, ids]) => ids.has(id)).map(([other]) => other)])
    const result = await readLibrary({ kind: kinds.get(id), action: 'get', id })
    assert.deepEqual(new Set(result.entry.related_ids), expected, id)
    assert.equal(Object.hasOwn(result.entry, 'owner_requirements'), false)
    assert.equal(Object.hasOwn(result.authority, 'owner_requirement_id'), false)
    assert.equal(result.provenance.source, LIBRARY_SOURCE)
  }
})

test('progression checkpoints knowledge is discoverable and linked from the related methods', async () => {
  const id = 'knowledge-automation-progression-checkpoints'
  const found = await readLibrary({ kind: 'knowledge', action: 'search', query: 'fuel runs' })
  assert.equal(found.results[0].id, id)
  const entry = (await readLibrary({ kind: 'knowledge', action: 'get', id })).entry
  assert.match(JSON.stringify(entry), /next unmet checkpoint/)
  for (const related of ['burner-coal-loop', 'steam-power-bootstrap', 'skill-prove-sustainment']) {
    assert.ok(entry.related_ids.includes(related))
    assert.ok((await readLibrary({ kind: 'skill', action: 'get', id: related })).entry.related_ids.includes(id))
  }
})

// Game stages are a knowledge sub-category: ordered records, methods by id, no stored numbers.
test('stage category lists ordered game stages and each stage names existing methods', async () => {
  const listed = await readLibrary({ kind: 'knowledge', action: 'search', category: 'stage' })
  assert.deepEqual(listed.results.map(row => row.id), ['stage-manual-bootstrap', 'stage-burner-loops', 'stage-central-electricity',
    'stage-electric-mining-transfers', 'stage-smelting-arrays', 'stage-sustained-consumption', 'stage-fluid-processing',
    'stage-advanced-production', 'stage-win-condition'])
  // A category lists whole by default, within the result bound.
  assert.equal(listed.truncated, false)
  assert.deepEqual(listed.results.map(row => row.order), stageRecords.map((_, index) => index + 1))
  assert.ok(listed.results.every(row => row.category === 'stage' && row.kind === 'knowledge'))
  const ids = new Set(everyEntry.map(entry => entry.id))
  for (const stage of stageRecords) {
    assert.ok(stage.methods.every(id => ids.has(id)), stage.id)
    assert.doesNotMatch(JSON.stringify({ ...stage, methods: undefined }), /\d|\bper (?:second|minute|tick)\b/i, stage.id)
    assert.ok(!ids.has(stage.id))
  }
  const burner = (await readLibrary({ kind: 'knowledge', action: 'get', id: 'stage-burner-loops' })).entry
  assert.equal(burner.previous, 'stage-manual-bootstrap')
  assert.equal(burner.next, 'stage-central-electricity')
  assert.ok(burner.methods.some(row => row.id === 'burner-coal-loop' && row.kind === 'skill'))
  assert.match(burner.reached_when.join(' '), /no agent action/)
  const electricity = (await readLibrary({ kind: 'knowledge', action: 'search', category: 'stage', query: 'electricity', limit: 1 })).results[0]
  assert.equal(electricity.id, 'stage-central-electricity')
  assert.match(electricity.summary, /not the first build/)
  // Plain knowledge search reaches stage records too; skills never do.
  assert.ok((await readLibrary({ kind: 'knowledge', action: 'search', query: 'coal loop' })).results.some(row => row.id === 'stage-burner-loops'))
  await assert.rejects(readLibrary({ kind: 'skill', action: 'get', id: 'stage-burner-loops' }), { code: 'library_entry_not_found' })
  for (const input of [{ kind: 'skill', action: 'search', category: 'stage' }, { kind: 'knowledge', action: 'search', category: 'Era!' },
    { kind: 'knowledge', action: 'get', id: 'stage-burner-loops', category: 'stage' }, { kind: 'knowledge', action: 'search' }]) {
    await assert.rejects(readLibrary(input), { code: 'invalid_library_arguments' })
  }
  await assert.rejects(readLibrary({ kind: 'knowledge', action: 'search', category: 'era' }), { code: 'library_category_not_found' })
})

// User goals are a knowledge sub-category: what a few-word goal means, its scale from live facts, and when it is done.
test('goal category gives the meaning of common user goals with existing methods and no stored numbers', async () => {
  const listed = await readLibrary({ kind: 'knowledge', action: 'search', category: 'user-goal' })
  assert.deepEqual(listed.results.map(row => row.id), ['goal-starter-base', 'goal-automated-research', 'goal-finish-game'])
  assert.ok(listed.results.every(row => row.category === 'user-goal' && row.order === undefined))
  const ids = new Set(everyEntry.map(entry => entry.id))
  for (const goal of goalRecords) {
    for (const field of ['means', 'scale', 'done_when', 'not_counted']) assert.ok(goal[field].length > 0, `${goal.id} ${field}`)
    assert.ok(goal.methods.includes('knowledge-automatic-supply'), goal.id)
    assert.ok(goal.methods.every(id => ids.has(id)), goal.id)
    assert.doesNotMatch(JSON.stringify({ ...goal, methods: undefined }), /\d|\bper (?:second|minute|tick)\b/i, goal.id)
  }
  const starter = (await readLibrary({ kind: 'knowledge', action: 'get', id: 'goal-starter-base' })).entry
  assert.equal(starter.previous, undefined)
  assert.match(starter.scale.join(' '), /live/)
  assert.ok(starter.methods.some(row => row.id === 'skill-size-array-to-transport' && row.kind === 'skill'))
  // Plain search reaches a goal from the user's own words.
  for (const [query, id] of [['starter base', 'goal-starter-base'], ['finish the game', 'goal-finish-game'], ['launch a rocket', 'goal-finish-game'],
    ['fully automated', 'knowledge-automatic-supply'], ['hand stocked', 'knowledge-automatic-supply']]) {
    assert.ok((await readLibrary({ kind: 'knowledge', action: 'search', query })).results.some(row => row.id === id), query)
  }
  // What counts as automatic is library knowledge, and it points to the harness's own supply record.
  const automatic = (await readLibrary({ kind: 'knowledge', action: 'get', id: 'knowledge-automatic-supply' })).entry
  assert.match(automatic.applicability.live_checks.join(' '), /getActorSupplies/)
})

test('power/electricity search prioritizes power planning, not blanket owner aliases on burner methods', async () => {
  for (const query of ['power', 'electricity']) {
    const r = await readLibrary({ kind: 'skill', action: 'search', query, limit: 3 })
    assert.equal(r.results[0].id, 'steam-power-bootstrap', query)
    assert.ok(!r.results.some(row => ['burner-coal-loop', 'direct-miner-smelting'].includes(row.id)))
  }
  const bounded = await readLibrary({ kind: 'skill', action: 'search', query: 'production', limit: 1 })
  assert.equal(bounded.results.length, 1)
  assert.equal(bounded.truncated, true)
})

test('hard action/kind/query/ID/limit validation and separate namespaces fail closed', async () => {
  for (const input of [null, [], {}, { kind: 'plan', action: 'search', query: 'fuel' },
    { kind: 'skill', action: 'run', id: 'steam-power-bootstrap' },
    { kind: 'skill', action: 'search', query: '' }, { kind: 'skill', action: 'search', query: '   ' },
    { kind: 'skill', action: 'search', query: 'x'.repeat(161) }, { kind: 'skill', action: 'search', query: 'fuel\n' },
    ...[0, 9, 1.5].map(limit => ({ kind: 'skill', action: 'search', query: 'power', limit })),
    { kind: 'skill', action: 'search', query: 'power', id: 'steam-power-bootstrap' },
    { kind: 'skill', action: 'get', id: '../catalog' }, { kind: 'skill', action: 'get', id: 'steam-power-bootstrap', limit: 1 },
    { kind: 'skill', action: 'get', id: 'steam-power-bootstrap', lua: 'forbidden' }]) {
    await assert.rejects(readLibrary(input), { code: 'invalid_library_arguments' })
  }
  await assert.rejects(readLibrary({ kind: 'skill', action: 'get', id: 'knowledge-automation-progression-checkpoints' }), { code: 'library_entry_not_found' })
  await assert.rejects(readLibrary({ kind: 'knowledge', action: 'get', id: 'unknown-id' }), { code: 'library_entry_not_found' })
})

test('actual runtime library calls do not read bridge/world or modify execution journal state', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'external-library-runtime-'))
  let runtime
  t.after(async () => { try { await runtime?.close() } finally { await fs.rm(directory, { recursive: true, force: true }) } })
  const bridge = new Proxy({}, { get: (_target, key) => () => { throw new Error(`Forbidden world call ${String(key)}`) } })
  runtime = await openRuntime({ bridge, directory, session: 'library-readonly-session' })
  const before = await fs.readdir(directory)
  const lock = await fs.readFile(path.join(directory, 'owner.lock'), 'utf8')
  const r = await runtime.library({ kind: 'skill', action: 'get', id: 'steam-power-bootstrap' })
  assert.equal(r.entry.id, 'steam-power-bootstrap')
  assert.deepEqual(await fs.readdir(directory), before)
  assert.equal(await fs.readFile(path.join(directory, 'owner.lock'), 'utf8'), lock)
})

test('MCP paired streams deliver typed library content and validate enum before runtime', async t => {
  const input = new PassThrough()
  const output = new PassThrough()
  const replies = []
  let buffer = ''
  output.on('data', chunk => { buffer += chunk; while (buffer.includes('\n')) { const n = buffer.indexOf('\n'); replies.push(JSON.parse(buffer.slice(0, n))); buffer = buffer.slice(n + 1) } })
  const runtime = Object.fromEntries(['bindMachineDelivery', 'capabilities', 'context', 'observe', 'submit', 'get', 'cancel', 'resume'].map(key => [key, () => { throw new Error(`Forbidden ${key}`) }]))
  runtime.library = readLibrary
  const server = startMcpServer({ runtime, input, output, error: new PassThrough() })
  t.after(server.stop)
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'library-test', version: '1' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'factorio_library', arguments: { kind: 'knowledge', action: 'get', id: 'knowledge-automation-progression-checkpoints' } } })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'factorio_library', arguments: { kind: 'plan', action: 'get', id: 'knowledge-automation-progression-checkpoints' } } })
  for (let i = 0; i < 100 && replies.length < 3; i++) await new Promise(resolve => setImmediate(resolve))
  const r = replies.find(row => row.id === 2)
  assert.equal(r.result.structuredContent.entry.id, 'knowledge-automation-progression-checkpoints')
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent)
  assert.equal(replies.find(row => row.id === 3).error.code, -32602)
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'factorio_library').annotations.readOnlyHint, true)
})

test('actual process adapter reads the library from a fake read-only backend without RCON/providers', async () => {
  const serverUrl = new URL('./mcp-server.mjs', import.meta.url).href
  const libraryUrl = new URL('./library.mjs', import.meta.url).href
  const code = `import {startMcpServer} from ${JSON.stringify(serverUrl)}; import {readLibrary} from ${JSON.stringify(libraryUrl)};
const runtime=Object.fromEntries(['bindMachineDelivery','capabilities','context','observe','submit','get','cancel','resume'].map(key=>[key,()=>{throw new Error('world forbidden')} ]));runtime.library=readLibrary;await startMcpServer({runtime}).done;`
  await withMcpClient(async client => {
    assert.match(client.initialize.result.instructions, /before planning each new part of the goal, search factorio_library/)
    assert.match(client.initialize.result.instructions, /knowledge categories/)
    const r = await client.request('tools/call', { name: 'factorio_library', arguments: { kind: 'skill', action: 'search', query: 'electricity' } })
    assert.equal(r.result.structuredContent.results[0].id, 'steam-power-bootstrap')
    assert.equal(r.result.isError, false)
  }, { command: process.execPath, args: ['--input-type=module', '-e', code] })
})

test('library capability metadata stays small and advertises the local typed advisory boundary', () => {
  const m = libraryMetadata()
  assert.deepEqual(m.counts, { knowledge: pack.knowledge.length, skills: pack.skills.length })
  assert.deepEqual(m.knowledge_categories.map(({ id, ordered, records }) => ({ id, ordered, records })), [{ id: 'stage', ordered: true, records: stageRecords.length }, { id: 'user-goal', ordered: false, records: goalRecords.length }])
  assert.equal(m.source, LIBRARY_SOURCE)
  assert.equal(Object.hasOwn(m, 'donor_commit'), false)
  assert.equal(m.loading, 'on_demand')
  assert.equal(m.advisory_only, true)
  assert.ok(JSON.stringify(m).length < 300 + 200 * m.knowledge_categories.length)
})

// The harness core is content-agnostic: prompt and tool text name no library id or category,
// and goal acceptance (the owner's fuel bar) is not a harness prompt.
test('MCP instructions name no library entry, record, category or prototype', () => {
  const instructions = readFileSync(new URL('../../deploy/pterodactyl/runtime-v8/operator-mcp-server.mjs', import.meta.url), 'utf8').match(/instructions: '([^']*)'/)[1]
  const text = [instructions, ...MCP_TOOLS.map(tool => JSON.stringify(tool))].join('\n')
  const names = [...everyEntry.map(entry => entry.id), ...pack.knowledge_categories.flatMap(category => [category.id, ...category.records.map(record => record.id)])]
  for (const name of names) assert.doesNotMatch(text, new RegExp(`(?<![\\w-])${name}(?![\\w-])`), name)
  assert.doesNotMatch(instructions, /fuel|priming|bootstrap|owner/i)
  // Prototype names belong to the game or a mod, not the prompt.
  assert.doesNotMatch(instructions, /miner|drill|furnace|boiler|engine|belt|inserter|assembl|chest|pole/i)
})

// A different library, with other categories and record fields, loads through the same code.
test('a second library with its own categories loads unchanged; malformed packs fail closed', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sgluna-library-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const entry = (kind, id, extra = {}) => ({ content_type: kind, id, name: `Name ${id}`, summary: `Summary of ${id}`, ...extra })
  const other = { schema: LIBRARY_SCHEMA,
    knowledge: [entry('knowledge', 'rail-signals', { search_aliases: ['blocks'] })],
    skills: [entry('skill', 'lay-track', { guidance: { steps: ['Survey the corridor'], related_ids: ['rail-signals'] } }), entry('skill', 'build-station')],
    knowledge_categories: [
      { id: 'era', name: 'Eras', summary: 'Ordered eras.', ordered: true, records: [
        { id: 'era-steam', name: 'Steam era', summary: 'Before trains.', methods: ['lay-track'], entered_when: ['first locomotive runs'] },
        { id: 'era-rail', name: 'Rail era', summary: 'Trains carry ore.', methods: ['build-station', 'rail-signals'], entered_when: ['a train completes a loop'] }] },
      { id: 'glossary', name: 'Glossary', summary: 'Unordered terms.', ordered: false, records: [
        { id: 'term-block', name: 'Block', summary: 'Track between signals.', aliases: ['segment'] }] }] }
  const write = async (name, value) => { const file = path.join(directory, name); await fs.writeFile(file, JSON.stringify(value)); return file }
  const library = openLibrary({ file: await write('other.json', other), source: 'test/other.json' })
  const meta = library.metadata()
  assert.deepEqual(meta.counts, { knowledge: 1, skills: 2 })
  assert.deepEqual(meta.knowledge_categories.map(({ id, ordered, records }) => ({ id, ordered, records })),
    [{ id: 'era', ordered: true, records: 2 }, { id: 'glossary', ordered: false, records: 1 }])
  const eras = await library.read({ kind: 'knowledge', action: 'search', category: 'era' })
  assert.deepEqual(eras.results.map(row => [row.id, row.order]), [['era-steam', 1], ['era-rail', 2]])
  assert.equal(eras.provenance.source, 'test/other.json')
  const rail = (await library.read({ kind: 'knowledge', action: 'get', id: 'era-rail' })).entry
  assert.deepEqual([rail.previous, rail.next, rail.of], ['era-steam', null, 2])
  assert.deepEqual(rail.entered_when, ['a train completes a loop'])
  assert.deepEqual(rail.methods.map(row => [row.kind, row.id]), [['skill', 'build-station'], ['knowledge', 'rail-signals']])
  const term = (await library.read({ kind: 'knowledge', action: 'get', id: 'term-block' })).entry
  assert.equal(term.order, undefined)
  assert.deepEqual(term.search_aliases, ['segment'])
  assert.equal((await library.read({ kind: 'knowledge', action: 'search', query: 'segment' })).results[0].id, 'term-block')
  assert.equal((await library.read({ kind: 'knowledge', action: 'search', category: 'glossary', query: 'loop' })).total_matches, 0)
  await assert.rejects(library.read({ kind: 'knowledge', action: 'search', category: 'stage' }), { code: 'library_category_not_found' })
  // Opening another library leaves the shipped one untouched.
  assert.equal(libraryMetadata().source, LIBRARY_SOURCE)

  const [era] = other.knowledge_categories
  const withRecord = record => ({ ...other, knowledge_categories: [{ ...era, records: [{ ...era.records[0], ...record }] }] })
  const broken = [
    { ...other, schema: LIBRARY_SCHEMA - 1 },
    withRecord({ methods: ['missing-entry'] }),
    withRecord({ id: 'lay-track' }),
    withRecord({ next: ['shadows the view'] }),
    withRecord({ entered_when: 'not a list' }),
    { ...other, knowledge_categories: [era, era] },
    { ...other, knowledge_categories: [{ ...other.knowledge_categories[1], id: 'Bad Id' }] },
    { ...other, knowledge_categories: [{ ...era, records: Array.from({ length: 17 }, (_, index) => ({ ...era.records[0], id: `era-${index}` })) }] },
  ]
  for (const [index, value] of broken.entries()) {
    const bad = openLibrary({ file: await write(`broken-${index}.json`, value), source: 'test/broken.json' })
    await assert.rejects(bad.read({ kind: 'skill', action: 'search', query: 'track' }), { code: 'library_integrity_failed' }, `broken ${index}`)
  }
})
