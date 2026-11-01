import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { libraryMetadata, MAX_LIBRARY_RESULT_BYTES, OWNER_REQUIREMENT_ID, readLibrary } from './library.mjs'
import { MCP_TOOLS, startMcpServer } from './mcp-server.mjs'
import { withMcpClient } from './mcp-call.mjs'
import { openRuntime } from './runtime.mjs'

const bytes = await fs.readFile(new URL('./library/jev-catalog.json', import.meta.url))
const donor = JSON.parse(bytes)
const provenance = JSON.parse(await fs.readFile(new URL('./library/provenance.json', import.meta.url), 'utf8'))

test('catalog preserves exact pinned donor bytes, Git blob, schema, six knowledge and 54 skills', () => {
  assert.equal(provenance.donor_commit, '20cdcd072b512c814c8af071f4f9ad1fe087f942')
  assert.equal(provenance.artifacts.catalog.sha256, 'dd8c6585169b6a8e9a8108db06d390bd9666625822a24a84c7b62156d7b3e861')
  assert.equal(createHash('sha256').update(bytes).digest('hex'), provenance.artifacts.catalog.sha256)
  assert.equal(createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex'), provenance.artifacts.catalog.blob)
  assert.equal(provenance.artifacts.catalog.blob, '305385246458f7fab6fa5c3796c30d92d05803a2')
  assert.equal(bytes.length, provenance.artifacts.catalog.bytes)
  assert.equal(donor.schema, 2)
  assert.equal(donor.knowledge.length, 6)
  assert.equal(donor.skills.length, 54)
})

test('every donor full guidance/source ID survives typed advisory views without executable/native verification fields', async () => {
  for (const [kind, entries] of [['knowledge', donor.knowledge], ['skill', donor.skills]]) {
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

test('owner policy is separately discoverable and relevant method views cross-reference electrical-first sustainment', async () => {
  const found = await readLibrary({ kind: 'knowledge', action: 'search', query: 'fuel individual machines' })
  assert.equal(found.results[0].id, OWNER_REQUIREMENT_ID)
  const policy = await readLibrary({ kind: 'knowledge', action: 'get', id: OWNER_REQUIREMENT_ID })
  const text = JSON.stringify(policy.entry)
  assert.match(text, /centralized/)
  assert.match(text, /separated smelting/)
  assert.match(text, /finite bootstrap/)
  assert.match(text, /automatically supplied/)
  assert.doesNotMatch(text, /currently unsupported|currently lacks|does not support electric/)
  for (const id of ['burner-coal-loop', 'burner-inserter-refueling', 'direct-miner-smelting', 'steam-power-bootstrap', 'starter-smelting-row', 'skill-prove-sustainment']) {
    const view = await readLibrary({ kind: 'skill', action: 'get', id })
    assert.ok(view.entry.related_ids.includes(OWNER_REQUIREMENT_ID))
    assert.equal(view.entry.owner_requirements[0].id, OWNER_REQUIREMENT_ID)
    assert.match(view.entry.owner_requirements[0].capability_caveat, /currently admitted/)
  }
  assert.ok(Buffer.byteLength(JSON.stringify(policy)) <= MAX_LIBRARY_RESULT_BYTES)
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
  await assert.rejects(readLibrary({ kind: 'skill', action: 'get', id: OWNER_REQUIREMENT_ID }), { code: 'library_entry_not_found' })
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
  const runtime = Object.fromEntries(['capabilities', 'context', 'observe', 'submit', 'get', 'cancel', 'resume'].map(key => [key, () => { throw new Error(`Forbidden ${key}`) }]))
  runtime.library = readLibrary
  const server = startMcpServer({ runtime, input, output, error: new PassThrough() })
  t.after(server.stop)
  const send = message => input.write(`${JSON.stringify(message)}\n`)
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'library-test', version: '1' } } })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'factorio_library', arguments: { kind: 'knowledge', action: 'get', id: OWNER_REQUIREMENT_ID } } })
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'factorio_library', arguments: { kind: 'plan', action: 'get', id: OWNER_REQUIREMENT_ID } } })
  for (let i = 0; i < 100 && replies.length < 3; i++) await new Promise(resolve => setImmediate(resolve))
  const r = replies.find(row => row.id === 2)
  assert.equal(r.result.structuredContent.entry.id, OWNER_REQUIREMENT_ID)
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent)
  assert.equal(replies.find(row => row.id === 3).error.code, -32602)
  assert.equal(MCP_TOOLS.find(tool => tool.name === 'factorio_library').annotations.readOnlyHint, true)
})

test('actual process adapter reads the library from a fake read-only backend without RCON/providers', async () => {
  const serverUrl = new URL('./mcp-server.mjs', import.meta.url).href
  const libraryUrl = new URL('./library.mjs', import.meta.url).href
  const code = `import {startMcpServer} from ${JSON.stringify(serverUrl)}; import {readLibrary} from ${JSON.stringify(libraryUrl)};
const runtime=Object.fromEntries(['capabilities','context','observe','submit','get','cancel','resume'].map(key=>[key,()=>{throw new Error('world forbidden')} ]));runtime.library=readLibrary;await startMcpServer({runtime}).done;`
  await withMcpClient(async client => {
    assert.match(client.initialize.result.instructions, /electricity FIRST/)
    const r = await client.request('tools/call', { name: 'factorio_library', arguments: { kind: 'skill', action: 'search', query: 'electricity' } })
    assert.equal(r.result.structuredContent.results[0].id, 'steam-power-bootstrap')
    assert.equal(r.result.isError, false)
  }, { command: process.execPath, args: ['--input-type=module', '-e', code] })
})

test('library capability metadata stays small and advertises the local typed advisory boundary', () => {
  const m = libraryMetadata()
  assert.deepEqual(m.counts, { knowledge: 7, skills: 54 })
  assert.equal(m.loading, 'on_demand')
  assert.equal(m.advisory_only, true)
  assert.ok(JSON.stringify(m).length < 500)
})
