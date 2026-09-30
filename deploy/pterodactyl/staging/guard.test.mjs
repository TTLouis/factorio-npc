import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const here = path.dirname(fileURLToPath(import.meta.url))

async function fixture() {
  const source = await fs.readFile(path.join(here, 'guard.ts'), 'utf8')
  const storage = {}
  let actor = {
    mode: 'npc',
    connected_players: 0,
    actor: {
      actor_id: 18,
      kind: 'standalone_character',
      valid: true,
      has_character: true,
      name: 'Aster-1',
      npc_id: 'npc-1',
    },
  }
  let tasks = { task_state: 'idle', queue_empty: true, queue_length: 0 }
  let cancelCount = 0
  const interfaces = {
    autorio_actor: {},
    autorio_operations: {},
    autorio_tools: {},
  }
  const calls = {}
  const remote = {
    interfaces,
    add_interface(name, handlers) {
      interfaces[name] = handlers
      calls[name] = handlers
    },
    call(name, method, ...args) {
      if (name === 'autorio_actor' && method === 'status') return actor
      if (name === 'autorio_actor' && method === 'set_mode') {
        const mode = args[0]
        actor = {
          ...actor,
          mode,
          actor: {
            ...actor.actor,
            kind: mode === 'npc' ? 'standalone_character' : 'connected_player',
          },
        }
        return [true, actor.actor]
      }
      if (name === 'autorio_operations' && method === 'status') return tasks
      if (name === 'autorio_operations' && method === 'cancel_all_tasks') {
        cancelCount++
        tasks = { task_state: 'idle', queue_empty: true, queue_length: 0 }
        return true
      }
      throw new Error(`unexpected remote call: ${name}.${method}`)
    },
  }

  const context = { storage, remote, log: () => {}, helpers: { table_to_json: value => JSON.stringify(value) } }
  vm.createContext(context)
  const js = stripTypeScriptTypes(source, { mode: 'strip' })
    .replaceAll('export function', 'function')
    .replaceAll('export class', 'class')
  vm.runInContext(js, context)

  return {
    storage,
    remote,
    calls,
    get actor() { return actor },
    setActor(value) { actor = value },
    get tasks() { return tasks },
    setTasks(value) { tasks = value },
    get cancelCount() { return cancelCount },
  }
}

test('npc configure succeeds with zero connected players and captures physical plus logical NPC identity', async () => {
  const f = await fixture()
  assert.equal(f.calls.sgluna_deployment.configure('npc', 'session-1'), 'session-1')
  const status = f.calls.sgluna_deployment.status()
  assert.equal(status.allowed, true)
  assert.equal(status.mode, 'npc')
  assert.equal(status.actor_id, 18)
  assert.equal(status.actor_kind, 'standalone_character')
  assert.equal(status.actor_name, 'Aster-1')
  assert.equal(status.npc_id, 'npc-1')
  assert.equal(status.connected_players, 0)
  assert.equal(status.idle, true)
  assert.equal(status.actor_interface, true)
})

test('human join count does not change NPC authorization', async () => {
  const f = await fixture()
  f.calls.sgluna_deployment.configure('npc', 'session-1')
  f.setActor({ ...f.actor, connected_players: 4 })
  assert.equal(f.calls.sgluna_deployment.status().allowed, true)
})

test('replacement NPC invalidates the physical authorization epoch while preserving logical identity', async () => {
  const f = await fixture()
  f.calls.sgluna_deployment.configure('npc', 'session-1')
  const epoch = f.calls.sgluna_deployment.status().epoch
  assert.equal(f.calls.sgluna_deployment.authorize(epoch), true)

  f.setActor({
    ...f.actor,
    actor: { ...f.actor.actor, actor_id: 42 },
  })
  assert.equal(f.calls.sgluna_deployment.authorize(epoch), false)
  const stale = f.calls.sgluna_deployment.status()
  assert.equal(stale.allowed, false)
  assert.equal(stale.actor_name, 'Aster-1')
  assert.equal(stale.npc_id, 'npc-1')

  assert.equal(f.calls.sgluna_deployment.configure('npc', 'session-1'), 'session-1')
  const refreshed = f.calls.sgluna_deployment.status()
  assert.equal(refreshed.actor_id, 42)
  assert.equal(refreshed.actor_name, 'Aster-1')
  assert.equal(refreshed.npc_id, 'npc-1')
  assert.equal(refreshed.allowed, true)
  assert.ok(refreshed.epoch > epoch)
})

test('mode or actor-kind changes fail closed', async () => {
  const f = await fixture()
  f.calls.sgluna_deployment.configure('npc', 'session-1')
  const epoch = f.calls.sgluna_deployment.status().epoch

  f.setActor({ ...f.actor, mode: 'player' })
  assert.equal(f.calls.sgluna_deployment.authorize(epoch), false)

  f.setActor({
    ...f.actor,
    mode: 'npc',
    actor: { ...f.actor.actor, kind: 'connected_player' },
  })
  assert.equal(f.calls.sgluna_deployment.authorize(epoch), false)
})

test('invalid or missing character fails closed', async () => {
  const f = await fixture()
  f.calls.sgluna_deployment.configure('npc', 'session-1')
  const epoch = f.calls.sgluna_deployment.status().epoch
  f.setActor({ ...f.actor, actor: { ...f.actor.actor, valid: false } })
  assert.equal(f.calls.sgluna_deployment.authorize(epoch), false)
})

test('configure rejects invalid mode or empty session', async () => {
  const f = await fixture()
  assert.equal(f.calls.sgluna_deployment.configure('swarm', 'session-1'), false)
  assert.equal(f.calls.sgluna_deployment.configure('npc', ''), false)
})

test('cancel and disable clear owned task state without depending on human controls', async () => {
  const f = await fixture()
  f.calls.sgluna_deployment.configure('npc', 'session-1')
  const first = f.calls.sgluna_deployment.status().epoch
  f.setTasks({ task_state: 'waiting', queue_empty: false, queue_length: 1 })
  f.calls.sgluna_deployment.cancel()
  assert.equal(f.cancelCount >= 2, true)
  assert.equal(f.calls.sgluna_deployment.status().idle, true)
  assert.ok(f.calls.sgluna_deployment.status().epoch > first)

  f.calls.sgluna_deployment.disable()
  assert.equal(f.calls.sgluna_deployment.status().allowed, false)
  assert.equal(f.calls.sgluna_deployment.status().session, '')
})

test('player mode remains possible but requires a connected-player actor snapshot', async () => {
  const f = await fixture()
  f.setActor({
    mode: 'player',
    connected_players: 1,
    actor: {
      actor_id: 7,
      kind: 'connected_player',
      valid: true,
      has_character: true,
      name: 'Louis',
    },
  })
  assert.equal(f.calls.sgluna_deployment.configure('player', 'session-1'), 'session-1')
  assert.equal(f.calls.sgluna_deployment.status().allowed, true)
})
