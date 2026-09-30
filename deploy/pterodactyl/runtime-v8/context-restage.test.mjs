import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fsp from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { STEAM_SCRIPTED_BLOCKED_ANSWER, steamReplayHarness } from './steam-run-fixtures.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_FILE = path.join(here, 'fixtures', 'context-restage', 'no-restage-steam-replay.golden.json')

const sha = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16)

// Timestamps, latencies and the random parts of generated ids are the only
// nondeterministic parts of a replay; everything else in a row must be
// byte-stable. Ids are replaced by first-seen placeholders, so a structural
// change (an id moving, appearing or vanishing) still changes the hash.
function normalizeRow(record, ids) {
  const text = JSON.stringify(record, (key, value) => {
    if (key === 'ts') return '<ts>'
    if (/(?:_ms|_at|_share|_seconds)$/.test(key) && typeof value === 'number') return 0
    return value
  })
  const placeholder = (id, label) => {
    if (!ids.has(id)) ids.set(id, `<${label}${ids.size + 1}>`)
    return ids.get(id)
  }
  return text
    .replace(/(?<![\d])1[6-9]\d{11}(?![\d])/g, '<epoch_ms>')
    .replace(/\breq_[a-z0-9]+_\d+/g, id => placeholder(id, 'req'))
    .replace(/\bgoal_[a-z0-9]{4,10}_\d+/g, id => placeholder(id, 'goal'))
    .replace(/(?<=_s\d+_)[a-z0-9]{4,10}(?![a-z0-9])/g, id => placeholder(id, 'sid'))
}

// The whole steam replay (recorded usage, 300-rule system prompt, tool results
// at their recorded sizes) through the real loop and the real provider stack.
// Captured: the exact HTTP body of every provider call, the context object the
// provider received, and every behavior-trace row.
async function steamReplayFingerprint() {
  const world = steamReplayHarness({ transport: 'http', extraRounds: [STEAM_SCRIPTED_BLOCKED_ANSWER] })
  await world.request()
  await world.closeStep1()
  await world.failSupplyBatch()
  const requestIds = new Map()
  const rows = world.trace.map(record => normalizeRow(record, requestIds))
  const calls = world.calls.map(call => ({
    body: sha(normalizeRow(call.body, requestIds)),
    context: sha(normalizeRow(call.context, requestIds)),
    messages: call.body.messages.length,
  }))
  return {
    calls,
    trace: world.trace.map((record, index) => ({ event: record.event, sha: sha(rows[index]) })),
  }
}

test('a run that never restages sends the same provider requests and writes the same trace rows', async () => {
  const actual = await steamReplayFingerprint()
  if (process.env.UPDATE_RESTAGE_GOLDEN === '1') {
    await fsp.mkdir(path.dirname(GOLDEN_FILE), { recursive: true })
    await fsp.writeFile(GOLDEN_FILE, `${JSON.stringify(actual, null, 2)}\n`)
  }
  const golden = JSON.parse(await fsp.readFile(GOLDEN_FILE, 'utf8'))
  assert.equal(actual.calls.length, golden.calls.length)
  assert.equal(actual.trace.length, golden.trace.length)
  golden.calls.forEach((expected, index) => assert.deepEqual(actual.calls[index], expected, `provider call ${index}`))
  golden.trace.forEach((expected, index) => assert.deepEqual(actual.trace[index], expected, `trace row ${index} (${expected.event})`))
})
