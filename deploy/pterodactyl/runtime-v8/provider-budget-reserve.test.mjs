import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { reserveBudget } from './common.mjs'

test('hourly cap preserves one slot for exactly-once output-budget recovery without raising the cap', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-provider-budget-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'provider-budget.json')
  const now = 1000
  assert.equal(await reserveBudget(file, 3, now, { reservedSlots: 1 }), 1)
  assert.equal(await reserveBudget(file, 3, now, { reservedSlots: 1 }), 2)
  await assert.rejects(reserveBudget(file, 3, now, { reservedSlots: 1 }), /recovery reserve preserved/i)
  assert.equal(await reserveBudget(file, 3, now, { reservedSlots: 1, emergency: true }), 3)
  await assert.rejects(reserveBudget(file, 3, now, { reservedSlots: 1, emergency: true }), /including recovery reserve/i)
})

test('a one-request hourly cap remains usable instead of reserving its only slot', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-provider-budget-one-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  assert.equal(await reserveBudget(path.join(dir, 'provider-budget.json'), 1, 1000, { reservedSlots: 1 }), 1)
})

test('overlapping reservations for the final slot admit exactly one and persist its count', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-budget-final-slot-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'provider-budget.json')
  await fsp.writeFile(file, JSON.stringify({ since: 1000, count: 2 }))
  // The spelling differs while the normalized file identity remains the same.
  const alias = `${dir}${path.sep}.${path.sep}provider-budget.json`
  const results = await Promise.allSettled([
    reserveBudget(file, 3, 1000),
    reserveBudget(alias, 3, 1000),
  ])
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [3])
  assert.equal(results.filter(result => result.status === 'rejected').length, 1)
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Hourly provider request budget reached/)
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { since: 1000, count: 3 })
})

test('a concurrent burst preserves the cap and consecutive durable counts', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-budget-burst-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'provider-budget.json')
  const results = await Promise.allSettled(Array.from({ length: 32 }, () => reserveBudget(file, 7, 1000)))
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [1, 2, 3, 4, 5, 6, 7])
  assert.equal(results.filter(result => result.status === 'rejected').length, 25)
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.match(result.reason.message, /Hourly provider request budget reached/)
  }
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { since: 1000, count: 7 })
})

test('concurrent normal requests preserve recovery capacity and rollover releases a rejected queue', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-budget-recovery-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'provider-budget.json')
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => reserveBudget(file, 3, 1000, { reservedSlots: 1 })))
  assert.deepEqual(results.filter(result => result.status === 'fulfilled').map(result => result.value), [1, 2])
  for (const result of results.filter(result => result.status === 'rejected')) {
    assert.match(result.reason.message, /recovery reserve preserved/i)
  }
  assert.equal(await reserveBudget(file, 3, 1000, { reservedSlots: 1, emergency: true }), 3)
  await assert.rejects(reserveBudget(file, 3, 1000, { emergency: true }), /including recovery reserve/i)
  assert.equal(await reserveBudget(file, 3, 3601000, { reservedSlots: 1 }), 1)
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { since: 3601000, count: 1 })
})

test('a failed write does not charge the file or poison a queued reservation', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-budget-write-failure-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'provider-budget.json')
  const rename = fsp.rename
  let failOnce = true
  fsp.rename = async (source, destination) => {
    if (destination === file && failOnce) {
      failOnce = false
      throw new Error('scripted budget write failure')
    }
    return rename(source, destination)
  }
  t.after(() => { fsp.rename = rename })
  const results = await Promise.allSettled([reserveBudget(file, 1, 1000), reserveBudget(file, 1, 1000)])
  assert.equal(results[0].status, 'rejected')
  assert.match(results[0].reason.message, /scripted budget write failure/)
  assert.deepEqual(results[1], { status: 'fulfilled', value: 1 })
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')), { since: 1000, count: 1 })
})

test('an unrelated budget file is not blocked by a pending transaction', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sgluna-budget-independent-'))
  t.after(() => fsp.rm(dir, { recursive: true, force: true }))
  const pendingFile = path.join(dir, 'decision-provider-budget.json')
  const independentFile = path.join(dir, 'provider-budget.json')
  const readFile = fsp.readFile
  let release
  const hold = new Promise(resolve => { release = resolve })
  let entered
  const started = new Promise(resolve => { entered = resolve })
  fsp.readFile = async (filename, ...args) => {
    if (filename === pendingFile) { entered(); await hold }
    return readFile(filename, ...args)
  }
  t.after(() => { release(); fsp.readFile = readFile })
  const pending = reserveBudget(pendingFile, 1, 1000)
  await started
  let timer
  try {
    assert.equal(await Promise.race([
      reserveBudget(independentFile, 1, 1000),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('unrelated budget was serialized')), 2000) }),
    ]), 1)
  }
  finally { clearTimeout(timer); release(); await pending }
  assert.deepEqual(JSON.parse(await readFile(independentFile, 'utf8')), { since: 1000, count: 1 })
  assert.deepEqual(JSON.parse(await readFile(pendingFile, 'utf8')), { since: 1000, count: 1 })
})
