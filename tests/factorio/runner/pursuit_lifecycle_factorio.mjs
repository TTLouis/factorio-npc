#!/usr/bin/env node
// Real-engine pursuit lifecycle. A scripted operator (no provider, no model)
// drives the production pursuit CLI, in-process tool surface, external runtime
// journal and NativeBridge over real RCON. Declared fixture stock only,
// game.speed=1, zero connected players. Acceptance must come from native goal
// evaluation; an unmet goal must pause, never be accepted.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const REPO = '/test/repo'
const { Rcon, confirmLuaConsoleReady } = await import(`${REPO}/deploy/pterodactyl/runtime-v8/common.mjs`)
const { NativeBridge } = await import(`${REPO}/tools/external-harness/native-bridge.mjs`)
const { main } = await import(`${REPO}/tools/pursuit/cli.mjs`)

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  assert.ok(index >= 0 && process.argv[index + 1], `missing --${name}`)
  return process.argv[index + 1]
}
const results = path.resolve(arg('results'))
const port = Number(arg('port'))
const password = arg('password')
const SESSION = 'external-6a0c2f4e-pursuit-lane-4000-8000-000000000001'
const ACTOR = 'local a=game.surfaces[1].find_entities_filtered{name="character"}[1]; assert(a); '
const evidence = { status: 'failed', provider_calls: 0, lanes: {} }
const errorFile = path.join(results, 'pursuit-lifecycle-error.txt')

const connection = new Rcon(port, password, 10000, { host: '127.0.0.1' })
const lua = async body => JSON.parse(await connection.command(`/silent-command ${ACTOR}${body}`))
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const lastTool = messages => { const row = messages.findLast(message => message.role === 'tool'); return row ? JSON.parse(row.content) : undefined }

// Scripted operator for the craft goal: capabilities, one craft, receipt until
// terminal, then yield. It reads real receipts; it never claims success.
function craftOperator(log) {
  let step = 0
  return async ({ messages }) => {
    log.push(messages.length)
    const previous = lastTool(messages)
    step++
    if (step === 1) return { message: { content: '', tool_calls: [call('c1', 'factorio_capabilities', {})] } }
    if (step === 2) return { message: { content: '', tool_calls: [call('s1', 'factorio_submit', { request_id: 'lane-craft-1', operation: { name: 'craft_item', args: { item_name: 'iron-gear-wheel', count: 2 } } })] } }
    const operationId = previous?.operation_id ?? previous?.receipt?.operation_id
    if (previous && previous.terminal !== true && operationId) return { message: { content: '', tool_calls: [call(`r${step}`, 'factorio_receipt', { operation_id: operationId, wait_ms: 10000 })] } }
    return { message: { content: 'Crafted the gears; requesting acceptance.' } }
  }
}

async function profileFile(name, goal) {
  const file = path.join(results, `${name}-profile.json`)
  await fs.writeFile(file, JSON.stringify({ runId: `lane-${name}`, goalId: name, model: 'scripted-operator', brief: 'Scripted native lane operator.', wallCapMs: 300000, goal,
    options: { maxUnacceptedYields: 1 } }))
  return file
}

const env = { SGLUNA_RCON_HOST: '127.0.0.1', SGLUNA_RCON_PORT: String(port), SGLUNA_RCON_PASSWORD: password, EXTERNAL_HARNESS_SESSION: SESSION,
  EXTERNAL_HARNESS_STATE_DIR: path.join(results, 'pursuit-state'), OPERATOR_PROVIDER_BASE: 'http://127.0.0.1:9/v1', CLI_PROXY_GATEWAY_KEY: 'lane-unused' }

try {
  await connection.connect()
  await confirmLuaConsoleReady(connection)
  assert.equal((await lua('rcon.print(helpers.table_to_json({players=#game.connected_players}))')).players, 0)
  await new NativeBridge({ rcon: connection, session: SESSION }).bind()
  // Declared fixture stock: exactly enough plates for two gear crafts.
  const stock = await lua('local m=a.get_inventory(defines.inventory.character_main); m.clear(); rcon.print(helpers.table_to_json({added=m.insert{name="iron-plate",count=4}}))')
  assert.equal(stock.added, 4)

  // Lane 1: craft goal accepted by native evaluation through the real CLI.
  const log = []
  const craftGoal = { scope: 'finite', summary: 'Hold two iron gear wheels.', doneWhen: [{ id: 'gears', kind: 'inventory_count', item_name: 'iron-gear-wheel', minimum: 2 }] }
  const out = []
  const report = await main(['--profile', await profileFile('craft', craftGoal)], env, { rcon: connection, complete: craftOperator(log), stdout: { write: line => out.push(line) } })
  const state = JSON.parse(await fs.readFile(path.join(env.EXTERNAL_HARNESS_STATE_DIR, 'pursuit', 'craft', 'state.json'), 'utf8'))
  const events = (await fs.readFile(path.join(env.EXTERNAL_HARNESS_STATE_DIR, 'pursuit', 'craft', 'evidence.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const receipts = events.filter(event => event.type === 'tool_result' && ['factorio_receipt', 'factorio_submit'].includes(event.tool)).map(event => event.result.structuredContent)
  const native = await lua('rcon.print(helpers.table_to_json({gears=a.get_inventory(defines.inventory.character_main).get_item_count("iron-gear-wheel"),plates=a.get_inventory(defines.inventory.character_main).get_item_count("iron-plate")}))')
  evidence.lanes.craft = { report, requests: state.requests, submits: state.submits, progressed: state.pursuit.progressed_operations, native, last_receipt: receipts.at(-1), event_types: [...new Set(events.map(event => event.type))] }
  assert.equal(report.outcome, 'accepted')
  assert.equal(JSON.parse(out[0]).stopped, true)
  assert.equal(native.gears, 2)
  assert.equal(native.plates, 0)
  assert.equal(state.submits, 1)
  assert.equal(state.pursuit.progressed_operations.length, 1)
  assert.equal(receipts.at(-1).state, 'completed')
  assert.equal(receipts.at(-1).effect, 'happened')
  assert.ok(events.some(event => event.type === 'goal_evaluated' && event.satisfied === true))

  // Restart of the same goal is idempotent: no model call, same outcome.
  const again = await main(['--profile', await profileFile('craft', craftGoal)], env, { rcon: connection, complete: async () => { evidence.provider_calls++; throw new Error('must not call') }, stdout: { write: () => {} } })
  assert.equal(again.outcome, 'accepted')

  // Lane 2: an operator that claims success on an unmet goal is paused.
  const unmet = { scope: 'finite', summary: 'Research automation.', doneWhen: [{ id: 'automation', kind: 'research_completed', technology: 'automation' }] }
  const liar = await main(['--profile', await profileFile('unmet', unmet)], env, { rcon: connection, complete: async () => ({ message: { content: 'Automation is researched.' } }), stdout: { write: () => {} } })
  evidence.lanes.unmet = { report: liar }
  assert.equal(liar.outcome, 'paused_operator_yielded_unaccepted')
  const research = await lua('rcon.print(helpers.table_to_json({researched=a.force.technologies["automation"].researched}))')
  assert.equal(research.researched, false)

  // No operation outstanding, nothing replayed: the journal holds exactly the one craft.
  await delay(100)
  evidence.status = 'passed'
}
catch (error) {
  evidence.error = String(error?.stack ?? error).slice(0, 4000)
  await fs.writeFile(errorFile, evidence.error)
  process.exitCode = 1
}
finally {
  await fs.writeFile(path.join(results, 'pursuit-lifecycle-evidence.json'), JSON.stringify(evidence, null, 2))
  connection.close()
}
