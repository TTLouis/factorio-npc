import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import test from 'node:test'

import { Rcon, withTimeout } from './common.mjs'

function packet(id, type, text) {
  const payload = Buffer.from(String(text), 'utf8')
  const result = Buffer.alloc(payload.length + 14)
  result.writeInt32LE(payload.length + 10, 0)
  result.writeInt32LE(id, 4)
  result.writeInt32LE(type, 8)
  payload.copy(result, 12)
  result.writeInt16LE(0, 12 + payload.length)
  return result
}

test('Task Board commands use a dedicated RCON connection and bypass a blocked primary queue', async t => {
  let connectionCount = 0
  let releasePrimary
  let markPrimarySeen
  const primarySeen = new Promise(resolve => { markPrimarySeen = resolve })

  const server = net.createServer((socket) => {
    connectionCount++
    let buffer = Buffer.alloc(0)
    let authenticated = false
    let uiLuaPrimed = false

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      while (buffer.length >= 4) {
        const size = buffer.readInt32LE(0)
        if (buffer.length < size + 4) return
        const message = buffer.subarray(4, size + 4)
        buffer = buffer.subarray(size + 4)
        const id = message.readInt32LE(0)
        const type = message.readInt32LE(4)
        const text = message.subarray(8, -2).toString('utf8')

        if (type === 3) {
          authenticated = text === 'test-password'
          socket.write(packet(authenticated ? id : -1, 2, ''))
          continue
        }
        if (!authenticated) {
          socket.destroy()
          return
        }

        if (text === 'slow-primary') {
          markPrimarySeen()
          releasePrimary = () => socket.write(packet(id, 0, 'slow-ok'))
          continue
        }

        if (text.includes('SGLUNA_UI_RCON_READY')) {
          if (!uiLuaPrimed) {
            uiLuaPrimed = true
            socket.write(packet(id, 0, 'Please repeat the command to proceed.'))
          }
          else {
            socket.write(packet(id, 0, 'SGLUNA_UI_RCON_READY'))
          }
          continue
        }

        if (text.includes('autorio_task_board')) {
          socket.write(packet(id, 0, 'ui-ok'))
          continue
        }

        socket.write(packet(id, 0, 'ok'))
      }
    })
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.equal(typeof address, 'object')
  t.after(() => server.close())

  const rcon = new Rcon(address.port, 'test-password', 1000)
  await rcon.connect()
  t.after(() => rcon.close())

  const primary = rcon.command('slow-primary')
  await withTimeout(primarySeen, 500, 'primary command was not observed')

  const ui = rcon.command('/silent-command rcon.print(tostring(remote.call("autorio_task_board","clear")))')
  assert.equal(await withTimeout(ui, 500, 'Task Board RCON was blocked behind primary queue'), 'ui-ok')
  assert.equal(connectionCount, 2)

  releasePrimary()
  assert.equal(await primary, 'slow-ok')
})
