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
