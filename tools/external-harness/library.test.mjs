import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { LIBRARY_COUNTS, LIBRARY_SOURCE, libraryMetadata, MAX_LIBRARY_RESULT_BYTES, readLibrary } from './library.mjs'
import { MCP_TOOLS, startMcpServer } from './mcp-server.mjs'
import { withMcpClient } from './mcp-call.mjs'
import { openRuntime } from './runtime.mjs'

const sourceUrl = new URL(`../../${LIBRARY_SOURCE}`, import.meta.url)
const pack = JSON.parse(await fs.readFile(sourceUrl))
const everyEntry = [...pack.knowledge, ...pack.skills]

test('library reads the leveled export: schema 2, asserted counts, unique valid ids, resolvable related ids', () => {
  assert.equal(pack.schema, 2)
  assert.deepEqual({ knowledge: pack.knowledge.length, skills: pack.skills.length }, LIBRARY_COUNTS)
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
    assert.match(client.initialize.result.instructions, /self-sustaining burner loops whose fuel the system delivers/)
    assert.match(client.initialize.result.instructions, /first finished-architecture checkpoint, not the first build/)
    const r = await client.request('tools/call', { name: 'factorio_library', arguments: { kind: 'skill', action: 'search', query: 'electricity' } })
    assert.equal(r.result.structuredContent.results[0].id, 'steam-power-bootstrap')
    assert.equal(r.result.isError, false)
  }, { command: process.execPath, args: ['--input-type=module', '-e', code] })
})

test('library capability metadata stays small and advertises the local typed advisory boundary', () => {
  const m = libraryMetadata()
  assert.deepEqual(m.counts, LIBRARY_COUNTS)
  assert.equal(m.source, LIBRARY_SOURCE)
  assert.equal(Object.hasOwn(m, 'donor_commit'), false)
  assert.equal(m.loading, 'on_demand')
  assert.equal(m.advisory_only, true)
  assert.ok(JSON.stringify(m).length < 500)
})
