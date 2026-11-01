import assert from 'node:assert/strict'
import net from 'node:net'
import test from 'node:test'

import { Rcon } from '../deploy/pterodactyl/runtime-v8/common.mjs'
import { createDesktopOperator } from './desktop-rcon-operator.mjs'

// Exercises the desktop operator over the real network path end to end: a
// real HTTP client, the real HTTP server from createDesktopOperator, a real
// Rcon TCP client (the same class the production supervisor uses), and a
// real TCP socket to a fake Source-RCON server. Only the Factorio game
// binary itself is faked; the unit tests in desktop-rcon-operator.test.mjs
// cover the HTTP/RCON contract in-process and remain useful for fast
// iteration, but this file is what proves the adapter works as wired.

function encodePacket(id, type, text) {
  const payload = Buffer.from(String(text), 'utf8')
  const packet = Buffer.alloc(payload.length + 14)
  packet.writeInt32LE(payload.length + 10, 0)
  packet.writeInt32LE(id, 4)
  packet.writeInt32LE(type, 8)
  payload.copy(packet, 12)
  packet.writeInt16LE(0, 12 + payload.length)
  return packet
}

async function fakeRconServer(password, respond) {
  const commands = []
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0)
        if (buffer.length < size + 4) return
        const packet = buffer.subarray(4, size + 4)
        buffer = buffer.subarray(size + 4)
        const id = packet.readInt32LE(0)
        const type = packet.readInt32LE(4)
        const text = packet.subarray(8, -2).toString('utf8')
        if (type === 3) {
          socket.write(encodePacket(text === password ? id : -1, 2, ''))
          continue
        }
        commands.push(text)
        socket.write(encodePacket(id, 0, respond(text)))
      }
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, commands, port: server.address().port }
}

test('desktop operator end to end over a real RCON TCP connection: unauthorized request, bounded observation, rejected preflight, admitted operation', async () => {
  const rconPassword = 'e2e-fixture-rcon-password'
  const token = 'e2e-fixture-operator-token'

  const { server: rconServer, commands, port } = await fakeRconServer(rconPassword, command => {
    if (command.includes('autorio_actor') && command.includes('status')) return '{"actor_id":7}'
    if (command.includes('autorio_preflight')) return command.includes('missing-item') ? '{"ok":false,"code":"missing_items"}' : '{"ok":true}'
    if (command.includes('autorio_operations')) return '{"accepted":true}'
    return '{}'
  })

  const rcon = new Rcon(port, rconPassword, 2000)
  await rcon.connect()
  const operator = createDesktopOperator({ rcon, token })
  await new Promise(resolve => operator.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${operator.address().port}`

  try {
    // 1. Unauthorized request: rejected before any RCON command is issued.
    const unauthorized = await fetch(`${base}/observe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'getActorStatus' }),
    })
    assert.equal(unauthorized.status, 401)
    assert.equal(commands.length, 0)

    // 2. Bounded observation: real round trip through RCON to the fake server.
    const observed = await fetch(`${base}/observe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'getActorStatus' }),
    })
    assert.equal(observed.status, 200)
    assert.deepEqual(await observed.json(), { ok: true, name: 'getActorStatus', output: { actor_id: 7 } })
    assert.equal(commands.length, 1)

    // An unapproved observation tool must never reach RCON at all.
    const unapproved = await fetch(`${base}/observe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'getMapTiles' }),
    })
    assert.equal(unapproved.status, 400)
    assert.equal(commands.length, 1)

    // 3. Rejected preflight: the mutating command must never be sent.
    const rejected = await fetch(`${base}/operate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'craft_item', args: { item_name: 'missing-item', count: 1 } }),
    })
    assert.equal(rejected.status, 409)
    const rejectedBody = await rejected.json()
    assert.equal(rejectedBody.ok, false)
    assert.equal(rejectedBody.code, 'preflight_rejected')
    assert.equal(commands.length, 2)
    assert.match(commands[1], /autorio_preflight/)

    // 4. Admitted operation: preflight passes, then the operation is sent.
    const admitted = await fetch(`${base}/operate`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }),
    })
    assert.equal(admitted.status, 202)
    const admittedBody = await admitted.json()
    assert.equal(admittedBody.ok, true)
    assert.deepEqual(admittedBody.admission, { accepted: true })
    assert.equal(commands.length, 4)
    assert.match(commands[2], /autorio_preflight/)
    assert.match(commands[3], /^\/c remote\.call\('autorio_operations','craft_item'/)
  }
  finally {
    await new Promise(resolve => operator.close(resolve))
    rcon.close()
    await new Promise(resolve => rconServer.close(resolve))
  }
})
