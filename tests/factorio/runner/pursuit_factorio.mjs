// Deterministic native integration lane. No provider credentials or inference.
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Rcon } from '../pterodactyl/runtime-v8/common.mjs'
import { configureNpcSession } from '../pterodactyl/runtime-v8/supervisor-adapter.mjs'
import { PursuitRuntime } from '../pterodactyl/runtime-v8/pursuit-runtime.mjs'

const arg = name => process.argv[process.argv.indexOf(`--${name}`) + 1]
const results = path.resolve(arg('results'))
const connection = new Rcon(Number(arg('port')), arg('password'), 15000, { host: arg('host') })
const commands = []
const calls = []
const rcon = { command: async (command, options) => {
  const response = await connection.command(command, options)
  commands.push({ command, response })
  return response
} }
const goal = minimum => ({ objective: `Hand-craft and hold ${minimum} iron gear wheels.`, predicate: {
  scope: 'finite', summary: `Hold ${minimum} iron gear wheels.`, doneWhen: [
    { kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum },
  ] } })

async function settle(agent) {
  const until = Date.now() + 90000
  while (agent.active && Date.now() < until) { await delay(500); await agent.pollPursuit() }
  assert.equal(agent.loop.state.status, 'completed', agent.loop.state.pauseReason)
}

try {
  await fsp.mkdir(results, { recursive: true })
  await connection.connect()
  await configureNpcSession(rcon, 'pursuit-engine-fixture-0001')
  // Declared fixture once. Native hand crafting consumes these four plates.
  const setup = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); game.speed=1; a.get_inventory(defines.inventory.character_main).clear(); local added=a.insert{name="iron-plate",count=4}; rcon.print(helpers.table_to_json({added=added,connected_players=#game.connected_players,speed=game.speed}))'))
  assert.equal(setup.added, 4)
  assert.equal(setup.connected_players, 0)
  assert.equal(setup.speed, 1)
  const options = { rcon, stateFile: path.join(results, 'pursuit-state.json'), traceFile: path.join(results, 'pursuit-trace.jsonl'),
    provider: async (messages, context) => {
      calls.push({ messages, controlProtocol: context.controlProtocol })
      assert.equal(context.controlProtocol, 'pursuit')
      return { content: JSON.stringify({ notes: 'Native hand crafting.', operations: [{ name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 1 } }] }) }
    } }
  const first = new PursuitRuntime(options)
  await first.request(JSON.stringify(goal(1)))
  await settle(first)
  assert.equal(first.loop.state.budget.calls, 1)
  const ordinal = first.loop.state.ordinal
  // Reload the on-disk campaign and dispatch a second goal against real global
  // native high-water state. Neither ordinal nor provider allowance can reset.
  const restarted = new PursuitRuntime(options)
  await restarted.request(JSON.stringify(goal(2)))
  await settle(restarted)
  assert.equal(restarted.loop.state.budget.calls, 2)
  assert.equal(restarted.loop.state.ordinal, ordinal + 1)
  assert.equal(calls.length, 2)
  const final = JSON.parse(await rcon.command('/silent-command local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; rcon.print(helpers.table_to_json({plates=a.get_item_count("iron-plate"),gears=a.get_item_count("iron-gear-wheel"),connected_players=#game.connected_players}))'))
  assert.equal(final.plates, 0)
  assert.equal(final.gears, 2)
  assert.equal(final.connected_players, 0)
  await fsp.writeFile(path.join(results, 'pursuit-evidence.json'), JSON.stringify({ setup, final, calls: calls.length,
    ordinal: restarted.loop.state.ordinal, state: restarted.loop.snapshot(), commands }, null, 2))
  console.log('PASS pursuit: native hand-craft receipts, zero humans, persistent campaign and cross-goal ordinals')
}
finally { connection.close() }
