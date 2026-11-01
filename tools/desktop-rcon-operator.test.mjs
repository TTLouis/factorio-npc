import assert from 'node:assert/strict'
import test from 'node:test'

import { createDesktopOperator } from './desktop-rcon-operator.mjs'

const token = 'test-token-that-is-long-enough'

async function withOperator(rcon, run) {
  const server = createDesktopOperator({ rcon, token })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const { port } = server.address()
    await run(`http://127.0.0.1:${port}`)
  }
  finally { await new Promise(resolve => server.close(resolve)) }
}

test('health is public and observations remain bounded', async () => {
  const commands = []
  await withOperator({ command: async command => { commands.push(command); return '{"actor_id":1}' } }, async base => {
    const health = await fetch(`${base}/health`)
    assert.deepEqual(await health.json(), { ok: true, service: 'desktop-rcon-operator' })
    const observation = await fetch(`${base}/observe`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'getActorStatus' }) })
    assert.deepEqual(await observation.json(), { ok: true, name: 'getActorStatus', output: { actor_id: 1 } })
  })
  assert.match(commands[0], /autorio_actor.*status/)
})

test('operations run deterministic preflight before bounded admission', async () => {
  const commands = []
  await withOperator({ command: async command => { commands.push(command); return command.includes('autorio_preflight') ? '{"ok":true}' : '{"accepted":true}' } }, async base => {
    const response = await fetch(`${base}/operate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }) })
    assert.equal(response.status, 202)
    assert.equal((await response.json()).admission.accepted, true)
  })
  assert.match(commands[0], /autorio_preflight/)
  assert.match(commands[1], /^\/c remote\.call\('autorio_operations','craft_item'/)
})

test('unapproved observations and rejected preflight cannot mutate', async () => {
  const commands = []
  await withOperator({ command: async command => { commands.push(command); return '{"ok":false,"code":"missing_items"}' } }, async base => {
    const unapproved = await fetch(`${base}/observe`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'getMapTiles' }) })
    assert.equal(unapproved.status, 400)
    const rejected = await fetch(`${base}/operate`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }) })
    assert.equal(rejected.status, 409)
  })
  assert.equal(commands.length, 1)
  assert.match(commands[0], /autorio_preflight/)
})
