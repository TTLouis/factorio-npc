import test from 'node:test'
import assert from 'node:assert/strict'

import { executeAuthorizedBatch, OperationBatchAdmissionError } from './supervisor-adapter.mjs'

test('operation batch preserves Factorio error and failing operation index without replay', async () => {
  let calls = 0
  const rcon = {
    async command(text) {
      calls++
      const marker = text.match(/SGLUNA_RESULT_[a-f0-9]{24}:/)?.[0]
      assert.ok(marker)
      return `${marker}${JSON.stringify({
        ok: false,
        result: 'autorio operation 2 failed: Lua deterministic failure',
      })}`
    },
  }

  await assert.rejects(
    () => executeAuthorizedBatch(rcon, 3, [
      "remote.call('autorio_operations','wait',60)",
      "remote.call('autorio_operations','wait',60)",
    ]),
    error => {
      assert.ok(error instanceof OperationBatchAdmissionError)
      assert.equal(error.operationIndex, 1)
      assert.equal(error.factorioError, 'autorio operation 2 failed: Lua deterministic failure')
      assert.equal(error.noReplay, true)
      assert.match(error.message, /not replayed because earlier operations may have produced side effects/)
      assert.match(error.message, /Lua deterministic failure/)
      return true
    },
  )
  assert.equal(calls, 1)
})
