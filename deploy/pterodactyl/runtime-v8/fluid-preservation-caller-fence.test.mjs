import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

// Execute the real loop and real fluid helper in an isolated process. The load
// hook inserts only a microtask at the helper's successful return, after all of
// its inner fences. This tests the caller's await seam without a production hook.
const directory = new URL('./', import.meta.url)
const source = fs.readFileSync(new URL('./fluid-preservation-lifecycle.test.mjs', import.meta.url), 'utf8')
const fixture = source.slice(0, source.indexOf("test('real prepared ledger"))
  .replaceAll("from './", `from '${directory.href}`)
for (const change of ['cancel', 'amendment', 'new_intake', 'control_missing_caller_fence']) {
  test(change === 'control_missing_caller_fence' ? 'negative control: missing final caller fence admits native placement after helper-return supersession' : `actual fluid-helper return seam refuses late ${change} before transport`, () => {
    const hook = String.raw`
import { registerHooks } from 'node:module'
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  const source = String(result.source)
  if (url.endsWith('/runtime-v8/npc-agent-loop.mjs') && ${JSON.stringify(change)} === 'control_missing_caller_fence') {
    const needle = '        assertSendOwner(pendingAdmission)\n      }\n      catch (error)'
    if (!source.includes(needle)) throw Error('Exact caller return fence not found')
    return { ...result, source: source.replace(needle, '      }\n      catch (error)') }
  }
  if (!url.endsWith('/contract-obligation-runtime.mjs')) return result
  const needle = '  return envelope\n}'
  if (!source.includes(needle)) throw Error('Exact helper return seam not found')
  return { ...result, source: source.replace(needle, '  queueMicrotask(() => globalThis.injectBeforeSend(agent))\n  return envelope\n}') }
}})
`
    const driver = String.raw`
${fixture}
const w = world()
let injected = 0
let replacement
let amendment
let oldRequest
let before
const change = ${JSON.stringify(change)}
globalThis.injectBeforeSend = agent => {
  injected++
  oldRequest = agent.traceRequest?.id
  before = structuredClone(w.memory.planningState(KEY))
  if (change === 'cancel') agent.cancel('user_stop_immediate')
  if (change === 'amendment') agent.pendingInteractionAmendment = { text: 'newer instruction', source: 'user' }
  if (change === 'new_intake' || change === 'control_missing_caller_fence') {
    agent.requestAdmissionOwner = { replacement: true }
    agent.traceRequest = { id: 'new_pre_base_intake', seq: 0 }
  }
  replacement = agent.traceRequest
  amendment = agent.pendingInteractionAmendment
}
await assert.rejects(w.start(), /cancelled|superseded|stale/i)
assert.equal(injected, 1)
if (change === 'control_missing_caller_fence') {
  assert.equal(w.game.mutations.length, 1, 'negative control must reach native transport after the injected stop boundary')
} else {
assert.equal(w.game.mutations.length, 0)
assert.equal(w.agent.traceRequest, replacement)
assert.equal(w.agent.pendingInteractionAmendment, amendment)
if (change === 'new_intake') assert.equal(replacement.seq, 0)
assert.equal(w.memory.pendingOperations(KEY).length, 0)
assert.ok(w.rows.some(row => row.event === 'operation.not_sent' && row.request_id === oldRequest && row.actor_id === 10 && row.epoch === 3))
const after = w.memory.planningState(KEY)
assert.deepEqual(after.goal, before.goal)
assert.deepEqual(after.plans, before.plans)
}
console.log(JSON.stringify({ seam: change, injected, native_sends: w.game.mutations.length, old_request: oldRequest, pending: 0 }))
`
    const result = spawnSync(process.execPath, ['--import', `data:text/javascript;base64,${Buffer.from(hook).toString('base64')}`, '--input-type=module', '-e', driver], { encoding: 'utf8', timeout: 20000 })
    assert.equal(result.status, 0, result.stderr + result.stdout)
  })
}
